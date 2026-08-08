-- POS optional charges and canonical customer duplicate suggestions.
-- This migration changes contracts only. It creates no customer, order, invoice,
-- payment, receivable, inventory movement or accounting entry by itself.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.pos_sale_drafts
  drop constraint if exists pos_sale_drafts_shipping_fee_check,
  drop constraint if exists pos_sale_drafts_cod_fee_check,
  drop constraint if exists pos_sale_drafts_other_charge_check;

alter table public.pos_sale_drafts
  add column if not exists additional_charge numeric(12,2) not null default 0,
  add constraint pos_sale_drafts_shipping_fee_nonnegative check (shipping_fee >= 0),
  add constraint pos_sale_drafts_cod_fee_nonnegative check (cod_fee >= 0),
  add constraint pos_sale_drafts_additional_charge_nonnegative check (additional_charge >= 0),
  add constraint pos_sale_drafts_other_charge_nonnegative check (other_charge >= 0);

comment on column public.pos_sale_drafts.additional_charge is
  'Non-taxable optional POS charge persisted separately and emitted as a labeled order/invoice additional fee.';

-- Canonicalize Honduran local and +504 presentations to the same eight digits.
-- Other international numbers retain their country digits without punctuation.
create or replace function public.normalize_pos_customer_phone_v1(raw_value text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  with normalized as (
    select nullif(regexp_replace(coalesce(raw_value, ''), '[^0-9]', '', 'g'), '') as digits
  )
  select case
    when char_length(digits) = 11 and left(digits, 3) = '504' then right(digits, 8)
    else digits
  end
  from normalized
$$;

alter function public.build_pos_sale_draft_payload_v1(uuid)
  rename to build_pos_sale_draft_payload_pre_charges_v1;

create function public.build_pos_sale_draft_payload_v1(p_draft_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.build_pos_sale_draft_payload_pre_charges_v1(p_draft_id)
    || jsonb_build_object('additionalCharge', draft.additional_charge)
  from public.pos_sale_drafts draft
  where draft.id = p_draft_id
$$;

revoke all on function public.build_pos_sale_draft_payload_pre_charges_v1(uuid)
  from public, anon, authenticated;
revoke all on function public.build_pos_sale_draft_payload_v1(uuid)
  from public, anon, authenticated;

create or replace function public.get_pos_charge_capabilities_v1()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not public.pos_permission_allowed('pos:access') then
      jsonb_build_object(
        'shippingFeeEnabled', false,
        'codFeeEnabled', false,
        'additionalChargeEnabled', false,
        'externalChargeEnabled', false,
        'otherChargeEnabled', false,
        'disabledReason', 'Los cargos requieren configuracion contable activa.'
      )
    else jsonb_build_object(
      'shippingFeeEnabled', public.resolve_accounting_mapping_v2('revenue', 'sale_shipping_fee', (now() at time zone 'America/Tegucigalpa')::date) is not null,
      'codFeeEnabled', public.resolve_accounting_mapping_v2('revenue', 'sale_cod_fee', (now() at time zone 'America/Tegucigalpa')::date) is not null,
      'additionalChargeEnabled', public.resolve_accounting_mapping_v2('revenue', 'sale_other_charge', (now() at time zone 'America/Tegucigalpa')::date) is not null,
      'externalChargeEnabled', public.resolve_accounting_mapping_v2('revenue', 'sale_external_charge', (now() at time zone 'America/Tegucigalpa')::date) is not null,
      'otherChargeEnabled', public.resolve_accounting_mapping_v2('revenue', 'sale_other_charge', (now() at time zone 'America/Tegucigalpa')::date) is not null,
      'disabledReason', 'El cargo requiere un mapping contable activo.'
    )
  end
$$;

revoke all on function public.get_pos_charge_capabilities_v1() from public, anon;
grant execute on function public.get_pos_charge_capabilities_v1() to authenticated;

create or replace function public.mask_pos_customer_tax_id_v1(raw_value text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select case
    when public.normalize_pos_customer_tax_id_v1(raw_value) is null then null
    else '**********' || right(public.normalize_pos_customer_tax_id_v1(raw_value), 4)
  end
$$;

revoke all on function public.mask_pos_customer_tax_id_v1(text) from public, anon;
grant execute on function public.mask_pos_customer_tax_id_v1(text) to authenticated, service_role;

create or replace function public.suggest_pos_customer_duplicates_v1(
  p_contact_name text default null,
  p_business_name text default null,
  p_email text default null,
  p_phone text default null,
  p_tax_id text default null,
  p_limit integer default 8
)
returns table (
  customer_id uuid,
  display_name text,
  business_name text,
  phone_masked text,
  email_masked text,
  tax_id_masked text,
  customer_status text,
  wholesale_status text,
  has_portal_account boolean,
  source text,
  match_level text,
  matched_fields text[],
  selectable boolean,
  override_allowed boolean
)
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  normalized_name text := public.normalize_pos_customer_text_v1(p_contact_name);
  normalized_business text := public.normalize_pos_customer_text_v1(p_business_name);
  normalized_email text := public.normalize_pos_customer_email_v1(p_email);
  normalized_phone text := public.normalize_pos_customer_phone_v1(p_phone);
  normalized_tax text := public.normalize_pos_customer_tax_id_v1(p_tax_id);
  safe_limit integer := least(greatest(coalesce(p_limit, 8), 1), 10);
begin
  if auth.uid() is null
    or public.current_actor_role() not in ('technical_owner', 'business_owner', 'admin')
    or not public.pos_permission_allowed('pos:customers:search')
    or not public.pos_permission_allowed('pos:customers:create') then
    raise exception using errcode = '42501', message = 'CUSTOMER_DUPLICATE_SEARCH_DENIED';
  end if;
  if coalesce(char_length(normalized_name), 0) < 3
    and coalesce(char_length(normalized_business), 0) < 3
    and normalized_email is null
    and coalesce(char_length(normalized_phone), 0) < 8
    and coalesce(char_length(normalized_tax), 0) < 14 then
    return;
  end if;

  return query
  with candidates as (
    select
      customer.*,
      public.normalize_pos_customer_text_v1(customer.contact_name) as candidate_name,
      public.normalize_pos_customer_text_v1(coalesce(customer.company_name, customer.business_name)) as candidate_business,
      public.normalize_pos_customer_email_v1(customer.email) as candidate_email,
      public.normalize_pos_customer_phone_v1(customer.phone) as candidate_phone,
      public.normalize_pos_customer_tax_id_v1(customer.tax_id) as candidate_tax
    from public.customers customer
    where customer.merged_into_customer_id is null
  ), matches as (
    select candidate.*,
      (normalized_email is not null and candidate.candidate_email = normalized_email) as email_match,
      (normalized_phone is not null and candidate.candidate_phone = normalized_phone) as phone_match,
      (normalized_tax is not null and candidate.candidate_tax = normalized_tax) as tax_match,
      (normalized_name is not null and (
        candidate.candidate_name = normalized_name
        or extensions.similarity(candidate.candidate_name, normalized_name) >= 0.55
      )) as name_match,
      (normalized_business is not null and (
        candidate.candidate_business = normalized_business
        or extensions.similarity(candidate.candidate_business, normalized_business) >= 0.55
      )) as business_match
    from candidates candidate
  ), ranked as (
    select match.*,
      array_remove(array[
        case when match.email_match then 'email' end,
        case when match.phone_match then 'phone' end,
        case when match.tax_match then 'tax_id' end,
        case when match.name_match then 'name' end,
        case when match.business_match then 'business_name' end
      ], null)::text[] as fields,
      case when match.email_match or match.phone_match or match.tax_match then 1 else 2 end as strength,
      greatest(
        case when match.email_match or match.phone_match or match.tax_match then 1.0 else 0 end,
        coalesce(extensions.similarity(match.candidate_name, normalized_name), 0),
        coalesce(extensions.similarity(match.candidate_business, normalized_business), 0)
      ) as score
    from matches match
    where match.email_match or match.phone_match or match.tax_match or match.name_match or match.business_match
  )
  select
    ranked.id,
    coalesce(nullif(trim(ranked.business_name), ''), ranked.contact_name),
    coalesce(ranked.company_name, ranked.business_name),
    public.mask_pos_customer_phone_v1(ranked.phone),
    public.mask_pos_customer_email_v1(ranked.email),
    public.mask_pos_customer_tax_id_v1(ranked.tax_id),
    case when ranked.active and ranked.status = 'active' then 'active' else 'inactive' end,
    ranked.wholesale_status::text,
    ranked.user_id is not null,
    ranked.source,
    case when ranked.strength = 1 then 'strong' else 'probable' end,
    ranked.fields,
    ranked.active and ranked.status = 'active' and ranked.wholesale_status <> 'suspended',
    ranked.phone_match and not ranked.email_match and not ranked.tax_match
  from ranked
  order by ranked.strength, ranked.score desc, ranked.created_at, ranked.id
  limit safe_limit;
end;
$$;

revoke all on function public.suggest_pos_customer_duplicates_v1(text, text, text, text, text, integer)
  from public, anon;
grant execute on function public.suggest_pos_customer_duplicates_v1(text, text, text, text, text, integer)
  to authenticated;

create or replace function public.save_pos_sale_draft_with_charges_v1(
  p_request_key uuid,
  p_draft_id uuid,
  p_expected_version bigint,
  p_customer_id uuid,
  p_expected_customer_commercial_version integer,
  p_items jsonb,
  p_delivery_mode text default 'store_immediate',
  p_delivery_address text default null,
  p_delivery_notes text default null,
  p_internal_notes text default null,
  p_delivery_charge numeric default 0,
  p_cash_on_delivery_charge numeric default 0,
  p_additional_charge numeric default 0,
  p_other_charge numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  delivery_value numeric(12,2) := round(coalesce(p_delivery_charge, 0), 2);
  cod_value numeric(12,2) := round(coalesce(p_cash_on_delivery_charge, 0), 2);
  additional_value numeric(12,2) := round(coalesce(p_additional_charge, 0), 2);
  other_value numeric(12,2) := round(coalesce(p_other_charge, 0), 2);
  payload_hash text;
  claim record;
  saved jsonb;
  result jsonb;
  resolved_lines jsonb;
  calculated jsonb;
  tax_rate numeric := 0.15;
begin
  if not public.pos_permission_allowed('pos:drafts:edit_own') then
    raise exception using errcode = '42501', message = 'No tienes permiso para editar borradores POS.';
  end if;
  if coalesce(p_delivery_charge, 0)::text in ('NaN', 'Infinity', '-Infinity')
    or coalesce(p_cash_on_delivery_charge, 0)::text in ('NaN', 'Infinity', '-Infinity')
    or coalesce(p_additional_charge, 0)::text in ('NaN', 'Infinity', '-Infinity')
    or coalesce(p_other_charge, 0)::text in ('NaN', 'Infinity', '-Infinity')
    or delivery_value < 0 or cod_value < 0 or additional_value < 0 or other_value < 0
    or coalesce(p_delivery_charge, 0) <> delivery_value
    or coalesce(p_cash_on_delivery_charge, 0) <> cod_value
    or coalesce(p_additional_charge, 0) <> additional_value
    or coalesce(p_other_charge, 0) <> other_value then
    raise exception using errcode = '22023', message = 'Los cargos deben ser no negativos y tener maximo dos decimales.';
  end if;
  if delivery_value > 0 and public.resolve_accounting_mapping_v2('revenue', 'sale_shipping_fee', (now() at time zone 'America/Tegucigalpa')::date) is null then
    raise exception using errcode = '22023', message = 'POS_SHIPPING_MAPPING_INVALID';
  end if;
  if cod_value > 0 and public.resolve_accounting_mapping_v2('revenue', 'sale_cod_fee', (now() at time zone 'America/Tegucigalpa')::date) is null then
    raise exception using errcode = '22023', message = 'POS_COD_MAPPING_INVALID';
  end if;
  if (additional_value > 0 or other_value > 0)
    and public.resolve_accounting_mapping_v2('revenue', 'sale_other_charge', (now() at time zone 'America/Tegucigalpa')::date) is null then
    raise exception using errcode = '22023', message = 'POS_OTHER_CHARGE_MAPPING_INVALID';
  end if;

  payload_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'draft_id', p_draft_id, 'expected_version', p_expected_version,
    'customer_id', p_customer_id, 'customer_version', p_expected_customer_commercial_version,
    'items', p_items, 'delivery_mode', p_delivery_mode,
    'delivery_address', nullif(trim(coalesce(p_delivery_address, '')), ''),
    'delivery_notes', nullif(trim(coalesce(p_delivery_notes, '')), ''),
    'internal_notes', nullif(trim(coalesce(p_internal_notes, '')), ''),
    'delivery_charge', delivery_value, 'cod_charge', cod_value,
    'additional_charge', additional_value, 'other_charge', other_value
  )::text, 'UTF8'), 'sha256'), 'hex');
  select * into claim from public.claim_pos_idempotency_v1(
    p_request_key, 'save_pos_sale_draft_with_charges_v1', payload_hash
  );
  if claim.request_status = 'succeeded' then
    return claim.stored_result || jsonb_build_object('idempotentReplay', true);
  elsif not claim.acquired then
    raise exception using errcode = '55000', message = 'El guardado todavia esta en proceso.';
  end if;

  saved := public.save_pos_sale_draft_v1(
    public.pos_child_request_key_v1(p_request_key, 'draft-lines'),
    p_draft_id, p_expected_version, p_customer_id,
    p_expected_customer_commercial_version, p_items, p_delivery_mode,
    p_delivery_address, p_delivery_notes, p_internal_notes, 0, 0, 0
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'product_id', item.product_id,
    'quantity', item.quantity,
    'unit_price', item.final_unit_price,
    'tax_category', item.tax_category_snapshot
  ) order by item.product_id), '[]'::jsonb)
  into resolved_lines
  from public.pos_sale_draft_items item
  where item.draft_id = p_draft_id;
  select coalesce(settings.tax_rate, 0.15) into tax_rate
  from public.company_settings settings order by settings.created_at limit 1;
  calculated := public.calculate_pos_draft_financials_v2(
    resolved_lines, coalesce(tax_rate, 0.15), delivery_value, cod_value,
    round(additional_value + other_value, 2), 'HNL'
  );

  update public.pos_sale_drafts
  set shipping_fee = delivery_value,
      cod_fee = cod_value,
      additional_charge = additional_value,
      other_charge = other_value,
      grand_total = (calculated->>'total')::numeric,
      updated_at = now()
  where id = p_draft_id and status = 'active';
  if not found then
    raise exception using errcode = 'PT409', message = 'El borrador ya no esta activo.';
  end if;

  result := public.build_pos_sale_draft_payload_v1(p_draft_id)
    || jsonb_build_object('idempotentReplay', false);
  perform public.write_audit_log(
    'pos_sale_drafts', p_draft_id, 'pos.draft.charges_saved', null,
    jsonb_build_object(
      'request_key', p_request_key,
      'shipping_fee', delivery_value,
      'cash_on_delivery_fee', cod_value,
      'additional_charge', additional_value,
      'other_charge', other_value,
      'grand_total', (calculated->>'total')::numeric
    )
  );
  perform public.complete_pos_idempotency_v1(
    p_request_key, 'save_pos_sale_draft_with_charges_v1', payload_hash, result
  );
  return result;
end;
$$;

revoke all on function public.save_pos_sale_draft_with_charges_v1(
  uuid, uuid, bigint, uuid, integer, jsonb, text, text, text, text,
  numeric, numeric, numeric, numeric
) from public, anon;
grant execute on function public.save_pos_sale_draft_with_charges_v1(
  uuid, uuid, bigint, uuid, integer, jsonb, text, text, text, text,
  numeric, numeric, numeric, numeric
) to authenticated;

-- Exact email and RTN remain non-overridable canonical identities. An exact
-- phone can be shared only with an explicit reason; names remain suggestions.
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
  override_reason text := nullif(trim(current_setting('app.pos_duplicate_override_reason', true)), '');
  payload jsonb;
  payload_hash text;
  claim_record record;
  email_duplicate uuid;
  phone_duplicate uuid;
  tax_duplicate uuid;
  blocked_duplicate uuid;
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
  if override_reason is not null and char_length(override_reason) not between 5 and 500 then
    raise exception using errcode = '22023', message = 'CUSTOMER_DUPLICATE_OVERRIDE_REASON_INVALID';
  end if;

  payload := jsonb_build_object(
    'contact_name', normalized_name, 'phone', normalized_phone, 'email', normalized_email,
    'business_name', normalized_business, 'tax_id', normalized_tax, 'address', normalized_address,
    'city', normalized_city, 'commercial_notes', normalized_notes,
    'duplicate_override_reason', override_reason
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

  select customer.id into email_duplicate from public.customers customer
  where normalized_email is not null
    and customer.merged_into_customer_id is null
    and public.normalize_pos_customer_email_v1(customer.email) = normalized_email
  order by customer.created_at, customer.id limit 1;
  select customer.id into tax_duplicate from public.customers customer
  where normalized_tax is not null
    and customer.merged_into_customer_id is null
    and public.normalize_pos_customer_tax_id_v1(customer.tax_id) = normalized_tax
  order by customer.created_at, customer.id limit 1;
  select customer.id into phone_duplicate from public.customers customer
  where normalized_phone is not null
    and customer.merged_into_customer_id is null
    and public.normalize_pos_customer_phone_v1(customer.phone) = normalized_phone
  order by customer.created_at, customer.id limit 1;

  blocked_duplicate := coalesce(email_duplicate, tax_duplicate,
    case when override_reason is null then phone_duplicate end);
  if blocked_duplicate is not null then
    safe_result := jsonb_build_object(
      'ok', false, 'status', 'duplicate',
      'message', case
        when email_duplicate is not null then 'Ya existe un cliente con el mismo correo. Use o corrija el perfil existente.'
        when tax_duplicate is not null then 'Ya existe un cliente con el mismo RTN. Use o corrija el perfil existente.'
        else 'Ya existe un cliente con el mismo telefono. Confirme el uso compartido o seleccione el perfil existente.' end,
      'customerId', blocked_duplicate,
      'commercialVersion', (select commercial_version from public.customers where id = blocked_duplicate),
      'idempotentReplay', false
    );
    perform public.write_audit_log(
      'customers', blocked_duplicate, 'pos.customer.duplicate_blocked', null,
      jsonb_build_object(
        'request_key', p_request_key,
        'match_fields', array_remove(array[
          case when email_duplicate is not null then 'email' end,
          case when phone_duplicate is not null then 'phone' end,
          case when tax_duplicate is not null then 'tax_id' end
        ], null)
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
    'customers', created_customer.id,
    case when phone_duplicate is not null then 'pos.customer.duplicate_override' else 'pos.customer.created' end,
    null,
    jsonb_build_object(
      'customer_id', created_customer.id,
      'request_key', p_request_key,
      'matched_customer_id', phone_duplicate,
      'override_field', case when phone_duplicate is not null then 'phone' else null end,
      'override_reason', case when phone_duplicate is not null then override_reason else null end,
      'has_email', normalized_email is not null,
      'phone_last4', case when normalized_phone is null then null else right(normalized_phone, 4) end,
      'has_tax_id', normalized_tax is not null,
      'portal_linked', false,
      'auth_created', false
    )
  );
  perform public.complete_pos_idempotency_v1(p_request_key, 'create_pos_customer_v1', payload_hash, safe_result);
  return safe_result;
end;
$$;

create or replace function public.save_pos_customer_commercial_profile_v2(
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
  p_change_reason text,
  p_duplicate_override_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  payload_hash text;
  claim record;
  result jsonb;
begin
  payload_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'customer_id', p_customer_id,
    'expected_commercial_version', p_expected_commercial_version,
    'contact_name', p_contact_name, 'phone', p_phone, 'email', p_email,
    'business_name', p_business_name, 'tax_id', p_tax_id,
    'address', p_address, 'city', p_city, 'commercial_notes', p_commercial_notes,
    'customer_type', p_customer_type, 'credit_mode', p_credit_mode,
    'credit_limit', p_credit_limit, 'credit_terms_days', p_credit_terms_days,
    'credit_notes', p_credit_notes, 'change_reason', p_change_reason,
    'duplicate_override_reason', nullif(trim(coalesce(p_duplicate_override_reason, '')), '')
  )::text, 'UTF8'), 'sha256'), 'hex');
  select * into claim from public.claim_pos_idempotency_v1(
    p_request_key, 'save_pos_customer_commercial_profile_v2', payload_hash
  );
  if claim.request_status = 'succeeded' then
    return claim.stored_result || jsonb_build_object('idempotentReplay', true);
  elsif not claim.acquired then
    raise exception using errcode = '55000', message = 'CUSTOMER_PROFILE_IN_PROGRESS';
  end if;

  perform set_config('app.pos_duplicate_override_reason',
    coalesce(nullif(trim(coalesce(p_duplicate_override_reason, '')), ''), ''), true);
  result := public.save_pos_customer_commercial_profile_v1(
    public.pos_child_request_key_v1(p_request_key, 'commercial-profile-v2'),
    p_customer_id, p_expected_commercial_version, p_contact_name, p_phone,
    p_email, p_business_name, p_tax_id, p_address, p_city, p_commercial_notes,
    p_customer_type, p_credit_mode, p_credit_limit, p_credit_terms_days,
    p_credit_notes, p_change_reason
  );
  perform public.complete_pos_idempotency_v1(
    p_request_key, 'save_pos_customer_commercial_profile_v2', payload_hash, result
  );
  return result;
end;
$$;

revoke all on function public.save_pos_customer_commercial_profile_v2(
  uuid, uuid, integer, text, text, text, text, text, text, text, text,
  text, text, numeric, integer, text, text, text
) from public, anon;
grant execute on function public.save_pos_customer_commercial_profile_v2(
  uuid, uuid, integer, text, text, text, text, text, text, text, text,
  text, text, numeric, integer, text, text, text
) to authenticated;

comment on function public.suggest_pos_customer_duplicates_v1(text, text, text, text, text, integer) is
  'Bounded, masked, role-protected duplicate suggestions reusable by authorized internal customer creation flows.';
comment on function public.save_pos_customer_commercial_profile_v2(
  uuid, uuid, integer, text, text, text, text, text, text, text, text,
  text, text, numeric, integer, text, text, text
) is
  'Server-revalidated POS customer profile save. Exact email/RTN are blocked; shared phone requires an audited explicit reason. Never creates Auth or portal links.';

commit;
