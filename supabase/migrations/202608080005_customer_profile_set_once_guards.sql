-- Optional commercial profile fields with customer set-once semantics.
-- Forward-only: no customer rows are backfilled or rewritten by this migration.

update public.roles
set permissions = coalesce(permissions, '[]'::jsonb) || '["customers:update_identity"]'::jsonb
where name in ('technical_owner', 'business_owner', 'admin')
  and not (coalesce(permissions, '[]'::jsonb) ? 'customers:update_identity');

create or replace function public.normalize_customer_commercial_text_v1(raw_value text, maximum_length integer)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select case
    when normalized_value is null then null
    when maximum_length < 1 or char_length(normalized_value) > maximum_length then null
    when normalized_value ~ '[[:cntrl:]<>]' then null
    else normalized_value
  end
  from (select nullif(trim(coalesce(raw_value, '')), '') as normalized_value) normalized;
$$;

create or replace function public.validate_customer_commercial_values_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  normalized_business text;
  normalized_city text;
begin
  if tg_op = 'INSERT' or new.business_name is distinct from old.business_name then
    normalized_business := public.normalize_customer_commercial_text_v1(new.business_name, 160);
    if nullif(trim(coalesce(new.business_name, '')), '') is not null and normalized_business is null then
      raise exception using errcode = '22023', message = 'CUSTOMER_BUSINESS_NAME_INVALID';
    end if;
    new.business_name := normalized_business;
  end if;

  if tg_op = 'INSERT' or new.city is distinct from old.city then
    normalized_city := public.normalize_customer_commercial_text_v1(new.city, 120);
    if nullif(trim(coalesce(new.city, '')), '') is not null and normalized_city is null then
      raise exception using errcode = '22023', message = 'CUSTOMER_CITY_INVALID';
    end if;
    new.city := normalized_city;
  end if;

  return new;
end;
$$;

drop trigger if exists customers_00_validate_commercial_values_v1 on public.customers;
create trigger customers_00_validate_commercial_values_v1
before insert or update of business_name, city on public.customers
for each row execute function public.validate_customer_commercial_values_v1();

create or replace function public.canonicalize_customer_tax_id_write_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  normalized_tax text;
begin
  if tg_op = 'UPDATE' and new.tax_id is not distinct from old.tax_id then
    return new;
  end if;

  if nullif(trim(coalesce(new.tax_id, '')), '') is null then
    new.tax_id := null;
    return new;
  end if;

  if new.tax_id !~ '^[0-9 -]+$' then
    if tg_op = 'UPDATE' and nullif(current_setting('app.customer_merge_operation', true), '') is not null then
      return new;
    end if;
    raise exception using errcode = '22023', message = 'CUSTOMER_RTN_INVALID';
  end if;

  normalized_tax := public.normalize_customer_tax_id_hn_v1(new.tax_id);
  if normalized_tax is null then
    if tg_op = 'UPDATE' and nullif(current_setting('app.customer_merge_operation', true), '') is not null then
      return new;
    end if;
    raise exception using errcode = '22023', message = 'CUSTOMER_RTN_INVALID';
  end if;

  new.tax_id := normalized_tax;
  return new;
end;
$$;

drop trigger if exists customers_01_canonical_tax_id_write_v1 on public.customers;
create trigger customers_01_canonical_tax_id_write_v1
before insert or update of tax_id on public.customers
for each row execute function public.canonicalize_customer_tax_id_write_v1();

create or replace function public.prepare_portal_registration_commercial_fields_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  metadata jsonb;
  requested_city text;
  normalized_city text;
begin
  if new.source is distinct from 'portal_registration' or new.user_id is null then
    return new;
  end if;

  select au.raw_user_meta_data into metadata
  from auth.users au
  where au.id = new.user_id;

  requested_city := nullif(trim(coalesce(metadata->>'city', '')), '');
  normalized_city := public.normalize_customer_commercial_text_v1(requested_city, 120);
  if requested_city is not null and normalized_city is null then
    raise exception using errcode = '22023', message = 'CUSTOMER_CITY_INVALID';
  end if;
  if new.city is null then new.city := normalized_city; end if;

  return new;
end;
$$;

drop trigger if exists customers_02_prepare_portal_registration_commercial_v1 on public.customers;
create trigger customers_02_prepare_portal_registration_commercial_v1
before insert on public.customers
for each row execute function public.prepare_portal_registration_commercial_fields_v1();

create or replace function public.guard_customer_commercial_identity_update_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  write_path text := nullif(current_setting('app.customer_commercial_write_path', true), '');
begin
  if new.tax_id is not distinct from old.tax_id
    and new.city is not distinct from old.city
    and new.business_name is not distinct from old.business_name
    and new.company_name is not distinct from old.company_name
  then
    return new;
  end if;

  if actor_id is not null
    and actor_role_name in ('technical_owner', 'business_owner', 'admin')
    and public.has_permission('customers:update_identity')
  then
    return new;
  end if;

  if actor_id is not null
    and old.user_id = actor_id
    and actor_role_name = 'cliente'
    and write_path = 'customer_set_once_v1'
  then
    return new;
  end if;

  if coalesce(auth.role(), '') = 'service_role'
    and old.source = 'portal_registration'
    and write_path = 'portal_registration_v1'
  then
    return new;
  end if;

  -- Trusted SECURITY DEFINER checkout, contact and POS functions are owned by
  -- the database administration roles and operate on unlinked customer rows.
  -- A browser role remains blocked even if a protected column is granted later.
  if old.user_id is null and current_user in ('postgres', 'supabase_admin') then
    return new;
  end if;

  if actor_id is not null
    and actor_role_name in ('technical_owner', 'business_owner')
    and public.has_permission('customers:merge')
    and nullif(current_setting('app.customer_merge_operation', true), '') is not null
  then
    return new;
  end if;

  raise exception using errcode = '42501', message = 'CUSTOMER_COMMERCIAL_IDENTITY_RPC_ONLY';
end;
$$;

drop trigger if exists customers_03_guard_commercial_identity_update_v1 on public.customers;
create trigger customers_03_guard_commercial_identity_update_v1
before update of tax_id, city, business_name, company_name on public.customers
for each row execute function public.guard_customer_commercial_identity_update_v1();

create or replace function public.set_my_customer_profile_fields_once_v1(
  p_request_key uuid,
  p_tax_id text default null,
  p_city text default null,
  p_business_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text;
  profile_active boolean;
  email_confirmed boolean;
  linked_count integer;
  customer_row public.customers%rowtype;
  saved_customer public.customers%rowtype;
  requested_tax_raw text := nullif(trim(coalesce(p_tax_id, '')), '');
  requested_tax text;
  requested_city_raw text := nullif(trim(coalesce(p_city, '')), '');
  requested_city text;
  requested_business_raw text := nullif(trim(coalesce(p_business_name, '')), '');
  requested_business text;
  changed_fields text[] := array[]::text[];
  conflict_field text;
begin
  if actor_id is null then
    return jsonb_build_object('ok', false, 'code', 'AUTH_REQUIRED', 'message', 'Debes iniciar sesión para guardar este dato.');
  end if;
  if p_request_key is null or p_request_key = '00000000-0000-0000-0000-000000000000'::uuid then
    return jsonb_build_object('ok', false, 'code', 'INVALID_REQUEST_KEY', 'message', 'No fue posible validar la solicitud. Inténtalo nuevamente.');
  end if;

  select r.name, coalesce(u.active, false) into actor_role_name, profile_active
  from public.users u
  left join public.roles r on r.id = u.role_id
  where u.id = actor_id;

  select (au.email_confirmed_at is not null or au.confirmed_at is not null) into email_confirmed
  from auth.users au
  where au.id = actor_id;

  if actor_role_name is distinct from 'cliente' then
    return jsonb_build_object('ok', false, 'code', 'CUSTOMER_ROLE_REQUIRED', 'message', 'Esta acción solo está disponible para cuentas de cliente.');
  end if;
  if not coalesce(profile_active, false) or not coalesce(email_confirmed, false) then
    return jsonb_build_object('ok', false, 'code', 'ACCOUNT_NOT_VERIFIED', 'message', 'Verifica tu correo y activa tu cuenta antes de guardar este dato.');
  end if;

  if requested_tax_raw is not null and requested_tax_raw !~ '^[0-9 -]+$' then
    return jsonb_build_object('ok', false, 'code', 'RTN_INVALID', 'field', 'taxId', 'message', 'El RTN debe contener 14 dÃ­gitos.');
  end if;
  requested_tax := public.normalize_customer_tax_id_hn_v1(requested_tax_raw);
  if requested_tax_raw is not null and requested_tax is null then
    return jsonb_build_object('ok', false, 'code', 'RTN_INVALID', 'field', 'taxId', 'message', 'El RTN debe contener 14 dígitos.');
  end if;
  requested_city := public.normalize_customer_commercial_text_v1(requested_city_raw, 120);
  if requested_city_raw is not null and requested_city is null then
    return jsonb_build_object('ok', false, 'code', 'CITY_INVALID', 'field', 'city', 'message', 'La ubicación contiene caracteres no permitidos o es demasiado larga.');
  end if;
  requested_business := public.normalize_customer_commercial_text_v1(requested_business_raw, 160);
  if requested_business_raw is not null and requested_business is null then
    return jsonb_build_object('ok', false, 'code', 'BUSINESS_NAME_INVALID', 'field', 'businessName', 'message', 'El nombre del negocio contiene caracteres no permitidos o es demasiado largo.');
  end if;
  if requested_tax is null and requested_city is null and requested_business is null then
    return jsonb_build_object('ok', false, 'code', 'FIELD_REQUIRED', 'message', 'Escribe al menos un dato antes de guardar.');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('customer-profile-set-once:' || actor_id::text, 0));
  select count(*)::integer into linked_count
  from public.customers c
  where c.user_id = actor_id and c.merged_into_customer_id is null;
  if linked_count <> 1 then
    return jsonb_build_object('ok', false, 'code', 'CUSTOMER_LINK_INVALID', 'message', 'No fue posible identificar un perfil de cliente único. Contacta a administración.');
  end if;

  select * into customer_row
  from public.customers c
  where c.user_id = actor_id and c.merged_into_customer_id is null
  for update;

  if not coalesce(customer_row.active, false) or customer_row.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'CUSTOMER_INACTIVE', 'message', 'Tu perfil comercial no está activo. Contacta a administración.');
  end if;

  if requested_tax is not null and customer_row.tax_id is not null
    and coalesce(public.normalize_customer_tax_id_hn_v1(customer_row.tax_id), trim(customer_row.tax_id)) <> requested_tax
  then conflict_field := 'taxId'; end if;
  if conflict_field is null and requested_city is not null and customer_row.city is not null
    and trim(customer_row.city) <> requested_city
  then conflict_field := 'city'; end if;
  if conflict_field is null and requested_business is not null and customer_row.business_name is not null
    and trim(customer_row.business_name) <> requested_business
  then conflict_field := 'businessName'; end if;

  if conflict_field is not null then
    return jsonb_build_object(
      'ok', false,
      'code', 'FIELD_ALREADY_SET',
      'field', conflict_field,
      'message', 'Este dato ya fue registrado. Si necesita corregirlo, comuníquese con administración.'
    );
  end if;

  if requested_tax is not null and customer_row.tax_id is null then changed_fields := array_append(changed_fields, 'tax_id'); end if;
  if requested_city is not null and customer_row.city is null then changed_fields := array_append(changed_fields, 'city'); end if;
  if requested_business is not null and customer_row.business_name is null then changed_fields := array_append(changed_fields, 'business_name'); end if;

  if cardinality(changed_fields) = 0 then
    return jsonb_build_object(
      'ok', true,
      'code', 'IDEMPOTENT_REPLAY',
      'message', 'El dato ya estaba guardado con el mismo valor.',
      'customerId', customer_row.id
    );
  end if;

  perform set_config('app.customer_commercial_write_path', 'customer_set_once_v1', true);
  update public.customers
  set tax_id = case when tax_id is null and requested_tax is not null then requested_tax else tax_id end,
      city = case when city is null and requested_city is not null then requested_city else city end,
      business_name = case when business_name is null and requested_business is not null then requested_business else business_name end,
      updated_at = clock_timestamp()
  where id = customer_row.id
  returning * into saved_customer;

  perform public.write_audit_log(
    'customers',
    saved_customer.id,
    'customer.profile.field_set_once',
    null,
    jsonb_build_object(
      'changed_fields', to_jsonb(changed_fields),
      'origin', 'customer_account',
      'request_key', p_request_key,
      'values_included', false
    )
  );

  return jsonb_build_object(
    'ok', true,
    'code', 'FIELDS_SET',
    'message', 'Dato comercial guardado correctamente.',
    'customerId', saved_customer.id,
    'changedFields', to_jsonb(changed_fields)
  );
end;
$$;

create or replace function public.finalize_portal_registration_commercial_fields_v1(
  p_portal_user_id uuid,
  p_request_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  customer_row public.customers%rowtype;
  metadata jsonb;
  requested_city_raw text;
  requested_city text;
  registered_fields text[] := array[]::text[];
begin
  if coalesce(auth.role(), '') <> 'service_role' or p_portal_user_id is null or p_request_key is null then
    raise exception using errcode = '42501', message = 'PORTAL_REGISTRATION_INTERNAL_ONLY';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('portal-registration-commercial:' || p_portal_user_id::text, 0));
  select * into customer_row
  from public.customers c
  where c.user_id = p_portal_user_id
    and c.source = 'portal_registration'
    and c.merged_into_customer_id is null
  order by c.created_at
  limit 1
  for update;

  if customer_row.id is null then
    return jsonb_build_object('ok', true, 'code', 'NO_PORTAL_CUSTOMER');
  end if;

  select au.raw_user_meta_data into metadata from auth.users au where au.id = p_portal_user_id;
  requested_city_raw := nullif(trim(coalesce(metadata->>'city', '')), '');
  requested_city := public.normalize_customer_commercial_text_v1(requested_city_raw, 120);
  if requested_city_raw is not null and requested_city is null then
    raise exception using errcode = '22023', message = 'CUSTOMER_CITY_INVALID';
  end if;

  if customer_row.city is null and requested_city is not null then
    perform set_config('app.customer_commercial_write_path', 'portal_registration_v1', true);
    update public.customers set city = requested_city, updated_at = clock_timestamp()
    where id = customer_row.id returning * into customer_row;
  end if;

  if customer_row.tax_id is not null then registered_fields := array_append(registered_fields, 'tax_id'); end if;
  if customer_row.city is not null then registered_fields := array_append(registered_fields, 'city'); end if;
  if customer_row.business_name is not null then registered_fields := array_append(registered_fields, 'business_name'); end if;

  if cardinality(registered_fields) > 0 and not exists (
    select 1 from public.audit_logs a
    where a.table_name = 'customers'
      and a.record_id = customer_row.id
      and a.action = 'customer.profile.field_set_once'
      and a.new_data->>'origin' = 'registration'
  ) then
    perform public.write_audit_log(
      'customers', customer_row.id, 'customer.profile.field_set_once', null,
      jsonb_build_object(
        'actor_user_id', p_portal_user_id,
        'changed_fields', to_jsonb(registered_fields),
        'origin', 'registration',
        'request_key', p_request_key,
        'values_included', false
      )
    );
  end if;

  return jsonb_build_object('ok', true, 'code', 'REGISTRATION_COMMERCIAL_FIELDS_FINALIZED', 'customerId', customer_row.id);
end;
$$;

drop policy if exists "Users can update own customer record" on public.customers;
revoke update on public.customers from authenticated;
grant update (contact_name, email, phone, address, notes, lead_status, estimated_value, monthly_amount, active)
  on public.customers to authenticated;

revoke all on function public.normalize_customer_commercial_text_v1(text, integer) from public, anon;
grant execute on function public.normalize_customer_commercial_text_v1(text, integer) to authenticated, service_role;
revoke all on function public.set_my_customer_profile_fields_once_v1(uuid, text, text, text) from public, anon;
grant execute on function public.set_my_customer_profile_fields_once_v1(uuid, text, text, text) to authenticated;
revoke all on function public.finalize_portal_registration_commercial_fields_v1(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_portal_registration_commercial_fields_v1(uuid, uuid) to service_role;

comment on function public.set_my_customer_profile_fields_once_v1(uuid, text, text, text) is
  'Customer-only atomic set-once commercial profile write with advisory/row locks and privacy-safe audit metadata.';
comment on function public.finalize_portal_registration_commercial_fields_v1(uuid, uuid) is
  'Service-only registration finalizer for optional city metadata and one registration-origin audit event.';
comment on function public.guard_customer_commercial_identity_update_v1() is
  'Defense-in-depth guard for linked customer tax_id, city and business identity writes.';
