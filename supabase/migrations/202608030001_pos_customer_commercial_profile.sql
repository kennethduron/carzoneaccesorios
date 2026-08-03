-- POS Phase 1 completion: atomic commercial customer setup.
-- Schema and functions only. This migration never creates or changes a customer,
-- credit account, order, invoice, payment, receivable, or inventory row.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- The original POS identity contracts remain authoritative. Phone is now truly
-- optional; supplied identifiers are still normalized, validated, locked and
-- checked for exact duplicates.
create or replace function public.create_pos_customer_v1(
  p_request_key uuid,
  p_contact_name text,
  p_phone text,
  p_email text default null,
  p_business_name text default null,
  p_tax_id text default null,
  p_address text default null,
  p_city text default null,
  p_commercial_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  normalized_name text := nullif(trim(regexp_replace(coalesce(p_contact_name, ''), '\s+', ' ', 'g')), '');
  normalized_business text := nullif(trim(regexp_replace(coalesce(p_business_name, ''), '\s+', ' ', 'g')), '');
  normalized_email text := public.normalize_pos_customer_email_v1(p_email);
  normalized_phone text := public.normalize_pos_customer_phone_v1(p_phone);
  normalized_tax text := public.normalize_pos_customer_tax_id_v1(p_tax_id);
  normalized_address text := nullif(trim(regexp_replace(coalesce(p_address, ''), '\s+', ' ', 'g')), '');
  normalized_city text := nullif(trim(regexp_replace(coalesce(p_city, ''), '\s+', ' ', 'g')), '');
  normalized_notes text := nullif(trim(regexp_replace(coalesce(p_commercial_notes, ''), '\s+', ' ', 'g')), '');
  payload jsonb;
  payload_hash text;
  claim_record record;
  duplicate_id uuid;
  possible_duplicate_id uuid;
  created_customer public.customers%rowtype;
  safe_result jsonb;
  lock_key text;
begin
  if not public.pos_permission_allowed('pos:access')
    or not public.pos_permission_allowed('pos:customers:create') then
    raise exception using errcode = '42501', message = 'CUSTOMER_COMMERCIAL_UPDATE_DENIED';
  end if;
  if p_request_key is null or p_request_key = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'CUSTOMER_CREATE_FAILED';
  end if;
  if normalized_name is null or char_length(normalized_name) > 160 then
    raise exception using errcode = '22023', message = 'CUSTOMER_NAME_REQUIRED';
  end if;
  if nullif(trim(coalesce(p_phone, '')), '') is not null
    and (normalized_phone is null or char_length(regexp_replace(normalized_phone, '[^0-9]', '', 'g')) not between 8 and 20) then
    raise exception using errcode = '22023', message = 'CUSTOMER_PHONE_INVALID';
  end if;
  if nullif(trim(coalesce(p_email, '')), '') is not null
    and (normalized_email is null or char_length(normalized_email) > 254 or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception using errcode = '22023', message = 'CUSTOMER_EMAIL_INVALID';
  end if;
  if nullif(trim(coalesce(p_tax_id, '')), '') is not null
    and (normalized_tax is null or normalized_tax !~ '^[0-9]{14}$') then
    raise exception using errcode = '22023', message = 'CUSTOMER_RTN_INVALID';
  end if;
  if normalized_notes is not null and char_length(normalized_notes) > 1000 then
    raise exception using errcode = '22023', message = 'CUSTOMER_CREATE_FAILED';
  end if;

  payload := jsonb_build_object(
    'contact_name', normalized_name, 'phone', normalized_phone, 'email', normalized_email,
    'business_name', normalized_business, 'tax_id', normalized_tax, 'address', normalized_address,
    'city', normalized_city, 'commercial_notes', normalized_notes
  );
  payload_hash := encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex');
  select * into claim_record
  from public.claim_pos_idempotency_v1(p_request_key, 'create_pos_customer_v1', payload_hash);
  if claim_record.request_status = 'succeeded' then
    return claim_record.stored_result || jsonb_build_object('idempotentReplay', true);
  elsif not claim_record.acquired then
    raise exception using errcode = '55000', message = 'CUSTOMER_CREATE_IN_PROGRESS';
  end if;

  for lock_key in
    select value from unnest(array_remove(array[
      case when normalized_email is not null then 'email:' || normalized_email end,
      case when normalized_phone is not null then 'phone:' || normalized_phone end,
      case when normalized_tax is not null then 'tax:' || normalized_tax end
    ], null)) value order by value
  loop
    perform pg_advisory_xact_lock(hashtextextended('pos-customer:' || lock_key, 0));
  end loop;

  duplicate_id := public.find_pos_customer_duplicate_v1(normalized_email, normalized_phone, normalized_tax, null);
  if duplicate_id is null then
    select customer.id into possible_duplicate_id
    from public.customers customer
    where public.normalize_pos_customer_text_v1(customer.contact_name) = public.normalize_pos_customer_text_v1(normalized_name)
      and customer.active
    order by customer.created_at, customer.id
    limit 1;
  end if;
  duplicate_id := coalesce(duplicate_id, possible_duplicate_id);
  if duplicate_id is not null then
    safe_result := jsonb_build_object(
      'ok', false, 'status', case when possible_duplicate_id is null then 'duplicate' else 'possible_duplicate' end,
      'message', case when possible_duplicate_id is null
        then 'Ya existe un cliente con el mismo correo, telefono o RTN.'
        else 'Existe un cliente activo con el mismo nombre. Revisa y selecciona el perfil existente.' end,
      'customerId', duplicate_id,
      'commercialVersion', (select commercial_version from public.customers where id = duplicate_id),
      'idempotentReplay', false
    );
    perform public.write_audit_log(
      'customers', duplicate_id, 'pos.customer.duplicate_blocked', null,
      jsonb_build_object(
        'request_key', p_request_key,
        'match_type', case when possible_duplicate_id is null then 'exact_identifier' else 'exact_normalized_name' end,
        'email_hash', case when normalized_email is null then null else encode(extensions.digest(convert_to(normalized_email, 'UTF8'), 'sha256'), 'hex') end,
        'phone_last4', case when normalized_phone is null then null else right(normalized_phone, 4) end,
        'tax_hash', case when normalized_tax is null then null else encode(extensions.digest(convert_to(normalized_tax, 'UTF8'), 'sha256'), 'hex') end
      )
    );
    perform public.complete_pos_idempotency_v1(p_request_key, 'create_pos_customer_v1', payload_hash, safe_result);
    return safe_result;
  end if;

  insert into public.customers (
    contact_name, phone, email, business_name, company_name, tax_id, address, city,
    commercial_notes, is_wholesale, wholesale_status, active, status, lead_status, source
  ) values (
    normalized_name, normalized_phone, normalized_email, normalized_business, normalized_business,
    normalized_tax, normalized_address, normalized_city, normalized_notes,
    false, 'none', true, 'active', 'cliente', 'pos'
  ) returning * into created_customer;

  safe_result := jsonb_build_object(
    'ok', true, 'status', 'created', 'message', 'Cliente creado correctamente.',
    'customerId', created_customer.id, 'commercialVersion', created_customer.commercial_version,
    'idempotentReplay', false
  );
  perform public.write_audit_log(
    'customers', created_customer.id, 'pos.customer.created', null,
    jsonb_build_object(
      'customer_id', created_customer.id, 'request_key', p_request_key,
      'has_email', normalized_email is not null,
      'phone_last4', case when normalized_phone is null then null else right(normalized_phone, 4) end,
      'has_tax_id', normalized_tax is not null, 'wholesale_status', created_customer.wholesale_status,
      'credit_enabled', false, 'portal_linked', false,
      'incomplete_contact_warning', normalized_phone is null and normalized_email is null and normalized_tax is null
    )
  );
  perform public.complete_pos_idempotency_v1(p_request_key, 'create_pos_customer_v1', payload_hash, safe_result);
  return safe_result;
end;
$$;

alter table public.wholesale_access_history
  drop constraint if exists wholesale_access_history_operation_check;
alter table public.wholesale_access_history
  add constraint wholesale_access_history_operation_check
  check (operation in ('approve_request', 'direct_grant', 'change_type', 'reject', 'suspend', 'reactivate', 'return_to_retail')) not valid;
alter table public.wholesale_access_history
  validate constraint wholesale_access_history_operation_check;

create or replace function public.return_customer_to_retail_v1(
  p_request_key uuid,
  p_customer_id uuid,
  p_expected_commercial_version integer,
  p_expected_wholesale_status text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  customer_record public.customers%rowtype;
  saved_customer public.customers%rowtype;
  idem public.wholesale_idempotency_requests%rowtype;
  payload_hash text;
  history_id uuid;
  minimum_amount numeric(12,2);
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
  response_payload jsonb;
begin
  if actor_id is null
    or actor_role_name not in ('technical_owner', 'business_owner', 'admin')
    or not public.has_permission('wholesale:manage') then
    raise exception using errcode = '42501', message = 'WHOLESALE_UPDATE_DENIED';
  end if;
  if p_request_key is null or p_customer_id is null
    or p_expected_commercial_version is null
    or p_expected_wholesale_status not in ('pending', 'approved', 'rejected', 'suspended') then
    raise exception using errcode = '22023', message = 'WHOLESALE_CONFIGURATION_INVALID';
  end if;
  if normalized_reason is null or char_length(normalized_reason) not between 5 and 500 then
    raise exception using errcode = '22023', message = 'WHOLESALE_REASON_REQUIRED';
  end if;

  payload_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'customer_id', p_customer_id,
    'expected_commercial_version', p_expected_commercial_version,
    'expected_wholesale_status', p_expected_wholesale_status,
    'reason', normalized_reason
  )::text, 'UTF8'), 'sha256'), 'hex');

  insert into public.wholesale_idempotency_requests (
    actor_user_id, operation, request_key, payload_hash, customer_id
  ) values (
    actor_id, 'return_customer_to_retail_v1', p_request_key, payload_hash, p_customer_id
  ) on conflict (request_key) do nothing;

  select * into idem from public.wholesale_idempotency_requests
  where request_key = p_request_key for update;
  if idem.actor_user_id <> actor_id
    or idem.payload_hash <> payload_hash
    or idem.operation <> 'return_customer_to_retail_v1' then
    raise exception using errcode = 'PT409', message = 'WHOLESALE_IDEMPOTENCY_CONFLICT';
  end if;
  if idem.status = 'succeeded' then
    return idem.result || jsonb_build_object('idempotentReplay', true);
  end if;

  select * into customer_record from public.customers
  where id = p_customer_id for update;
  if customer_record.id is null then
    raise exception using errcode = 'P0002', message = 'CUSTOMER_NOT_FOUND';
  end if;
  if customer_record.commercial_version <> p_expected_commercial_version
    or customer_record.wholesale_status <> p_expected_wholesale_status then
    raise exception using errcode = 'PT409',
      message = 'WHOLESALE_VERSION_CONFLICT:' || customer_record.commercial_version::text;
  end if;

  select round(coalesce(settings.first_wholesale_minimum, 10000), 2)
  into minimum_amount from public.company_settings settings
  order by settings.created_at limit 1;
  minimum_amount := greatest(coalesce(minimum_amount, 10000), 0);
  perform set_config('app.wholesale_system_update', 'on', true);

  update public.customers
  set is_wholesale = false,
      wholesale_status = 'none',
      wholesale_approved_at = null,
      wholesale_approved_notice_seen = true,
      updated_at = now()
  where id = p_customer_id and commercial_version = p_expected_commercial_version
  returning * into saved_customer;
  if saved_customer.id is null
    or saved_customer.commercial_version <> customer_record.commercial_version + 1 then
    raise exception using errcode = 'PT409', message = 'WHOLESALE_VERSION_CONFLICT';
  end if;

  insert into public.wholesale_access_history (
    customer_id, operation, source, previous_status, new_status,
    previous_type, new_type, had_pending_request, requested_at, approved_at,
    actor_user_id, actor_role, reason, previous_commercial_version,
    new_commercial_version, first_purchase_required, first_purchase_minimum,
    request_key, payload_hash, metadata
  ) values (
    saved_customer.id, 'return_to_retail', 'admin_direct_grant',
    customer_record.wholesale_status, 'none',
    customer_record.wholesale_customer_type, saved_customer.wholesale_customer_type,
    customer_record.wholesale_status = 'pending', customer_record.wholesale_requested_at, null,
    actor_id, actor_role_name, normalized_reason, customer_record.commercial_version,
    saved_customer.commercial_version, false, minimum_amount,
    p_request_key, payload_hash,
    jsonb_build_object('permission', 'wholesale:manage', 'source', 'pos_commercial_profile')
  ) returning id into history_id;

  insert into public.crm_notes (customer_id, user_id, note_type, note)
  values (saved_customer.id, actor_id, 'wholesale_status', 'Clasificacion comercial cambiada a cliente minorista desde Punto de Venta.');

  insert into public.audit_logs (table_name, record_id, action, user_id, old_data, new_data)
  values (
    'customers', saved_customer.id, 'wholesale_access.return_to_retail', actor_id,
    jsonb_build_object(
      'wholesale_status', customer_record.wholesale_status,
      'is_wholesale', customer_record.is_wholesale,
      'commercial_version', customer_record.commercial_version
    ),
    jsonb_build_object(
      'wholesale_status', 'none', 'is_wholesale', false,
      'commercial_version', saved_customer.commercial_version,
      'history_id', history_id, 'request_key', p_request_key,
      'permission', 'wholesale:manage'
    )
  );

  response_payload := jsonb_build_object(
    'ok', true, 'code', 'OK', 'customerId', saved_customer.id,
    'wholesaleStatus', 'none', 'commercialVersion', saved_customer.commercial_version,
    'historyId', history_id, 'idempotentReplay', false
  );
  update public.wholesale_idempotency_requests
  set status = 'succeeded', result = response_payload,
      completed_at = now(), updated_at = now()
  where id = idem.id;
  return response_payload;
end;
$$;

revoke all on function public.return_customer_to_retail_v1(uuid, uuid, integer, text, text)
  from public, anon;
grant execute on function public.return_customer_to_retail_v1(uuid, uuid, integer, text, text)
  to authenticated;

create or replace function public.get_pos_customer_credit_configuration_v1(
  target_customer_id uuid
)
returns table (
  account_exists boolean,
  terms_days integer,
  credit_notes text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.pos_permission_allowed('customers:read_credit') then
    raise exception using errcode = '42501', message = 'CREDIT_UPDATE_DENIED';
  end if;
  if not exists (select 1 from public.customers where id = target_customer_id) then
    raise exception using errcode = 'P0002', message = 'CUSTOMER_NOT_FOUND';
  end if;
  return query
  select
    account.id is not null,
    coalesce(account.terms_days, 30),
    account.notes
  from (select target_customer_id as customer_id) requested
  left join public.customer_credit_accounts account
    on account.customer_id = requested.customer_id;
end;
$$;

revoke all on function public.get_pos_customer_credit_configuration_v1(uuid)
  from public, anon;
grant execute on function public.get_pos_customer_credit_configuration_v1(uuid)
  to authenticated;

create or replace function public.pos_child_request_key_v1(
  parent_request_key uuid,
  operation_label text
)
returns uuid
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select (
    substr(md5(parent_request_key::text || ':' || operation_label), 1, 8) || '-' ||
    substr(md5(parent_request_key::text || ':' || operation_label), 9, 4) || '-' ||
    substr(md5(parent_request_key::text || ':' || operation_label), 13, 4) || '-' ||
    substr(md5(parent_request_key::text || ':' || operation_label), 17, 4) || '-' ||
    substr(md5(parent_request_key::text || ':' || operation_label), 21, 12)
  )::uuid;
$$;

revoke all on function public.pos_child_request_key_v1(uuid, text)
  from public, anon, authenticated;

create or replace function public.save_pos_customer_commercial_profile_v1(
  p_request_key uuid,
  p_customer_id uuid,
  p_expected_commercial_version integer,
  p_contact_name text,
  p_phone text,
  p_email text,
  p_business_name text,
  p_tax_id text,
  p_address text,
  p_city text,
  p_commercial_notes text,
  p_customer_type text,
  p_credit_mode text,
  p_credit_limit numeric,
  p_credit_terms_days integer,
  p_credit_notes text,
  p_change_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  operation_name text := case when p_customer_id is null
    then 'create_pos_customer_commercial_profile_v1'
    else 'update_pos_customer_commercial_profile_v1' end;
  normalized_customer_type text := lower(trim(coalesce(p_customer_type, 'retail')));
  normalized_credit_mode text := lower(trim(coalesce(p_credit_mode, 'none')));
  normalized_reason text := coalesce(
    nullif(trim(coalesce(p_change_reason, '')), ''),
    'Configurado desde Punto de Venta.'
  );
  normalized_credit_notes text := nullif(trim(coalesce(p_credit_notes, '')), '');
  normalized_limit numeric(12,2) := round(coalesce(p_credit_limit, 0), 2);
  normalized_terms integer := coalesce(p_credit_terms_days, 30);
  payload jsonb;
  payload_hash text;
  claim_record record;
  identity_result jsonb;
  child_result jsonb;
  customer_record public.customers%rowtype;
  created_profile boolean := p_customer_id is null;
  customer_target_id uuid := p_customer_id;
  final_result jsonb;
begin
  if actor_id is null
    or actor_role_name not in ('technical_owner', 'business_owner', 'admin')
    or not public.pos_permission_allowed('pos:access')
    or not public.pos_permission_allowed(case when created_profile then 'pos:customers:create' else 'pos:customers:update' end)
    or not public.has_permission('wholesale:manage')
    or not public.has_permission('credit:manage') then
    raise exception using errcode = '42501', message = 'CUSTOMER_COMMERCIAL_UPDATE_DENIED';
  end if;
  if p_request_key is null
    or p_request_key = '00000000-0000-0000-0000-000000000000'::uuid then
    raise exception using errcode = '22023', message = 'CUSTOMER_CREATE_FAILED';
  end if;
  if normalized_customer_type not in ('retail', 'wholesale') then
    raise exception using errcode = '22023', message = 'WHOLESALE_CONFIGURATION_INVALID';
  end if;
  if normalized_credit_mode not in ('none', 'unchanged', 'active', 'suspended', 'disabled') then
    raise exception using errcode = '22023', message = 'CREDIT_CONFIGURATION_INVALID';
  end if;
  if created_profile and normalized_credit_mode not in ('none', 'active') then
    raise exception using errcode = '22023', message = 'CREDIT_CONFIGURATION_INVALID';
  end if;
  if not created_profile and p_expected_commercial_version is null then
    raise exception using errcode = '22023', message = 'CUSTOMER_CREATE_FAILED';
  end if;
  if normalized_credit_mode in ('active', 'suspended') and normalized_limit <= 0 then
    raise exception using errcode = '22023', message = 'CREDIT_CONFIGURATION_INVALID';
  end if;
  if normalized_credit_mode in ('active', 'suspended', 'disabled')
    and normalized_terms not between 1 and 365 then
    raise exception using errcode = '22023', message = 'CREDIT_CONFIGURATION_INVALID';
  end if;
  if normalized_limit < 0 or normalized_limit > 9999999999.99
    or (normalized_credit_notes is not null and char_length(normalized_credit_notes) > 1000)
    or char_length(normalized_reason) not between 5 and 500 then
    raise exception using errcode = '22023', message = 'CREDIT_CONFIGURATION_INVALID';
  end if;

  payload := jsonb_build_object(
    'customer_id', p_customer_id,
    'expected_commercial_version', p_expected_commercial_version,
    'contact_name', nullif(trim(coalesce(p_contact_name, '')), ''),
    'phone', public.normalize_pos_customer_phone_v1(p_phone),
    'email', public.normalize_pos_customer_email_v1(p_email),
    'business_name', nullif(trim(coalesce(p_business_name, '')), ''),
    'tax_id', public.normalize_pos_customer_tax_id_v1(p_tax_id),
    'address', nullif(trim(coalesce(p_address, '')), ''),
    'city', nullif(trim(coalesce(p_city, '')), ''),
    'commercial_notes', nullif(trim(coalesce(p_commercial_notes, '')), ''),
    'customer_type', normalized_customer_type,
    'credit_mode', normalized_credit_mode,
    'credit_limit', normalized_limit,
    'credit_terms_days', normalized_terms,
    'credit_notes', normalized_credit_notes,
    'change_reason', normalized_reason
  );
  payload_hash := encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex');
  select * into claim_record
  from public.claim_pos_idempotency_v1(p_request_key, operation_name, payload_hash);
  if claim_record.request_status = 'succeeded' then
    return claim_record.stored_result || jsonb_build_object('idempotentReplay', true);
  elsif not claim_record.acquired then
    raise exception using errcode = '55000', message = 'CUSTOMER_PROFILE_IN_PROGRESS';
  end if;

  if created_profile then
    identity_result := public.create_pos_customer_v1(
      public.pos_child_request_key_v1(p_request_key, 'identity'),
      p_contact_name, p_phone, p_email, p_business_name, p_tax_id,
      p_address, p_city, p_commercial_notes
    );
  else
    identity_result := public.update_pos_customer_v1(
      public.pos_child_request_key_v1(p_request_key, 'identity'),
      p_customer_id, p_expected_commercial_version,
      p_contact_name, p_phone, p_email, p_business_name, p_tax_id,
      p_address, p_city, p_commercial_notes
    );
  end if;
  if not coalesce((identity_result->>'ok')::boolean, false) then
    perform public.complete_pos_idempotency_v1(
      p_request_key, operation_name, payload_hash, identity_result
    );
    return identity_result;
  end if;

  customer_target_id := (identity_result->>'customerId')::uuid;
  select * into customer_record from public.customers
  where id = customer_target_id for update;
  if customer_record.id is null then
    raise exception using errcode = 'P0002', message = 'CUSTOMER_NOT_FOUND';
  end if;

  if normalized_customer_type = 'wholesale' then
    if customer_record.wholesale_status = 'suspended' then
      child_result := public.transition_customer_wholesale_access_v1(
        public.pos_child_request_key_v1(p_request_key, 'wholesale-reactivate'),
        customer_record.id, 'reactivate', customer_record.commercial_version,
        customer_record.wholesale_status, null, normalized_reason
      );
    elsif customer_record.wholesale_status <> 'approved' then
      child_result := public.grant_customer_wholesale_access_v1(
        public.pos_child_request_key_v1(p_request_key, 'wholesale-grant'),
        customer_record.id,
        case when created_profile then 'new' else coalesce(customer_record.wholesale_customer_type, 'existing') end,
        'admin_direct_grant',
        customer_record.commercial_version,
        customer_record.wholesale_status,
        null,
        normalized_reason
      );
    end if;
  elsif customer_record.wholesale_status <> 'none' then
    child_result := public.return_customer_to_retail_v1(
      public.pos_child_request_key_v1(p_request_key, 'wholesale-retail'),
      customer_record.id, customer_record.commercial_version,
      customer_record.wholesale_status, normalized_reason
    );
  end if;

  select * into customer_record from public.customers
  where id = customer_target_id for update;

  if normalized_credit_mode in ('active', 'suspended', 'disabled') then
    perform public.set_customer_commercial_credit(
      customer_target_id,
      normalized_credit_mode <> 'disabled',
      normalized_limit,
      normalized_terms,
      case when normalized_credit_mode = 'active' then 'active' else 'suspended' end,
      normalized_credit_notes
    );
  end if;

  select * into customer_record from public.customers
  where id = customer_target_id;
  perform public.write_audit_log(
    'customers', customer_target_id, 'pos.customer.commercial_profile_saved', null,
    jsonb_build_object(
      'request_key', p_request_key,
      'operation', case when created_profile then 'create' else 'update' end,
      'customer_type', normalized_customer_type,
      'credit_mode', normalized_credit_mode,
      'commercial_version', customer_record.commercial_version,
      'portal_linked', customer_record.user_id is not null,
      'actor_role', actor_role_name
    )
  );

  final_result := jsonb_build_object(
    'ok', true,
    'status', case when created_profile then 'created' else 'updated' end,
    'message', case when created_profile
      then 'Cliente y configuracion comercial creados correctamente.'
      else 'Configuracion comercial actualizada correctamente.' end,
    'customerId', customer_target_id,
    'commercialVersion', customer_record.commercial_version,
    'customerType', case when customer_record.is_wholesale then 'wholesale' else 'retail' end,
    'wholesaleStatus', customer_record.wholesale_status,
    'creditMode', normalized_credit_mode,
    'portalLinked', customer_record.user_id is not null,
    'idempotentReplay', false
  );
  perform public.complete_pos_idempotency_v1(
    p_request_key, operation_name, payload_hash, final_result
  );
  return final_result;
end;
$$;

revoke all on function public.save_pos_customer_commercial_profile_v1(
  uuid, uuid, integer, text, text, text, text, text, text, text, text,
  text, text, numeric, integer, text, text
) from public, anon;
grant execute on function public.save_pos_customer_commercial_profile_v1(
  uuid, uuid, integer, text, text, text, text, text, text, text, text,
  text, text, numeric, integer, text, text
) to authenticated;

comment on function public.save_pos_customer_commercial_profile_v1(
  uuid, uuid, integer, text, text, text, text, text, text, text, text,
  text, text, numeric, integer, text, text
) is
  'Atomic, idempotent POS orchestration for internal identity, canonical wholesale state and canonical commercial credit. It never creates Auth or portal access.';

commit;

create or replace function public.update_pos_customer_v1(
  p_request_key uuid,
  p_customer_id uuid,
  p_expected_commercial_version integer,
  p_contact_name text,
  p_phone text,
  p_email text default null,
  p_business_name text default null,
  p_tax_id text default null,
  p_address text default null,
  p_city text default null,
  p_commercial_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  normalized_name text := nullif(trim(regexp_replace(coalesce(p_contact_name, ''), '\s+', ' ', 'g')), '');
  normalized_business text := nullif(trim(regexp_replace(coalesce(p_business_name, ''), '\s+', ' ', 'g')), '');
  normalized_email text := public.normalize_pos_customer_email_v1(p_email);
  normalized_phone text := public.normalize_pos_customer_phone_v1(p_phone);
  normalized_tax text := public.normalize_pos_customer_tax_id_v1(p_tax_id);
  normalized_address text := nullif(trim(regexp_replace(coalesce(p_address, ''), '\s+', ' ', 'g')), '');
  normalized_city text := nullif(trim(regexp_replace(coalesce(p_city, ''), '\s+', ' ', 'g')), '');
  normalized_notes text := nullif(trim(regexp_replace(coalesce(p_commercial_notes, ''), '\s+', ' ', 'g')), '');
  payload jsonb;
  payload_hash text;
  claim_record record;
  duplicate_id uuid;
  current_customer public.customers%rowtype;
  saved_customer public.customers%rowtype;
  safe_result jsonb;
  lock_key text;
begin
  if not public.pos_permission_allowed('pos:access')
    or not public.pos_permission_allowed('pos:customers:update') then
    raise exception using errcode = '42501', message = 'CUSTOMER_COMMERCIAL_UPDATE_DENIED';
  end if;
  if p_request_key is null or p_customer_id is null or p_expected_commercial_version is null then
    raise exception using errcode = '22023', message = 'CUSTOMER_CREATE_FAILED';
  end if;
  if normalized_name is null or char_length(normalized_name) > 160 then
    raise exception using errcode = '22023', message = 'CUSTOMER_NAME_REQUIRED';
  end if;
  if nullif(trim(coalesce(p_phone, '')), '') is not null
    and (normalized_phone is null or char_length(regexp_replace(normalized_phone, '[^0-9]', '', 'g')) not between 8 and 20) then
    raise exception using errcode = '22023', message = 'CUSTOMER_PHONE_INVALID';
  end if;
  if nullif(trim(coalesce(p_email, '')), '') is not null
    and (normalized_email is null or char_length(normalized_email) > 254 or normalized_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception using errcode = '22023', message = 'CUSTOMER_EMAIL_INVALID';
  end if;
  if nullif(trim(coalesce(p_tax_id, '')), '') is not null
    and (normalized_tax is null or normalized_tax !~ '^[0-9]{14}$') then
    raise exception using errcode = '22023', message = 'CUSTOMER_RTN_INVALID';
  end if;
  if normalized_notes is not null and char_length(normalized_notes) > 1000 then
    raise exception using errcode = '22023', message = 'CUSTOMER_CREATE_FAILED';
  end if;

  payload := jsonb_build_object(
    'customer_id', p_customer_id, 'expected_version', p_expected_commercial_version,
    'contact_name', normalized_name, 'phone', normalized_phone, 'email', normalized_email,
    'business_name', normalized_business, 'tax_id', normalized_tax, 'address', normalized_address,
    'city', normalized_city, 'commercial_notes', normalized_notes
  );
  payload_hash := encode(extensions.digest(convert_to(payload::text, 'UTF8'), 'sha256'), 'hex');
  select * into claim_record
  from public.claim_pos_idempotency_v1(p_request_key, 'update_pos_customer_v1', payload_hash);
  if claim_record.request_status = 'succeeded' then
    return claim_record.stored_result || jsonb_build_object('idempotentReplay', true);
  elsif not claim_record.acquired then
    raise exception using errcode = '55000', message = 'CUSTOMER_UPDATE_IN_PROGRESS';
  end if;

  for lock_key in
    select value from unnest(array_remove(array[
      case when normalized_email is not null then 'email:' || normalized_email end,
      case when normalized_phone is not null then 'phone:' || normalized_phone end,
      case when normalized_tax is not null then 'tax:' || normalized_tax end
    ], null)) value order by value
  loop
    perform pg_advisory_xact_lock(hashtextextended('pos-customer:' || lock_key, 0));
  end loop;

  select * into current_customer from public.customers where id = p_customer_id for update;
  if current_customer.id is null then
    raise exception using errcode = 'P0002', message = 'CUSTOMER_NOT_FOUND';
  end if;
  if current_customer.commercial_version <> p_expected_commercial_version then
    safe_result := jsonb_build_object(
      'ok', false, 'status', 'version_conflict',
      'message', 'El cliente cambio desde que lo abriste. Recarga sus datos antes de guardar.',
      'customerId', current_customer.id, 'commercialVersion', current_customer.commercial_version,
      'idempotentReplay', false
    );
    perform public.write_audit_log(
      'customers', current_customer.id, 'pos.customer.version_conflict', null,
      jsonb_build_object('request_key', p_request_key, 'expected_version', p_expected_commercial_version, 'actual_version', current_customer.commercial_version)
    );
    perform public.complete_pos_idempotency_v1(p_request_key, 'update_pos_customer_v1', payload_hash, safe_result);
    return safe_result;
  end if;

  duplicate_id := public.find_pos_customer_duplicate_v1(normalized_email, normalized_phone, normalized_tax, p_customer_id);
  if duplicate_id is not null then
    safe_result := jsonb_build_object(
      'ok', false, 'status', 'duplicate',
      'message', 'Otro cliente ya utiliza el mismo correo, telefono o RTN.',
      'customerId', duplicate_id, 'commercialVersion', current_customer.commercial_version,
      'idempotentReplay', false
    );
    perform public.write_audit_log(
      'customers', current_customer.id, 'pos.customer.duplicate_update_blocked', null,
      jsonb_build_object('request_key', p_request_key, 'matched_customer_id', duplicate_id)
    );
    perform public.complete_pos_idempotency_v1(p_request_key, 'update_pos_customer_v1', payload_hash, safe_result);
    return safe_result;
  end if;

  update public.customers
  set contact_name = normalized_name, phone = normalized_phone, email = normalized_email,
      business_name = normalized_business, company_name = normalized_business,
      tax_id = normalized_tax, address = normalized_address, city = normalized_city,
      commercial_notes = normalized_notes, updated_at = now()
  where id = p_customer_id
  returning * into saved_customer;

  safe_result := jsonb_build_object(
    'ok', true, 'status', 'updated', 'message', 'Cliente actualizado correctamente.',
    'customerId', saved_customer.id, 'commercialVersion', saved_customer.commercial_version,
    'idempotentReplay', false
  );
  perform public.write_audit_log(
    'customers', saved_customer.id, 'pos.customer.updated',
    jsonb_build_object(
      'commercial_version', current_customer.commercial_version,
      'has_email', current_customer.email is not null,
      'phone_last4', case when public.normalize_pos_customer_phone_v1(current_customer.phone) is null then null else right(public.normalize_pos_customer_phone_v1(current_customer.phone), 4) end,
      'has_tax_id', current_customer.tax_id is not null
    ),
    jsonb_build_object(
      'commercial_version', saved_customer.commercial_version, 'request_key', p_request_key,
      'has_email', saved_customer.email is not null,
      'phone_last4', case when normalized_phone is null then null else right(normalized_phone, 4) end,
      'has_tax_id', saved_customer.tax_id is not null
    )
  );
  perform public.complete_pos_idempotency_v1(p_request_key, 'update_pos_customer_v1', payload_hash, safe_result);
  return safe_result;
end;
$$;
