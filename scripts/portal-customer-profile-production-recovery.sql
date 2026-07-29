begin;

do $$
declare
  actor_id uuid;
  target_a uuid;
  target_b uuid;
  target_review uuid;
  review_customer uuid;
  protected_customer uuid;
  protected_account uuid;
  preview_a jsonb;
  preview_b jsonb;
  preview_review jsonb;
  result_a jsonb;
  result_b jsonb;
  result_review jsonb;
  before_orders bigint;
  before_payments bigint;
  before_invoices bigint;
  before_receivables bigint;
  before_inventory bigint;
  before_financial_events bigint;
  before_journals bigint;
  before_pos_drafts bigint;
begin
  select u.id
  into actor_id
  from public.users u
  join public.roles r on r.id = u.role_id
  where u.active
    and r.name in ('technical_owner', 'business_owner', 'admin')
    and coalesce(r.permissions, '[]'::jsonb) ? 'customers:manage'
  order by case r.name when 'technical_owner' then 1 when 'business_owner' then 2 else 3 end, u.created_at
  limit 1;

  if actor_id is null then
    raise exception 'No active authorized recovery actor was found.';
  end if;

  perform set_config('request.jwt.claim.sub', actor_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  select id into strict target_a
  from public.users
  where left(encode(extensions.digest(id::text, 'sha256'), 'hex'), 12) = '1d2e1e7c79b5';

  select id into strict target_b
  from public.users
  where left(encode(extensions.digest(id::text, 'sha256'), 'hex'), 12) = '29910216059c';

  select id into strict target_review
  from public.users
  where left(encode(extensions.digest(id::text, 'sha256'), 'hex'), 12) = '5623f2b268b8';

  select id into strict review_customer
  from public.customers
  where left(encode(extensions.digest(id::text, 'sha256'), 'hex'), 12) = '8c2e714515ac';

  select id into strict protected_customer
  from public.customers
  where left(encode(extensions.digest(id::text, 'sha256'), 'hex'), 12) = '6301180d309c';

  select id into strict protected_account
  from public.users
  where left(encode(extensions.digest(id::text, 'sha256'), 'hex'), 12) = '1a83977788b2';

  if not exists (
    select 1
    from public.customers c
    join public.customer_credit_accounts credit on credit.customer_id = c.id
    where c.id = protected_customer
      and c.user_id = protected_account
      and c.commercial_version = 5
      and c.is_wholesale
      and c.wholesale_status = 'approved'
      and c.wholesale_customer_type = 'existing'
      and credit.is_credit_enabled
      and credit.status = 'active'
      and credit.credit_limit = 20000
      and credit.terms_days = 30
  ) then
    raise exception 'Protected Polarizados invariant failed.';
  end if;

  if exists (
    select 1 from public.customers where user_id in (target_a, target_b)
  ) then
    raise exception 'A create target is already linked; rerun the read-only audit before deciding.';
  end if;

  if exists (
    select 1 from public.customers where user_id = target_review
  ) then
    raise exception 'The review target is already linked.';
  end if;

  if not exists (
    select 1
    from public.customers c
    join public.users u on u.id = target_review
    where c.id = review_customer
      and (
        public.normalize_portal_customer_email(c.email) =
          public.normalize_portal_customer_email(u.email)
        or public.normalize_portal_customer_phone(c.phone) =
          public.normalize_portal_customer_phone(u.phone)
      )
  ) then
    raise exception 'The expected review candidate no longer matches exact identity evidence.';
  end if;

  select count(*) into before_orders from public.orders;
  select count(*) into before_payments from public.payments;
  select count(*) into before_invoices from public.invoices;
  select count(*) into before_receivables from public.accounts_receivable;
  select count(*) into before_inventory from public.inventory_movements;
  select count(*) into before_financial_events from public.financial_events;
  select count(*) into before_journals from public.journal_entries;
  select count(*) into before_pos_drafts from public.pos_sale_drafts;

  preview_a := public.preview_admin_portal_customer_profile_v1(target_a);
  preview_b := public.preview_admin_portal_customer_profile_v1(target_b);
  preview_review := public.preview_admin_portal_customer_profile_v1(target_review);

  if preview_a->>'expectedState' <> 'unresolved'
    or preview_a->>'recommendedOutcome' <> 'profile_created'
    or preview_b->>'expectedState' <> 'unresolved'
    or preview_b->>'recommendedOutcome' <> 'profile_created'
    or preview_review->>'expectedState' <> 'unresolved'
    or preview_review->>'recommendedOutcome' <> 'review_required'
  then
    raise exception 'Recovery preview changed; no writes were committed.';
  end if;

  result_a := public.ensure_admin_portal_customer_profile_v1(
    target_a,
    '2b98ef75-84d4-548a-907f-1bfb22d971cb',
    'unresolved',
    'Recuperación productiva controlada de cuenta pública sin cliente coincidente.'
  );
  result_b := public.ensure_admin_portal_customer_profile_v1(
    target_b,
    'cf7503b6-f270-5cf3-a180-17bfe0cb39a5',
    'unresolved',
    'Recuperación productiva controlada de cuenta pública sin cliente coincidente.'
  );
  result_review := public.ensure_admin_portal_customer_profile_v1(
    target_review,
    '2b774de8-5b1a-5086-9cd4-c40f6987e321',
    'unresolved',
    'Clasificación productiva controlada de coincidencia existente para revisión segura.'
  );

  if result_a->>'code' <> 'PROFILE_CREATED'
    or result_b->>'code' <> 'PROFILE_CREATED'
    or result_review->>'code' <> 'REVIEW_REQUIRED'
  then
    raise exception 'Unexpected recovery result; no writes were committed.';
  end if;

  if (select count(*) from public.customers where user_id = target_a) <> 1
    or (select count(*) from public.customers where user_id = target_b) <> 1
    or exists (select 1 from public.customers where user_id = target_review)
  then
    raise exception 'One-to-one postcondition failed.';
  end if;

  if exists (
    select 1
    from public.customers c
    left join public.customer_credit_accounts credit on credit.customer_id = c.id
    where c.user_id in (target_a, target_b)
      and (
        c.source <> 'portal_registration'
        or c.is_wholesale
        or c.wholesale_status <> 'none'
        or credit.id is not null
      )
  ) then
    raise exception 'A recovered customer received a forbidden commercial benefit.';
  end if;

  if (select count(*) from public.portal_customer_link_reviews where portal_user_id = target_review and status = 'pending') <> 1 then
    raise exception 'Review postcondition failed.';
  end if;

  if before_orders <> (select count(*) from public.orders)
    or before_payments <> (select count(*) from public.payments)
    or before_invoices <> (select count(*) from public.invoices)
    or before_receivables <> (select count(*) from public.accounts_receivable)
    or before_inventory <> (select count(*) from public.inventory_movements)
    or before_financial_events <> (select count(*) from public.financial_events)
    or before_journals <> (select count(*) from public.journal_entries)
    or before_pos_drafts <> (select count(*) from public.pos_sale_drafts)
  then
    raise exception 'A forbidden operational table changed during recovery.';
  end if;
end;
$$;

commit;

select
  'acct#' || left(encode(extensions.digest(s.portal_user_id::text, 'sha256'), 'hex'), 12) as account,
  s.state,
  case when s.customer_id is null then null
    else 'cust#' || left(encode(extensions.digest(s.customer_id::text, 'sha256'), 'hex'), 12)
  end as customer,
  s.candidate_count
from public.portal_customer_profile_syncs s
where left(encode(extensions.digest(s.portal_user_id::text, 'sha256'), 'hex'), 12)
  in ('1d2e1e7c79b5', '29910216059c', '5623f2b268b8')
order by account;
