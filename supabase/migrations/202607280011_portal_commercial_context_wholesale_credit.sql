-- Portal commercial context, secure account linking and catalog privacy.
-- This migration creates contracts only. It performs no customer backfill,
-- portal link, wholesale approval, credit change, order, inventory or
-- accounting write.

-- The urgent portal-link contract is intentionally narrower than the legacy
-- manual contract. Accountants do not administer authentication identities.
update public.roles
set permissions = permissions - 'customers:link_portal_account',
    updated_at = now()
where name = 'contadora';

create table public.customer_portal_link_idempotency_requests (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  operation text not null check (operation = 'link_customer_portal_account_v2'),
  actor_user_id uuid not null references public.users(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  portal_user_id uuid not null references public.users(id) on delete restrict,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'processing' check (status in ('processing', 'succeeded')),
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  check (
    (status = 'processing' and result is null and completed_at is null)
    or (status = 'succeeded' and result is not null and completed_at is not null)
  )
);

create index customer_portal_link_idempotency_customer_created_idx
  on public.customer_portal_link_idempotency_requests(customer_id, created_at desc);

alter table public.customer_portal_link_idempotency_requests enable row level security;

create policy "Technical staff can read portal link idempotency"
  on public.customer_portal_link_idempotency_requests for select
  using (
    public.current_actor_role() = 'technical_owner'
    and public.has_permission('technical:tools')
  );

grant select on public.customer_portal_link_idempotency_requests to authenticated;
grant select, insert, update on public.customer_portal_link_idempotency_requests to service_role;

create table public.customer_portal_link_history (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  portal_user_id uuid not null references public.users(id) on delete restrict,
  actor_user_id uuid not null references public.users(id) on delete restrict,
  actor_role text not null check (actor_role in ('technical_owner', 'business_owner', 'admin')),
  evidence_source text not null check (
    evidence_source in (
      'authenticated_wholesale_request',
      'authenticated_portal_registration',
      'manual_verified_identity'
    )
  ),
  evidence_reference_hash text not null check (evidence_reference_hash ~ '^[0-9a-f]{64}$'),
  reason text not null check (char_length(reason) between 10 and 500),
  previous_commercial_version integer not null check (previous_commercial_version >= 0),
  new_commercial_version integer not null check (new_commercial_version = previous_commercial_version + 1),
  request_key uuid not null unique,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  contact_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index customer_portal_link_history_customer_created_idx
  on public.customer_portal_link_history(customer_id, created_at desc);

alter table public.customer_portal_link_history enable row level security;

create policy "Authorized staff can read portal link history"
  on public.customer_portal_link_history for select
  using (
    public.current_actor_role() in ('technical_owner', 'business_owner', 'admin')
    and public.has_permission('customers:link_portal_account')
  );

grant select on public.customer_portal_link_history to authenticated;
grant select, insert on public.customer_portal_link_history to service_role;

create or replace function public.prevent_customer_portal_link_history_mutation_v1()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception using errcode = '42501', message = 'PORTAL_LINK_HISTORY_APPEND_ONLY';
end;
$$;

create trigger prevent_customer_portal_link_history_mutation_trigger
before update or delete on public.customer_portal_link_history
for each row execute function public.prevent_customer_portal_link_history_mutation_v1();

create or replace function public.link_customer_portal_account_v2(
  p_request_key uuid,
  p_customer_id uuid,
  p_portal_user_id uuid,
  p_expected_commercial_version integer,
  p_evidence_source text,
  p_evidence_reference text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text;
  normalized_evidence_source text := lower(trim(coalesce(p_evidence_source, '')));
  normalized_evidence_reference text := nullif(trim(coalesce(p_evidence_reference, '')), '');
  normalized_reason text := nullif(trim(coalesce(p_reason, '')), '');
  payload_hash_value text;
  evidence_reference_hash_value text;
  idempotency_record public.customer_portal_link_idempotency_requests%rowtype;
  customer_record public.customers%rowtype;
  saved_customer public.customers%rowtype;
  portal_user_record public.users%rowtype;
  portal_role_name text;
  conflicting_customer_id uuid;
  audit_evidence_exists boolean := false;
  note_evidence_exists boolean := false;
  approval_evidence_exists boolean := false;
  registration_evidence_exists boolean := false;
  email_match boolean := false;
  phone_match boolean := false;
  response_payload jsonb;
begin
  if actor_id is null then
    raise exception using errcode = '42501', message = 'PORTAL_LINK_FORBIDDEN';
  end if;

  select r.name
  into actor_role_name
  from public.users u
  join public.roles r on r.id = u.role_id
  where u.id = actor_id
    and u.active;

  if actor_role_name is null
     or actor_role_name not in ('technical_owner', 'business_owner', 'admin')
     or coalesce(not public.has_permission('customers:link_portal_account'), true) then
    raise exception using errcode = '42501', message = 'PORTAL_LINK_FORBIDDEN';
  end if;

  if p_request_key is null
     or p_customer_id is null
     or p_portal_user_id is null
     or p_expected_commercial_version is null
     or normalized_evidence_reference is null
     or normalized_reason is null then
    raise exception using errcode = '22023', message = 'PORTAL_LINK_EVIDENCE_INVALID';
  end if;

  if normalized_evidence_source not in (
    'authenticated_wholesale_request',
    'authenticated_portal_registration',
    'manual_verified_identity'
  ) then
    raise exception using errcode = '22023', message = 'PORTAL_LINK_EVIDENCE_INVALID';
  end if;

  if char_length(normalized_evidence_reference) < 6
     or char_length(normalized_evidence_reference) > 180
     or normalized_evidence_reference !~ '^[A-Za-z0-9:#._/-]+$'
     or char_length(normalized_reason) < 10
     or char_length(normalized_reason) > 500 then
    raise exception using errcode = '22023', message = 'PORTAL_LINK_EVIDENCE_INVALID';
  end if;

  payload_hash_value := encode(
    extensions.digest(
      convert_to(jsonb_build_object(
        'customer_id', p_customer_id,
        'portal_user_id', p_portal_user_id,
        'expected_commercial_version', p_expected_commercial_version,
        'evidence_source', normalized_evidence_source,
        'evidence_reference', normalized_evidence_reference,
        'reason', normalized_reason
      )::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );

  evidence_reference_hash_value := encode(
    extensions.digest(convert_to(normalized_evidence_reference, 'UTF8'), 'sha256'),
    'hex'
  );

  insert into public.customer_portal_link_idempotency_requests (
    request_key,
    operation,
    actor_user_id,
    customer_id,
    portal_user_id,
    payload_hash
  )
  values (
    p_request_key,
    'link_customer_portal_account_v2',
    actor_id,
    p_customer_id,
    p_portal_user_id,
    payload_hash_value
  )
  on conflict (request_key) do nothing;

  select *
  into idempotency_record
  from public.customer_portal_link_idempotency_requests
  where request_key = p_request_key
  for update;

  if idempotency_record.operation <> 'link_customer_portal_account_v2'
     or idempotency_record.payload_hash <> payload_hash_value
     or idempotency_record.customer_id <> p_customer_id
     or idempotency_record.portal_user_id <> p_portal_user_id then
    raise exception using errcode = 'PT409', message = 'PORTAL_LINK_IDEMPOTENCY_CONFLICT';
  end if;

  if idempotency_record.status = 'succeeded' then
    return idempotency_record.result || jsonb_build_object('idempotentReplay', true);
  end if;

  perform pg_advisory_xact_lock(hashtextextended('portal-link-customer:' || p_customer_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('portal-link-account:' || p_portal_user_id::text, 0));

  select *
  into customer_record
  from public.customers
  where id = p_customer_id
  for update;

  if customer_record.id is null then
    raise exception using errcode = 'P0002', message = 'PORTAL_LINK_CUSTOMER_NOT_FOUND';
  end if;

  if not customer_record.active or customer_record.status <> 'active' then
    raise exception using errcode = '22023', message = 'PORTAL_LINK_CUSTOMER_INACTIVE';
  end if;

  if customer_record.user_id = p_portal_user_id then
    response_payload := jsonb_build_object(
      'ok', true,
      'code', 'PORTAL_LINK_ALREADY_EXISTS',
      'previousCommercialVersion', customer_record.commercial_version,
      'commercialVersion', customer_record.commercial_version,
      'idempotentReplay', false
    );

    update public.customer_portal_link_idempotency_requests
    set status = 'succeeded',
        result = response_payload,
        completed_at = now(),
        updated_at = now()
    where request_key = p_request_key;

    return response_payload;
  end if;

  if customer_record.user_id is not null then
    raise exception using errcode = 'PT409', message = 'PORTAL_LINK_CUSTOMER_CONFLICT';
  end if;

  if customer_record.commercial_version <> p_expected_commercial_version then
    raise exception using
      errcode = 'PT409',
      message = 'PORTAL_LINK_VERSION_CONFLICT:' || customer_record.commercial_version::text;
  end if;

  select u.*
  into portal_user_record
  from public.users u
  where u.id = p_portal_user_id
  for update;

  select r.name
  into portal_role_name
  from public.roles r
  where r.id = portal_user_record.role_id;

  if portal_user_record.id is null
     or not portal_user_record.active
     or not exists (
       select 1
       from auth.users au
       where au.id = p_portal_user_id
         and au.deleted_at is null
     ) then
    raise exception using errcode = '22023', message = 'PORTAL_LINK_ACCOUNT_INACTIVE';
  end if;

  if portal_role_name is distinct from 'cliente' then
    raise exception using errcode = '22023', message = 'PORTAL_LINK_ROLE_INVALID';
  end if;

  select c.id
  into conflicting_customer_id
  from public.customers c
  where c.user_id = p_portal_user_id
    and c.id <> p_customer_id
  limit 1
  for update;

  if conflicting_customer_id is not null then
    raise exception using errcode = 'PT409', message = 'PORTAL_LINK_ACCOUNT_CONFLICT';
  end if;

  email_match :=
    public.normalize_pos_customer_email_v1(customer_record.email)
    is not distinct from
    public.normalize_pos_customer_email_v1(portal_user_record.email)
    and public.normalize_pos_customer_email_v1(customer_record.email) is not null;

  phone_match :=
    public.normalize_pos_customer_phone_v1(customer_record.phone)
    is not distinct from
    public.normalize_pos_customer_phone_v1(portal_user_record.phone)
    and public.normalize_pos_customer_phone_v1(customer_record.phone) is not null;

  if normalized_evidence_source = 'authenticated_wholesale_request' then
    select exists (
      select 1
      from public.audit_logs a
      where a.table_name = 'customers'
        and a.record_id = p_customer_id
        and a.user_id = p_portal_user_id
        and normalized_evidence_reference = 'audit:' || a.id::text
        and a.action = 'wholesale_request.created_from_account'
    )
    into audit_evidence_exists;

    select exists (
      select 1
      from public.crm_notes n
      where n.customer_id = p_customer_id
        and n.user_id = p_portal_user_id
        and n.note_type = 'wholesale_status'
        and n.note = 'Solicitud mayorista enviada desde cuenta registrada.'
    )
    into note_evidence_exists;

    select (
      customer_record.wholesale_status <> 'approved'
      or exists (
        select 1
        from public.wholesale_access_history h
        where h.customer_id = p_customer_id
          and h.source = 'customer_request'
          and h.had_pending_request
          and h.new_status = 'approved'
      )
    )
    into approval_evidence_exists;

    if not audit_evidence_exists
       or not note_evidence_exists
       or not approval_evidence_exists then
      raise exception using errcode = '22023', message = 'PORTAL_LINK_EVIDENCE_INVALID';
    end if;
  elsif normalized_evidence_source = 'authenticated_portal_registration' then
    select exists (
      select 1
      from public.audit_logs a
      where a.table_name = 'customers'
        and a.record_id = p_customer_id
        and a.user_id = p_portal_user_id
        and normalized_evidence_reference = 'audit:' || a.id::text
        and a.action in (
          'customer_portal_registration.created',
          'auth.registration.customer_evidence'
        )
    )
    into registration_evidence_exists;

    if not registration_evidence_exists then
      raise exception using errcode = '22023', message = 'PORTAL_LINK_EVIDENCE_INVALID';
    end if;
  elsif normalized_evidence_source = 'manual_verified_identity' then
    if char_length(normalized_reason) < 20
       or normalized_evidence_reference !~ '^manual:[0-9a-f-]{36}:[0-9a-f-]{36}$'
       or normalized_evidence_reference <> (
         'manual:' || p_customer_id::text || ':' || p_portal_user_id::text
       ) then
      raise exception using errcode = '22023', message = 'PORTAL_LINK_EVIDENCE_INVALID';
    end if;
  end if;

  update public.customers
  set user_id = p_portal_user_id,
      updated_at = now()
  where id = p_customer_id
    and user_id is null
    and commercial_version = p_expected_commercial_version
  returning * into saved_customer;

  if saved_customer.id is null then
    raise exception using errcode = 'PT409', message = 'PORTAL_LINK_VERSION_CONFLICT';
  end if;

  if saved_customer.commercial_version <> customer_record.commercial_version + 1 then
    raise exception using errcode = 'P0001', message = 'PORTAL_LINK_INTERNAL_ERROR';
  end if;

  insert into public.customer_portal_link_history (
    customer_id,
    portal_user_id,
    actor_user_id,
    actor_role,
    evidence_source,
    evidence_reference_hash,
    reason,
    previous_commercial_version,
    new_commercial_version,
    request_key,
    payload_hash,
    contact_evidence
  )
  values (
    p_customer_id,
    p_portal_user_id,
    actor_id,
    actor_role_name,
    normalized_evidence_source,
    evidence_reference_hash_value,
    normalized_reason,
    customer_record.commercial_version,
    saved_customer.commercial_version,
    p_request_key,
    payload_hash_value,
    jsonb_build_object(
      'emailMatched', email_match,
      'phoneMatched', phone_match,
      'usedAsAuthority', false
    )
  );

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    old_data,
    new_data
  )
  values (
    actor_id,
    actor_role_name,
    'customers',
    p_customer_id,
    'customer_portal_link.linked_v2',
    jsonb_build_object(
      'linked', false,
      'commercial_version', customer_record.commercial_version
    ),
    jsonb_build_object(
      'linked', true,
      'portal_account_fingerprint', left(encode(
        extensions.digest(convert_to(p_portal_user_id::text, 'UTF8'), 'sha256'),
        'hex'
      ), 16),
      'evidence_source', normalized_evidence_source,
      'evidence_reference_hash', evidence_reference_hash_value,
      'email_matched', email_match,
      'phone_matched', phone_match,
      'contact_match_used_as_authority', false,
      'commercial_version', saved_customer.commercial_version,
      'request_key', p_request_key
    )
  );

  response_payload := jsonb_build_object(
    'ok', true,
    'code', 'PORTAL_LINK_COMPLETED',
    'previousCommercialVersion', customer_record.commercial_version,
    'commercialVersion', saved_customer.commercial_version,
    'idempotentReplay', false
  );

  update public.customer_portal_link_idempotency_requests
  set status = 'succeeded',
      result = response_payload,
      completed_at = now(),
      updated_at = now()
  where request_key = p_request_key;

  return response_payload;
exception
  when unique_violation then
    raise exception using errcode = 'PT409', message = 'PORTAL_LINK_ACCOUNT_CONFLICT';
end;
$$;

revoke all on function public.link_customer_portal_account_v2(
  uuid, uuid, uuid, integer, text, text, text
) from public, anon;
grant execute on function public.link_customer_portal_account_v2(
  uuid, uuid, uuid, integer, text, text, text
) to authenticated;

comment on function public.link_customer_portal_account_v2(
  uuid, uuid, uuid, integer, text, text, text
) is
  'CAS/idempotent one-to-one portal link. Requires authenticated structured evidence and writes sanitized append-only history.';

create or replace function public.resolve_portal_commercial_context_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  portal_user_id uuid := auth.uid();
  portal_account_active boolean := false;
  portal_role_name text;
  customer_record public.customers%rowtype;
  minimum_amount numeric(12,2) := 0;
  first_purchase_completed boolean := false;
  first_purchase_required boolean := false;
  accumulated_wholesale numeric(12,2) := 0;
  effective_price_mode text := 'retail';
  credit_account_count integer := 0;
  credit_account_id uuid;
  credit_record public.customer_credit_accounts%rowtype;
  used_credit numeric(12,2) := 0;
  overdue_balance numeric(12,2) := 0;
  available_credit numeric(12,2) := 0;
  credit_usable boolean := false;
  block_codes text[] := array[]::text[];
  warning_codes text[] := array[]::text[];
  exact_request_evidence boolean := false;
  context_token text;
begin
  select round(coalesce(cs.first_wholesale_minimum, 10000), 2)
  into minimum_amount
  from public.company_settings cs
  order by cs.created_at
  limit 1;
  minimum_amount := greatest(coalesce(minimum_amount, 10000), 0);

  if portal_user_id is null then
    return jsonb_build_object(
      'authenticated', false,
      'accountActive', false,
      'linked', false,
      'customerId', null,
      'commercialVersion', null,
      'customerActive', false,
      'effectivePriceMode', 'retail',
      'wholesaleStatus', 'none',
      'wholesaleCustomerType', null,
      'firstPurchaseRequired', false,
      'firstPurchaseMinimum', minimum_amount,
      'firstPurchaseCompleted', false,
      'firstPurchaseAccumulated', 0,
      'creditAccountExists', false,
      'creditEnabled', false,
      'creditStatus', null,
      'creditLimit', null,
      'creditUsed', null,
      'creditAvailable', null,
      'creditTermsDays', null,
      'overdueBalance', null,
      'creditUsable', false,
      'blockCodes', jsonb_build_array(),
      'warningCodes', jsonb_build_array(),
      'pendingLinkEvidence', false,
      'contextToken', null,
      'serverTimestamp', now()
    );
  end if;

  select u.active, r.name
  into portal_account_active, portal_role_name
  from public.users u
  left join public.roles r on r.id = u.role_id
  where u.id = portal_user_id;

  portal_account_active := coalesce(portal_account_active, false)
    and portal_role_name = 'cliente'
    and exists (
      select 1 from auth.users au
      where au.id = portal_user_id and au.deleted_at is null
    );

  if not portal_account_active then
    block_codes := array_append(block_codes, 'PORTAL_ACCOUNT_INACTIVE');
  end if;

  select *
  into customer_record
  from public.customers c
  where c.user_id = portal_user_id
  limit 1;

  if customer_record.id is null then
    select exists (
      select 1
      from public.audit_logs a
      join public.crm_notes n
        on n.customer_id = a.record_id
       and n.user_id = a.user_id
       and n.note_type = 'wholesale_status'
       and n.note = 'Solicitud mayorista enviada desde cuenta registrada.'
      where a.user_id = portal_user_id
        and a.table_name = 'customers'
        and a.action = 'wholesale_request.created_from_account'
        and not exists (
          select 1 from public.customers linked
          where linked.user_id = portal_user_id
        )
    )
    into exact_request_evidence;

    block_codes := array_append(block_codes, 'PORTAL_ACCOUNT_NOT_LINKED');

    return jsonb_build_object(
      'authenticated', true,
      'accountActive', portal_account_active,
      'linked', false,
      'customerId', null,
      'commercialVersion', null,
      'customerActive', false,
      'effectivePriceMode', 'retail',
      'wholesaleStatus', 'none',
      'wholesaleCustomerType', null,
      'firstPurchaseRequired', false,
      'firstPurchaseMinimum', minimum_amount,
      'firstPurchaseCompleted', false,
      'firstPurchaseAccumulated', 0,
      'creditAccountExists', false,
      'creditEnabled', false,
      'creditStatus', null,
      'creditLimit', null,
      'creditUsed', null,
      'creditAvailable', null,
      'creditTermsDays', null,
      'overdueBalance', null,
      'creditUsable', false,
      'blockCodes', to_jsonb(block_codes),
      'warningCodes', jsonb_build_array(),
      'pendingLinkEvidence', exact_request_evidence,
      'contextToken', encode(extensions.digest(
        convert_to(portal_user_id::text || ':unlinked', 'UTF8'), 'sha256'
      ), 'hex'),
      'serverTimestamp', now()
    );
  end if;

  if not customer_record.active or customer_record.status <> 'active' then
    block_codes := array_append(block_codes, 'CUSTOMER_INACTIVE');
  end if;

  if portal_account_active
     and customer_record.active
     and customer_record.status = 'active'
     and customer_record.is_wholesale
     and customer_record.wholesale_status = 'approved' then
    effective_price_mode := 'wholesale';
  else
    effective_price_mode := 'retail';
  end if;

  if effective_price_mode <> 'wholesale' then
    block_codes := array_append(block_codes, 'WHOLESALE_NOT_AVAILABLE');
  end if;

  first_purchase_required :=
    customer_record.wholesale_customer_type = 'new'
    and not customer_record.wholesale_first_purchase_completed;

  select coalesce(sum(o.total), 0)
  into accumulated_wholesale
  from public.orders o
  where o.customer_id = customer_record.id
    and o.price_mode = 'wholesale'
    and o.status::text not in ('cancelado', 'cancelled');

  first_purchase_completed :=
    customer_record.wholesale_customer_type = 'existing'
    or customer_record.wholesale_first_purchase_completed
    or exists (
      select 1
      from public.orders o
      where o.customer_id = customer_record.id
        and o.price_mode = 'wholesale'
        and o.status::text not in ('cancelado', 'cancelled')
        and (
          minimum_amount <= 0
          or coalesce(o.total, o.subtotal, 0) >= minimum_amount
        )
    );
  first_purchase_required :=
    customer_record.wholesale_customer_type = 'new'
    and not first_purchase_completed;


  select count(*)::integer, min(a.id::text)::uuid
  into credit_account_count, credit_account_id
  from public.customer_credit_accounts a
  where a.customer_id = customer_record.id;

  if credit_account_count = 1 then
    select *
    into credit_record
    from public.customer_credit_accounts a
    where a.id = credit_account_id;

    select
      coalesce(sum(r.balance_due) filter (
        where r.status in ('open', 'partial', 'overdue')
      ), 0),
      coalesce(sum(r.balance_due) filter (
        where r.status = 'overdue'
          or (
            r.status in ('open', 'partial')
            and r.due_date < current_date
          )
      ), 0)
    into used_credit, overdue_balance
    from public.accounts_receivable r
    where r.customer_id = customer_record.id;

    available_credit := greatest(round(credit_record.credit_limit - used_credit, 2), 0);
    credit_usable :=
      portal_account_active
      and customer_record.active
      and customer_record.status = 'active'
      and credit_record.is_credit_enabled
      and credit_record.status = 'active';

    if not credit_record.is_credit_enabled then
      block_codes := array_append(block_codes, 'CREDIT_DISABLED');
    elsif credit_record.status <> 'active' then
      block_codes := array_append(block_codes, 'CREDIT_SUSPENDED');
    end if;

    if overdue_balance > 0 then
      warning_codes := array_append(warning_codes, 'CREDIT_OVERDUE_WARNING');
    end if;
  elsif credit_account_count = 0 then
    block_codes := array_append(block_codes, 'CREDIT_ACCOUNT_NOT_FOUND');
  else
    block_codes := array_append(block_codes, 'CREDIT_ACCOUNT_CONFLICT');
  end if;

  context_token := encode(
    extensions.digest(
      convert_to(
        portal_user_id::text
        || ':' || customer_record.id::text
        || ':' || customer_record.commercial_version::text
        || ':' || effective_price_mode,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  return jsonb_build_object(
    'authenticated', true,
    'accountActive', portal_account_active,
    'linked', true,
    'customerId', customer_record.id,
    'commercialVersion', customer_record.commercial_version,
    'customerActive', customer_record.active and customer_record.status = 'active',
    'effectivePriceMode', effective_price_mode,
    'wholesaleStatus', coalesce(customer_record.wholesale_status, 'none'),
    'wholesaleCustomerType', customer_record.wholesale_customer_type,
    'firstPurchaseRequired', first_purchase_required,
    'firstPurchaseMinimum', minimum_amount,
    'firstPurchaseCompleted', first_purchase_completed,
    'firstPurchaseAccumulated', round(accumulated_wholesale, 2),
    'creditAccountExists', credit_account_count > 0,
    'creditEnabled', case when credit_account_count = 1 then credit_record.is_credit_enabled else false end,
    'creditStatus', case when credit_account_count = 1 then credit_record.status else null end,
    'creditLimit', case when credit_account_count = 1 then credit_record.credit_limit else null end,
    'creditUsed', case when credit_account_count = 1 then round(used_credit, 2) else null end,
    'creditAvailable', case when credit_account_count = 1 then available_credit else null end,
    'creditTermsDays', case when credit_account_count = 1 then credit_record.terms_days else null end,
    'overdueBalance', case when credit_account_count = 1 then round(overdue_balance, 2) else null end,
    'creditUsable', credit_usable,
    'blockCodes', to_jsonb(block_codes),
    'warningCodes', to_jsonb(warning_codes),
    'pendingLinkEvidence', false,
    'contextToken', context_token,
    'serverTimestamp', now()
  );
end;
$$;

revoke all on function public.resolve_portal_commercial_context_v1() from public;
grant execute on function public.resolve_portal_commercial_context_v1() to anon, authenticated, service_role;

comment on function public.resolve_portal_commercial_context_v1() is
  'Single sanitized portal authority derived from auth.uid(). Wholesale and credit remain independent benefits.';

-- Public catalog DTOs never contain wholesale_price. The portal DTO exposes
-- only an effective price derived from auth.uid(), never a client-provided flag.
drop view if exists public.public_catalog_products_v2;

create view public.public_catalog_products_v2
with (security_barrier = true)
as
select
  p.id,
  p.category_id,
  c.name as category_name,
  c.slug as category_slug,
  p.sku,
  p.internal_code,
  p.slug,
  p.name,
  p.brand,
  p.vehicle_brand,
  p.vehicle_model,
  p.vehicle_year_start,
  p.vehicle_year_end,
  p.short_description,
  p.description,
  p.features,
  p.specifications,
  p.compatibility_notes,
  p.available_stock,
  p.retail_price,
  p.is_new,
  p.updated_at
from public.products p
left join public.categories c on c.id = p.category_id
where p.active = true
  and p.status = 'active';

revoke all on public.public_catalog_products_v2 from public;
grant select on public.public_catalog_products_v2 to anon, authenticated, service_role;

drop view if exists public.portal_catalog_products_v1;

create view public.portal_catalog_products_v1
with (security_barrier = true)
as
with portal_access as (
  select exists (
    select 1
    from public.users u
    join public.roles r on r.id = u.role_id
    join public.customers customer on customer.user_id = u.id
    where u.id = auth.uid()
      and u.active
      and r.name = 'cliente'
      and customer.active
      and customer.status = 'active'
      and customer.is_wholesale
      and customer.wholesale_status = 'approved'
  ) as wholesale_allowed
)
select
  p.id,
  p.category_id,
  c.name as category_name,
  c.slug as category_slug,
  p.sku,
  p.internal_code,
  p.slug,
  p.name,
  p.brand,
  p.vehicle_brand,
  p.vehicle_model,
  p.vehicle_year_start,
  p.vehicle_year_end,
  p.short_description,
  p.description,
  p.features,
  p.specifications,
  p.compatibility_notes,
  p.available_stock,
  p.retail_price,
  case
    when portal_access.wholesale_allowed then p.wholesale_price
    else p.retail_price
  end as effective_price,
  case
    when portal_access.wholesale_allowed then 'wholesale'::text
    else 'retail'::text
  end as effective_price_mode,
  case
    when portal_access.wholesale_allowed then p.wholesale_min_quantity
    else 1
  end as effective_min_quantity,
  p.is_new,
  p.updated_at
from public.products p
cross join portal_access
left join public.categories c on c.id = p.category_id
where p.active = true
  and p.status = 'active';

revoke all on public.portal_catalog_products_v1 from public;
grant select on public.portal_catalog_products_v1 to anon, authenticated, service_role;

-- Replace the vulnerable v1 DTO. Keeping the name preserves harmless public
-- consumers, but the wholesale column is deliberately absent.
drop view if exists public.public_catalog_products_v1;

create view public.public_catalog_products_v1
with (security_barrier = true)
as
select * from public.public_catalog_products_v2;

revoke all on public.public_catalog_products_v1 from public;
grant select on public.public_catalog_products_v1 to anon, authenticated, service_role;

comment on view public.public_catalog_products_v1 is
  'Compatibility public DTO. wholesale_price is intentionally absent.';
comment on view public.public_catalog_products_v2 is
  'Public product DTO containing retail price only.';
comment on view public.portal_catalog_products_v1 is
  'Portal product DTO with auth.uid()-derived effective price and no raw wholesale_price column.';
