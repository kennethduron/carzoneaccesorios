begin transaction read only;

select set_config(
  'request.jwt.claim.sub',
  (
    select u.id::text
    from public.users u
    join public.roles r on r.id = u.role_id
    where u.active
      and r.name in ('technical_owner', 'business_owner', 'admin')
      and coalesce(r.permissions, '[]'::jsonb) ? 'customers:manage'
    order by case r.name when 'technical_owner' then 1 when 'business_owner' then 2 else 3 end, u.created_at
    limit 1
  ),
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  target_a uuid;
  target_b uuid;
  target_review uuid;
  review_customer uuid;
  protected_customer uuid;
  protected_account uuid;
begin
  select id into strict target_a from public.users
  where left(encode(extensions.digest(id::text, 'sha256'), 'hex'), 12) = '1d2e1e7c79b5';
  select id into strict target_b from public.users
  where left(encode(extensions.digest(id::text, 'sha256'), 'hex'), 12) = '29910216059c';
  select id into strict target_review from public.users
  where left(encode(extensions.digest(id::text, 'sha256'), 'hex'), 12) = '5623f2b268b8';
  select id into strict review_customer from public.customers
  where left(encode(extensions.digest(id::text, 'sha256'), 'hex'), 12) = '8c2e714515ac';
  select id into strict protected_customer from public.customers
  where left(encode(extensions.digest(id::text, 'sha256'), 'hex'), 12) = '6301180d309c';
  select id into strict protected_account from public.users
  where left(encode(extensions.digest(id::text, 'sha256'), 'hex'), 12) = '1a83977788b2';

  if exists (select 1 from public.customers where user_id in (target_a, target_b, target_review)) then
    raise exception 'A recovery target is already linked; stop and re-audit.';
  end if;

  if not exists (
    select 1
    from public.customers c
    join public.users u on u.id = target_review
    where c.id = review_customer
      and (
        public.normalize_portal_customer_email(c.email) = public.normalize_portal_customer_email(u.email)
        or public.normalize_portal_customer_phone(c.phone) = public.normalize_portal_customer_phone(u.phone)
      )
  ) then
    raise exception 'The expected review candidate no longer matches exact identity evidence.';
  end if;

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
end;
$$;

with targets(account_hash, portal_user_id) as (
  select
    left(encode(extensions.digest(u.id::text, 'sha256'), 'hex'), 12),
    u.id
  from public.users u
  where left(encode(extensions.digest(u.id::text, 'sha256'), 'hex'), 12)
    in ('1d2e1e7c79b5', '29910216059c', '5623f2b268b8')
), previews as (
  select t.*, public.preview_admin_portal_customer_profile_v1(t.portal_user_id) as preview
  from targets t
)
select
  'acct#' || account_hash as account,
  preview - 'portalUserId' - 'candidateCustomerId' as preview,
  case
    when preview->>'candidateCustomerId' is null then null
    else 'cust#' || left(
      encode(extensions.digest((preview->>'candidateCustomerId')::uuid::text, 'sha256'), 'hex'),
      12
    )
  end as candidate
from previews
order by account;

rollback;
