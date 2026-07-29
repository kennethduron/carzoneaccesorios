-- Durable, idempotent synchronization between public portal accounts and CRM
-- customer profiles. Existing CRM matches are never linked automatically.

create table if not exists public.portal_customer_profile_syncs (
  id uuid primary key default gen_random_uuid(),
  portal_user_id uuid not null references public.users(id) on delete cascade,
  state text not null
    check (state in (
      'profile_created',
      'already_linked',
      'review_required',
      'internal_user_ignored',
      'inactive_account',
      'invalid_account',
      'failed'
    )),
  customer_id uuid references public.customers(id) on delete set null,
  candidate_customer_id uuid references public.customers(id) on delete set null,
  candidate_count integer not null default 0 check (candidate_count >= 0),
  matched_fields text[] not null default array[]::text[],
  registration_source text not null,
  last_request_key uuid not null,
  payload_hash text not null,
  result jsonb not null default '{}'::jsonb,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint portal_customer_profile_syncs_portal_user_unique unique (portal_user_id)
);

create table if not exists public.portal_customer_profile_sync_requests (
  request_key uuid primary key,
  operation text not null default 'ensure_profile'
    check (operation = 'ensure_profile'),
  portal_user_id uuid not null references public.users(id) on delete cascade,
  source text not null
    check (source in ('registration', 'callback', 'login', 'checkout_recovery', 'admin_recovery')),
  payload_hash text not null,
  status text not null default 'processing'
    check (status in ('processing', 'completed', 'failed')),
  result jsonb not null default '{}'::jsonb,
  actor_user_id uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.portal_customer_link_reviews (
  id uuid primary key default gen_random_uuid(),
  portal_user_id uuid not null references public.users(id) on delete cascade,
  candidate_customer_id uuid references public.customers(id) on delete set null,
  candidate_count integer not null default 0 check (candidate_count > 0),
  matched_fields text[] not null default array[]::text[],
  status text not null default 'pending'
    check (status in ('pending', 'resolved', 'dismissed')),
  source text not null,
  created_by uuid references public.users(id) on delete set null,
  resolved_by uuid references public.users(id) on delete set null,
  resolved_customer_id uuid references public.customers(id) on delete set null,
  resolution text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists portal_customer_link_reviews_pending_user_idx
  on public.portal_customer_link_reviews(portal_user_id)
  where status = 'pending';

create index if not exists portal_customer_profile_syncs_state_created_idx
  on public.portal_customer_profile_syncs(state, created_at desc);

create index if not exists portal_customer_profile_sync_requests_user_created_idx
  on public.portal_customer_profile_sync_requests(portal_user_id, created_at desc);

create index if not exists portal_customer_link_reviews_status_created_idx
  on public.portal_customer_link_reviews(status, created_at desc);

alter table public.portal_customer_profile_syncs enable row level security;
alter table public.portal_customer_profile_sync_requests enable row level security;
alter table public.portal_customer_link_reviews enable row level security;

drop policy if exists "Portal users can read own profile sync" on public.portal_customer_profile_syncs;
create policy "Portal users can read own profile sync"
  on public.portal_customer_profile_syncs for select
  using (
    portal_user_id = auth.uid()
    or public.has_permission('customers:manage')
    or public.has_permission('customers:link_portal_account')
    or public.has_permission('system:monitoring')
  );

drop policy if exists "Portal users can read own profile sync requests" on public.portal_customer_profile_sync_requests;
create policy "Portal users can read own profile sync requests"
  on public.portal_customer_profile_sync_requests for select
  using (
    portal_user_id = auth.uid()
    or public.has_permission('customers:manage')
    or public.has_permission('customers:link_portal_account')
    or public.has_permission('system:monitoring')
  );

drop policy if exists "Authorized staff can read portal customer link reviews" on public.portal_customer_link_reviews;
create policy "Authorized staff can read portal customer link reviews"
  on public.portal_customer_link_reviews for select
  using (
    public.has_permission('customers:manage')
    or public.has_permission('customers:link_portal_account')
    or public.has_permission('system:monitoring')
  );

grant select on public.portal_customer_profile_syncs to authenticated;
grant select on public.portal_customer_profile_sync_requests to authenticated;
grant select on public.portal_customer_link_reviews to authenticated;
grant select, insert, update, delete on public.portal_customer_profile_syncs to service_role;
grant select, insert, update, delete on public.portal_customer_profile_sync_requests to service_role;
grant select, insert, update, delete on public.portal_customer_link_reviews to service_role;

create or replace function public.normalize_portal_customer_email(raw_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when lower(trim(coalesce(raw_value, ''))) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      then lower(trim(raw_value))
    else null
  end;
$$;

create or replace function public.normalize_portal_customer_phone(raw_value text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  digits text := regexp_replace(coalesce(raw_value, ''), '\D', '', 'g');
begin
  if digits ~ '^0+$' then
    return null;
  end if;

  if length(digits) = 8 then
    return digits;
  end if;

  if length(digits) = 11 and digits like '504%' then
    return right(digits, 8);
  end if;

  return null;
end;
$$;

create or replace function public.normalize_portal_customer_tax_id(raw_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when length(regexp_replace(coalesce(raw_value, ''), '\D', '', 'g')) = 14
      then regexp_replace(raw_value, '\D', '', 'g')
    else null
  end;
$$;

create or replace function public.normalize_portal_customer_search(raw_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select trim(
    regexp_replace(
      translate(
        lower(coalesce(raw_value, '')),
        'áéíóúüñ',
        'aeiouun'
      ),
      '[[:space:]]+',
      ' ',
      'g'
    )
  );
$$;

create or replace function public.ensure_portal_customer_profile_core_v1(
  p_portal_user_id uuid,
  p_source text,
  p_request_key uuid,
  p_actor_user_id uuid default null,
  p_expected_state text default null,
  p_reason text default null,
  p_admin_mode boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  profile_row record;
  auth_row record;
  linked_customer public.customers%rowtype;
  created_customer public.customers%rowtype;
  sync_row public.portal_customer_profile_syncs%rowtype;
  existing_request public.portal_customer_profile_sync_requests%rowtype;
  review_row public.portal_customer_link_reviews%rowtype;
  normalized_email text;
  normalized_phone text;
  normalized_tax_id text;
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
  normalized_company text;
  payload_hash_value text;
  current_state text;
  candidate_ids uuid[] := '{}'::uuid[];
  primary_candidate_id uuid;
  candidate_count_value integer := 0;
  matched_fields_value text[] := '{}'::text[];
  confirmed boolean := false;
  notify_registration boolean := true;
  outcome jsonb;
  actor_role_name text := case when p_actor_user_id is null then 'system' else public.current_actor_role() end;
begin
  if p_portal_user_id is null or p_request_key is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'INVALID_INPUT',
      'message', 'No se pudo validar la solicitud de sincronización.'
    );
  end if;

  if p_source not in ('registration', 'callback', 'login', 'checkout_recovery', 'admin_recovery') then
    return jsonb_build_object(
      'ok', false,
      'code', 'INVALID_SOURCE',
      'message', 'El origen de sincronización no es válido.'
    );
  end if;

  if p_admin_mode then
    if p_actor_user_id is null
      or actor_role_name not in ('technical_owner', 'business_owner', 'admin')
      or not (
        public.has_permission('customers:manage')
        or public.has_permission('customers:link_portal_account')
      )
    then
      return jsonb_build_object(
        'ok', false,
        'code', 'PERMISSION_DENIED',
        'message', 'No tienes permiso para recuperar perfiles comerciales.'
      );
    end if;

    if normalized_reason is null or char_length(normalized_reason) < 10 then
      return jsonb_build_object(
        'ok', false,
        'code', 'REASON_REQUIRED',
        'message', 'Escribe un motivo de al menos 10 caracteres.'
      );
    end if;

    if char_length(normalized_reason) > 500 then
      return jsonb_build_object(
        'ok', false,
        'code', 'REASON_TOO_LONG',
        'message', 'El motivo no puede exceder 500 caracteres.'
      );
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('portal-customer-sync-request:' || p_request_key::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('portal-customer-sync-user:' || p_portal_user_id::text, 0));

  select
    u.id,
    u.full_name,
    u.email,
    u.phone,
    u.active,
    r.name as role_name
  into profile_row
  from public.users u
  left join public.roles r on r.id = u.role_id
  where u.id = p_portal_user_id
  for update of u;

  select
    au.id,
    au.email,
    au.email_confirmed_at,
    au.confirmed_at,
    au.raw_user_meta_data
  into auth_row
  from auth.users au
  where au.id = p_portal_user_id;

  normalized_email := public.normalize_portal_customer_email(
    coalesce(auth_row.email, profile_row.email)
  );
  normalized_phone := public.normalize_portal_customer_phone(
    coalesce(
      nullif(profile_row.phone, ''),
      auth_row.raw_user_meta_data->>'phone'
    )
  );
  normalized_tax_id := public.normalize_portal_customer_tax_id(
    coalesce(
      auth_row.raw_user_meta_data->>'tax_id',
      auth_row.raw_user_meta_data->>'rtn'
    )
  );
  normalized_company := nullif(trim(coalesce(
    auth_row.raw_user_meta_data->>'company_name',
    auth_row.raw_user_meta_data->>'business_name',
    ''
  )), '');
  confirmed := auth_row.email_confirmed_at is not null or auth_row.confirmed_at is not null;

  payload_hash_value := encode(
    extensions.digest(
      concat_ws(
        '|',
        'ensure_portal_customer_profile_v1',
        p_portal_user_id::text,
        p_source,
        coalesce(profile_row.role_name, ''),
        coalesce(profile_row.active, false)::text,
        coalesce(confirmed, false)::text,
        coalesce(normalized_email, ''),
        coalesce(normalized_phone, ''),
        coalesce(normalized_tax_id, ''),
        coalesce(p_expected_state, ''),
        coalesce(normalized_reason, '')
      ),
      'sha256'
    ),
    'hex'
  );

  select *
  into existing_request
  from public.portal_customer_profile_sync_requests
  where request_key = p_request_key
  for update;

  if existing_request.request_key is not null then
    if existing_request.portal_user_id <> p_portal_user_id
      or existing_request.operation <> 'ensure_profile'
      or existing_request.payload_hash <> payload_hash_value
    then
      return jsonb_build_object(
        'ok', false,
        'code', 'IDEMPOTENCY_CONFLICT',
        'message', 'La clave de solicitud ya fue usada con un contenido diferente.'
      );
    end if;

    if existing_request.status = 'completed' then
      return existing_request.result || jsonb_build_object('idempotentReplay', true);
    end if;
  else
    insert into public.portal_customer_profile_sync_requests (
      request_key,
      operation,
      portal_user_id,
      source,
      payload_hash,
      status,
      actor_user_id
    )
    values (
      p_request_key,
      'ensure_profile',
      p_portal_user_id,
      p_source,
      payload_hash_value,
      'processing',
      p_actor_user_id
    );
  end if;

  select *
  into sync_row
  from public.portal_customer_profile_syncs
  where portal_user_id = p_portal_user_id
  for update;

  select *
  into linked_customer
  from public.customers
  where user_id = p_portal_user_id
  for update;

  current_state := coalesce(
    sync_row.state,
    case when linked_customer.id is not null then 'already_linked' else 'unresolved' end
  );

  if p_admin_mode and coalesce(p_expected_state, '') <> current_state then
    outcome := jsonb_build_object(
      'ok', false,
      'code', 'STATE_CONFLICT',
      'message', 'El estado de la cuenta cambió. Actualiza la revisión antes de continuar.',
      'state', current_state
    );

    update public.portal_customer_profile_sync_requests
    set status = 'completed',
        result = outcome,
        completed_at = now(),
        updated_at = now()
    where request_key = p_request_key;

    return outcome;
  end if;

  if profile_row.id is null or auth_row.id is null or profile_row.role_name is null then
    outcome := jsonb_build_object(
      'ok', false,
      'code', 'INVALID_ACCOUNT',
      'message', 'La cuenta no tiene una identidad pública completa.',
      'state', 'invalid_account'
    );

    insert into public.portal_customer_profile_syncs (
      portal_user_id, state, registration_source, last_request_key, payload_hash, result, updated_at
    )
    values (
      p_portal_user_id, 'invalid_account', p_source, p_request_key, payload_hash_value, outcome, now()
    )
    on conflict (portal_user_id) do update
    set state = excluded.state,
        registration_source = excluded.registration_source,
        last_request_key = excluded.last_request_key,
        payload_hash = excluded.payload_hash,
        result = excluded.result,
        updated_at = now();

    update public.portal_customer_profile_sync_requests
    set status = 'completed', result = outcome, completed_at = now(), updated_at = now()
    where request_key = p_request_key;

    return outcome;
  end if;

  if profile_row.role_name <> 'cliente' then
    outcome := jsonb_build_object(
      'ok', true,
      'code', 'INTERNAL_USER_IGNORED',
      'message', 'La cuenta interna no se convirtió en cliente.',
      'state', 'internal_user_ignored'
    );

    insert into public.portal_customer_profile_syncs (
      portal_user_id, state, registration_source, last_request_key, payload_hash, result, resolved_at, updated_at
    )
    values (
      p_portal_user_id, 'internal_user_ignored', p_source, p_request_key, payload_hash_value, outcome, now(), now()
    )
    on conflict (portal_user_id) do update
    set state = excluded.state,
        customer_id = null,
        candidate_customer_id = null,
        candidate_count = 0,
        matched_fields = array[]::text[],
        registration_source = excluded.registration_source,
        last_request_key = excluded.last_request_key,
        payload_hash = excluded.payload_hash,
        result = excluded.result,
        resolved_at = excluded.resolved_at,
        updated_at = now();

    update public.portal_customer_profile_sync_requests
    set status = 'completed', result = outcome, completed_at = now(), updated_at = now()
    where request_key = p_request_key;

    return outcome;
  end if;

  if not coalesce(profile_row.active, false) then
    outcome := jsonb_build_object(
      'ok', false,
      'code', 'INACTIVE_ACCOUNT',
      'message', 'La cuenta está suspendida y no puede crear un perfil comercial.',
      'state', 'inactive_account'
    );

    insert into public.portal_customer_profile_syncs (
      portal_user_id, state, registration_source, last_request_key, payload_hash, result, updated_at
    )
    values (
      p_portal_user_id, 'inactive_account', p_source, p_request_key, payload_hash_value, outcome, now()
    )
    on conflict (portal_user_id) do update
    set state = excluded.state,
        registration_source = excluded.registration_source,
        last_request_key = excluded.last_request_key,
        payload_hash = excluded.payload_hash,
        result = excluded.result,
        updated_at = now();

    update public.portal_customer_profile_sync_requests
    set status = 'completed', result = outcome, completed_at = now(), updated_at = now()
    where request_key = p_request_key;

    return outcome;
  end if;

  if linked_customer.id is not null then
    if linked_customer.source = 'portal_registration'
      and linked_customer.status = 'pending_account'
      and linked_customer.wholesale_status = 'none'
      and not linked_customer.is_wholesale
      and confirmed
    then
      update public.customers
      set status = 'active',
          updated_at = now()
      where id = linked_customer.id
      returning * into linked_customer;
    end if;

    update public.portal_customer_link_reviews
    set status = 'resolved',
        resolved_by = p_actor_user_id,
        resolved_customer_id = linked_customer.id,
        resolution = 'linked_outside_profile_sync',
        resolved_at = now(),
        updated_at = now()
    where portal_user_id = p_portal_user_id
      and status = 'pending';

    update public.internal_notifications
    set status = 'resolved',
        resolved_at = now(),
        resolved_by = p_actor_user_id,
        updated_at = now()
    where dedupe_key = 'portal-customer-link-review:' || p_portal_user_id::text
      and status in ('open', 'reviewing');

    outcome := jsonb_build_object(
      'ok', true,
      'code', 'ALREADY_LINKED',
      'message', 'La cuenta ya tiene un perfil comercial vinculado.',
      'state', 'already_linked',
      'customerId', linked_customer.id,
      'emailConfirmed', confirmed
    );

    insert into public.portal_customer_profile_syncs (
      portal_user_id, state, customer_id, registration_source, last_request_key,
      payload_hash, result, resolved_at, updated_at
    )
    values (
      p_portal_user_id, 'already_linked', linked_customer.id, p_source, p_request_key,
      payload_hash_value, outcome, now(), now()
    )
    on conflict (portal_user_id) do update
    set state = excluded.state,
        customer_id = excluded.customer_id,
        candidate_customer_id = null,
        candidate_count = 0,
        matched_fields = array[]::text[],
        registration_source = excluded.registration_source,
        last_request_key = excluded.last_request_key,
        payload_hash = excluded.payload_hash,
        result = excluded.result,
        resolved_at = excluded.resolved_at,
        updated_at = now();

    update public.portal_customer_profile_sync_requests
    set status = 'completed', result = outcome, completed_at = now(), updated_at = now()
    where request_key = p_request_key;

    return outcome;
  end if;

  if normalized_email is not null then
    perform pg_advisory_xact_lock(hashtextextended('portal-customer-email:' || normalized_email, 0));
  end if;
  if normalized_phone is not null then
    perform pg_advisory_xact_lock(hashtextextended('portal-customer-phone:' || normalized_phone, 0));
  end if;
  if normalized_tax_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('portal-customer-tax:' || normalized_tax_id, 0));
  end if;

  perform 1
  from public.customers c
  where
    (
      normalized_email is not null
      and public.normalize_portal_customer_email(c.email) = normalized_email
    )
    or (
      normalized_phone is not null
      and public.normalize_portal_customer_phone(c.phone) = normalized_phone
    )
    or (
      normalized_tax_id is not null
      and public.normalize_portal_customer_tax_id(c.tax_id) = normalized_tax_id
    )
  order by c.id
  for update;

  select
    coalesce(array_agg(distinct c.id order by c.id), '{}'::uuid[]),
    count(distinct c.id)::integer
  into candidate_ids, candidate_count_value
  from public.customers c
  where
    (
      normalized_email is not null
      and public.normalize_portal_customer_email(c.email) = normalized_email
    )
    or (
      normalized_phone is not null
      and public.normalize_portal_customer_phone(c.phone) = normalized_phone
    )
    or (
      normalized_tax_id is not null
      and public.normalize_portal_customer_tax_id(c.tax_id) = normalized_tax_id
    );

  if candidate_count_value > 0 then
    primary_candidate_id := candidate_ids[1];

    select coalesce(array_agg(distinct field_name order by field_name), '{}'::text[])
    into matched_fields_value
    from (
      select 'email'::text as field_name
      where normalized_email is not null
        and exists (
          select 1 from public.customers c
          where c.id = any(candidate_ids)
            and public.normalize_portal_customer_email(c.email) = normalized_email
        )
      union all
      select 'phone'::text
      where normalized_phone is not null
        and exists (
          select 1 from public.customers c
          where c.id = any(candidate_ids)
            and public.normalize_portal_customer_phone(c.phone) = normalized_phone
        )
      union all
      select 'tax_id'::text
      where normalized_tax_id is not null
        and exists (
          select 1 from public.customers c
          where c.id = any(candidate_ids)
            and public.normalize_portal_customer_tax_id(c.tax_id) = normalized_tax_id
        )
    ) matches;

    insert into public.portal_customer_link_reviews (
      portal_user_id,
      candidate_customer_id,
      candidate_count,
      matched_fields,
      status,
      source,
      created_by,
      updated_at
    )
    values (
      p_portal_user_id,
      primary_candidate_id,
      candidate_count_value,
      matched_fields_value,
      'pending',
      p_source,
      p_actor_user_id,
      now()
    )
    on conflict (portal_user_id) where status = 'pending' do update
    set candidate_customer_id = excluded.candidate_customer_id,
        candidate_count = excluded.candidate_count,
        matched_fields = excluded.matched_fields,
        source = excluded.source,
        updated_at = now()
    returning * into review_row;

    outcome := jsonb_build_object(
      'ok', false,
      'code', 'REVIEW_REQUIRED',
      'message', 'La cuenta requiere revisión antes de vincularse con un cliente existente.',
      'state', 'review_required',
      'reviewId', review_row.id,
      'candidateCount', candidate_count_value
    );

    if p_admin_mode then
      outcome := outcome || jsonb_build_object('candidateCustomerId', primary_candidate_id);
    end if;

    insert into public.portal_customer_profile_syncs (
      portal_user_id, state, candidate_customer_id, candidate_count, matched_fields,
      registration_source, last_request_key, payload_hash, result, updated_at
    )
    values (
      p_portal_user_id, 'review_required', primary_candidate_id, candidate_count_value, matched_fields_value,
      p_source, p_request_key, payload_hash_value, outcome, now()
    )
    on conflict (portal_user_id) do update
    set state = excluded.state,
        customer_id = null,
        candidate_customer_id = excluded.candidate_customer_id,
        candidate_count = excluded.candidate_count,
        matched_fields = excluded.matched_fields,
        registration_source = excluded.registration_source,
        last_request_key = excluded.last_request_key,
        payload_hash = excluded.payload_hash,
        result = excluded.result,
        resolved_at = null,
        updated_at = now();

    insert into public.internal_notifications (
      event_type,
      notification_type,
      module,
      customer_id,
      title,
      message,
      severity,
      audience_roles,
      status,
      read_state,
      metadata,
      dedupe_key,
      updated_at
    )
    values (
      'portal_customer_link_review_required',
      'portal_customer_link_review_required',
      'CRM',
      primary_candidate_id,
      'Cuenta web pendiente de vinculación',
      'Una cuenta cliente coincide con un perfil existente y requiere revisión segura.',
      'warning',
      array['technical_owner', 'business_owner', 'admin']::text[],
      'open',
      'unread',
      jsonb_build_object(
        'action_path', '/admin/clientes?customerId=' || primary_candidate_id::text,
        'candidate_count', candidate_count_value,
        'matched_fields', matched_fields_value,
        'review_id', review_row.id
      ),
      'portal-customer-link-review:' || p_portal_user_id::text,
      now()
    )
    on conflict do nothing;

    insert into public.audit_logs (
      user_id, actor_role, table_name, record_id, action, new_data
    )
    values (
      p_actor_user_id,
      actor_role_name,
      'portal_customer_link_reviews',
      review_row.id,
      'portal_customer_profile.review_required',
      jsonb_build_object(
        'portal_user_id', p_portal_user_id,
        'candidate_count', candidate_count_value,
        'matched_fields', matched_fields_value,
        'source', p_source,
        'reason', normalized_reason
      )
    );

    update public.portal_customer_profile_sync_requests
    set status = 'completed', result = outcome, completed_at = now(), updated_at = now()
    where request_key = p_request_key;

    return outcome;
  end if;

  insert into public.customers (
    user_id,
    business_name,
    company_name,
    contact_name,
    email,
    phone,
    tax_id,
    is_wholesale,
    wholesale_status,
    wholesale_customer_type,
    status,
    active,
    lead_status,
    source
  )
  values (
    p_portal_user_id,
    normalized_company,
    normalized_company,
    coalesce(nullif(trim(profile_row.full_name), ''), normalized_email, 'Cliente registrado'),
    normalized_email,
    normalized_phone,
    normalized_tax_id,
    false,
    'none',
    'new',
    case when confirmed then 'active' else 'pending_account' end,
    confirmed,
    'cliente',
    'portal_registration'
  )
  returning * into created_customer;

  outcome := jsonb_build_object(
    'ok', true,
    'code', 'PROFILE_CREATED',
    'message', 'El perfil comercial fue creado y vinculado correctamente.',
    'state', 'profile_created',
    'customerId', created_customer.id,
    'emailConfirmed', confirmed
  );

  insert into public.portal_customer_profile_syncs (
    portal_user_id, state, customer_id, candidate_count, matched_fields,
    registration_source, last_request_key, payload_hash, result, resolved_at, updated_at
  )
  values (
    p_portal_user_id, 'profile_created', created_customer.id, 0, array[]::text[],
    p_source, p_request_key, payload_hash_value, outcome, now(), now()
  )
  on conflict (portal_user_id) do update
  set state = excluded.state,
      customer_id = excluded.customer_id,
      candidate_customer_id = null,
      candidate_count = 0,
      matched_fields = array[]::text[],
      registration_source = excluded.registration_source,
      last_request_key = excluded.last_request_key,
      payload_hash = excluded.payload_hash,
      result = excluded.result,
      resolved_at = excluded.resolved_at,
      updated_at = now();

  select coalesce(bool_or(cs.notify_customer_account_created), true)
  into notify_registration
  from public.company_settings cs;

  if notify_registration then
    insert into public.internal_notifications (
      event_type,
      notification_type,
      module,
      customer_id,
      title,
      message,
      severity,
      audience_roles,
      status,
      read_state,
      metadata,
      dedupe_key,
      updated_at
    )
    values (
      'portal_customer_registered',
      'portal_customer_registered',
      'CRM',
      created_customer.id,
      case when confirmed then 'Nuevo cliente registrado' else 'Cuenta registrada — correo pendiente' end,
      case
        when confirmed then 'Una nueva cuenta pública creó su perfil comercial.'
        else 'Una nueva cuenta pública creó su perfil comercial y aún debe confirmar el correo.'
      end,
      'info',
      array['technical_owner', 'business_owner', 'admin']::text[],
      'open',
      'unread',
      jsonb_build_object(
        'action_path', '/admin/clientes?customerId=' || created_customer.id::text,
        'email_confirmed', confirmed
      ),
      'portal-customer-registered:' || p_portal_user_id::text,
      now()
    )
    on conflict do nothing;
  end if;

  insert into public.audit_logs (
    user_id, actor_role, table_name, record_id, action, new_data
  )
  values (
    p_actor_user_id,
    actor_role_name,
    'customers',
    created_customer.id,
    'portal_customer_profile.created',
    jsonb_build_object(
      'portal_user_id', p_portal_user_id,
      'source', p_source,
      'email_confirmed', confirmed,
      'wholesale_status', 'none',
      'credit_enabled', false,
      'reason', normalized_reason
    )
  );

  update public.portal_customer_profile_sync_requests
  set status = 'completed', result = outcome, completed_at = now(), updated_at = now()
  where request_key = p_request_key;

  return outcome;
exception
  when unique_violation then
    select *
    into linked_customer
    from public.customers
    where user_id = p_portal_user_id;

    if linked_customer.id is not null then
      outcome := jsonb_build_object(
        'ok', true,
        'code', 'ALREADY_LINKED',
        'message', 'La cuenta ya tiene un perfil comercial vinculado.',
        'state', 'already_linked',
        'customerId', linked_customer.id,
        'idempotentReplay', true
      );

      update public.portal_customer_profile_sync_requests
      set status = 'completed', result = outcome, completed_at = now(), updated_at = now()
      where request_key = p_request_key;

      return outcome;
    end if;

    raise;
  when others then
    outcome := jsonb_build_object(
      'ok', false,
      'code', 'SYNC_FAILED',
      'message', 'No se pudo completar la sincronización. El siguiente acceso puede reintentarla.',
      'state', 'failed'
    );

    insert into public.portal_customer_profile_sync_requests (
      request_key,
      operation,
      portal_user_id,
      source,
      payload_hash,
      status,
      result,
      actor_user_id,
      completed_at,
      updated_at
    )
    values (
      p_request_key,
      'ensure_profile',
      p_portal_user_id,
      p_source,
      coalesce(payload_hash_value, encode(extensions.digest(p_portal_user_id::text || '|' || p_source, 'sha256'), 'hex')),
      'failed',
      outcome,
      p_actor_user_id,
      now(),
      now()
    )
    on conflict (request_key) do update
    set status = 'failed',
        result = excluded.result,
        completed_at = excluded.completed_at,
        updated_at = now();

    if exists (select 1 from public.users where id = p_portal_user_id) then
      insert into public.portal_customer_profile_syncs (
        portal_user_id, state, registration_source, last_request_key, payload_hash, result, updated_at
      )
      values (
        p_portal_user_id,
        'failed',
        p_source,
        p_request_key,
        coalesce(payload_hash_value, encode(extensions.digest(p_portal_user_id::text || '|' || p_source, 'sha256'), 'hex')),
        outcome,
        now()
      )
      on conflict (portal_user_id) do update
      set state = excluded.state,
          registration_source = excluded.registration_source,
          last_request_key = excluded.last_request_key,
          payload_hash = excluded.payload_hash,
          result = excluded.result,
          updated_at = now();

      insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
      values (
        p_actor_user_id,
        actor_role_name,
        'portal_customer_profile_syncs',
        p_portal_user_id,
        'portal_customer_profile.failed',
        jsonb_build_object('source', p_source, 'sqlstate', sqlstate)
      );
    end if;

    return outcome;
end;
$$;

create or replace function public.ensure_my_portal_customer_profile_v1(
  p_source text,
  p_request_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  result jsonb;
begin
  if actor_id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'AUTH_REQUIRED',
      'message', 'Debes iniciar sesión para recuperar tu perfil comercial.'
    );
  end if;

  if p_source not in ('callback', 'login', 'checkout_recovery') then
    return jsonb_build_object(
      'ok', false,
      'code', 'INVALID_SOURCE',
      'message', 'El origen de sincronización no es válido.'
    );
  end if;

  result := public.ensure_portal_customer_profile_core_v1(
    actor_id,
    p_source,
    p_request_key,
    actor_id,
    null,
    null,
    false
  );

  return result - 'candidateCustomerId';
end;
$$;

create or replace function public.ensure_portal_customer_profile_internal_v1(
  p_portal_user_id uuid,
  p_source text,
  p_request_key uuid
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.ensure_portal_customer_profile_core_v1(
    p_portal_user_id,
    p_source,
    p_request_key,
    null,
    null,
    null,
    false
  );
$$;

create or replace function public.ensure_admin_portal_customer_profile_v1(
  p_portal_user_id uuid,
  p_request_key uuid,
  p_expected_state text,
  p_reason text
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.ensure_portal_customer_profile_core_v1(
    p_portal_user_id,
    'admin_recovery',
    p_request_key,
    auth.uid(),
    p_expected_state,
    p_reason,
    true
  );
$$;

create or replace function public.preview_admin_portal_customer_profile_v1(
  p_portal_user_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  profile_row record;
  auth_row record;
  sync_state text;
  linked_customer_id uuid;
  candidate_ids uuid[] := '{}'::uuid[];
  normalized_email text;
  normalized_phone text;
  normalized_tax_id text;
  expected_state text;
  recommended_outcome text;
begin
  if auth.uid() is null
    or public.current_actor_role() not in ('technical_owner', 'business_owner', 'admin')
    or not (
      public.has_permission('customers:manage')
      or public.has_permission('customers:link_portal_account')
    )
  then
    return jsonb_build_object(
      'ok', false,
      'code', 'PERMISSION_DENIED',
      'message', 'No tienes permiso para revisar recuperaciones de perfiles.'
    );
  end if;

  select u.id, u.email, u.phone, u.active, r.name as role_name
  into profile_row
  from public.users u
  left join public.roles r on r.id = u.role_id
  where u.id = p_portal_user_id;

  select au.id, au.email, au.email_confirmed_at, au.confirmed_at, au.raw_user_meta_data
  into auth_row
  from auth.users au
  where au.id = p_portal_user_id;

  select s.state
  into sync_state
  from public.portal_customer_profile_syncs s
  where s.portal_user_id = p_portal_user_id;

  select c.id
  into linked_customer_id
  from public.customers c
  where c.user_id = p_portal_user_id;

  expected_state := coalesce(
    sync_state,
    case when linked_customer_id is not null then 'already_linked' else 'unresolved' end
  );

  if profile_row.id is null or auth_row.id is null or profile_row.role_name is null then
    recommended_outcome := 'invalid_account';
  elsif profile_row.role_name <> 'cliente' then
    recommended_outcome := 'internal_user_ignored';
  elsif not coalesce(profile_row.active, false) then
    recommended_outcome := 'inactive_account';
  elsif linked_customer_id is not null then
    recommended_outcome := 'already_linked';
  else
    normalized_email := public.normalize_portal_customer_email(coalesce(auth_row.email, profile_row.email));
    normalized_phone := public.normalize_portal_customer_phone(
      coalesce(nullif(profile_row.phone, ''), auth_row.raw_user_meta_data->>'phone')
    );
    normalized_tax_id := public.normalize_portal_customer_tax_id(
      coalesce(auth_row.raw_user_meta_data->>'tax_id', auth_row.raw_user_meta_data->>'rtn')
    );

    select coalesce(array_agg(distinct c.id order by c.id), '{}'::uuid[])
    into candidate_ids
    from public.customers c
    where
      (
        normalized_email is not null
        and public.normalize_portal_customer_email(c.email) = normalized_email
      )
      or (
        normalized_phone is not null
        and public.normalize_portal_customer_phone(c.phone) = normalized_phone
      )
      or (
        normalized_tax_id is not null
        and public.normalize_portal_customer_tax_id(c.tax_id) = normalized_tax_id
      );

    recommended_outcome := case
      when coalesce(array_length(candidate_ids, 1), 0) > 0 then 'review_required'
      else 'profile_created'
    end;
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', 'PREVIEW_READY',
    'expectedState', expected_state,
    'recommendedOutcome', recommended_outcome,
    'role', profile_row.role_name,
    'accountActive', coalesce(profile_row.active, false),
    'emailConfirmed', auth_row.email_confirmed_at is not null or auth_row.confirmed_at is not null,
    'linkedCustomerId', linked_customer_id,
    'candidateCount', coalesce(array_length(candidate_ids, 1), 0),
    'candidateCustomerId', candidate_ids[1]
  );
end;
$$;

create or replace function public.search_admin_crm_customer_ids_v1(
  p_query text default '',
  p_filter text default 'clients',
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  customer_id uuid,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_query text := public.normalize_portal_customer_search(p_query);
  normalized_filter text := lower(trim(coalesce(p_filter, 'clients')));
  actor_role_name text := public.current_actor_role();
begin
  if auth.uid() is null
    or not (
      public.has_permission('crm:manage')
      or public.has_permission('customers:manage')
    )
  then
    raise exception using
      errcode = '42501',
      message = 'No tienes permiso para buscar clientes.';
  end if;

  if normalized_filter not in (
    'clients',
    'internal',
    'all',
    'active',
    'prospects',
    'wholesale',
    'wholesale_requests',
    'suspended'
  ) then
    normalized_filter := 'clients';
  end if;

  return query
  with visible as (
    select
      c.id,
      c.created_at,
      coalesce(r.name, 'cliente') as account_role,
      coalesce(u.active, true) as account_active,
      public.normalize_portal_customer_search(concat_ws(
        ' ',
        c.contact_name,
        c.business_name,
        c.company_name,
        c.email,
        c.phone,
        c.tax_id,
        u.full_name,
        u.email,
        u.phone
      )) as search_text
    from public.customers c
    left join public.users u on u.id = c.user_id
    left join public.roles r on r.id = u.role_id
    where
      (
        actor_role_name in ('technical_owner', 'business_owner', 'admin')
        or coalesce(r.name, 'cliente') = 'cliente'
      )
      and (
        normalized_query = ''
        or public.normalize_portal_customer_search(concat_ws(
          ' ',
          c.contact_name,
          c.business_name,
          c.company_name,
          c.email,
          c.phone,
          c.tax_id,
          u.full_name,
          u.email,
          u.phone
        )) like '%' || normalized_query || '%'
        or (
          public.normalize_portal_customer_phone(normalized_query) is not null
          and public.normalize_portal_customer_phone(coalesce(u.phone, c.phone)) =
            public.normalize_portal_customer_phone(normalized_query)
        )
      )
      and case normalized_filter
        when 'clients' then coalesce(r.name, 'cliente') = 'cliente'
        when 'internal' then coalesce(r.name, 'cliente') <> 'cliente'
        when 'all' then true
        when 'active' then
          coalesce(r.name, 'cliente') = 'cliente'
          and c.status = 'active'
          and c.active
          and coalesce(u.active, true)
        when 'prospects' then
          coalesce(r.name, 'cliente') = 'cliente'
          and c.lead_status <> 'cliente'
          and c.wholesale_status <> 'pending'
        when 'wholesale' then
          coalesce(r.name, 'cliente') = 'cliente'
          and c.is_wholesale
          and c.wholesale_status = 'approved'
        when 'wholesale_requests' then
          coalesce(r.name, 'cliente') = 'cliente'
          and not c.is_wholesale
          and c.wholesale_status = 'pending'
        when 'suspended' then
          c.status in ('inactive', 'disabled')
          or not coalesce(u.active, true)
        else true
      end
  )
  select
    visible.id,
    count(*) over () as total_count
  from visible
  order by visible.created_at desc, visible.id
  limit greatest(1, least(coalesce(p_limit, 20), 100))
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.normalize_portal_customer_email(text) from public;
revoke all on function public.normalize_portal_customer_phone(text) from public;
revoke all on function public.normalize_portal_customer_tax_id(text) from public;
revoke all on function public.normalize_portal_customer_search(text) from public;
revoke all on function public.ensure_portal_customer_profile_core_v1(uuid, text, uuid, uuid, text, text, boolean) from public;
revoke all on function public.ensure_my_portal_customer_profile_v1(text, uuid) from public;
revoke all on function public.ensure_portal_customer_profile_internal_v1(uuid, text, uuid) from public;
revoke all on function public.ensure_admin_portal_customer_profile_v1(uuid, uuid, text, text) from public;
revoke all on function public.preview_admin_portal_customer_profile_v1(uuid) from public;
revoke all on function public.search_admin_crm_customer_ids_v1(text, text, integer, integer) from public;

grant execute on function public.ensure_my_portal_customer_profile_v1(text, uuid) to authenticated;
grant execute on function public.ensure_portal_customer_profile_internal_v1(uuid, text, uuid) to service_role;
grant execute on function public.ensure_admin_portal_customer_profile_v1(uuid, uuid, text, text) to authenticated;
grant execute on function public.preview_admin_portal_customer_profile_v1(uuid) to authenticated;
grant execute on function public.search_admin_crm_customer_ids_v1(text, text, integer, integer) to authenticated;

comment on function public.ensure_portal_customer_profile_core_v1(uuid, text, uuid, uuid, text, text, boolean) is
  'Private canonical profile synchronization core. Never accepts execution from browser roles.';
comment on function public.ensure_my_portal_customer_profile_v1(text, uuid) is
  'Authenticated self-service recovery. Identity is always derived from auth.uid().';
comment on function public.ensure_admin_portal_customer_profile_v1(uuid, uuid, text, text) is
  'Explicit administrative recovery with permission, expected-state and reason checks.';
