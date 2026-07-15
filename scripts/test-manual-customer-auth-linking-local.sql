\set ON_ERROR_STOP on
\echo 'Running manual customer/Auth linking tests in a disposable transaction'

begin;

insert into public.roles (id, name, permissions) values
  ('10000000-0000-4000-8000-000000000001', 'technical_owner', '[]'::jsonb),
  ('10000000-0000-4000-8000-000000000002', 'vendedor', '[]'::jsonb),
  ('10000000-0000-4000-8000-000000000003', 'business_owner', '[]'::jsonb),
  ('10000000-0000-4000-8000-000000000004', 'admin', '[]'::jsonb),
  ('10000000-0000-4000-8000-000000000005', 'contadora', '[]'::jsonb),
  ('10000000-0000-4000-8000-000000000006', 'bodega', '[]'::jsonb),
  ('10000000-0000-4000-8000-000000000007', 'soporte', '[]'::jsonb),
  ('10000000-0000-4000-8000-000000000008', 'cliente', '[]'::jsonb);

\ir ../supabase/migrations/202607150003_manual_customer_auth_linking.sql

do $$
begin
  if exists (
    select 1
    from public.roles
    where name in ('technical_owner', 'business_owner', 'admin', 'contadora')
      and not (permissions ? 'customers:link_portal_account')
  ) then
    raise exception 'An approved role did not receive the portal-link permission';
  end if;

  if exists (
    select 1
    from public.roles
    where name in ('vendedor', 'bodega', 'soporte', 'cliente')
      and permissions ? 'customers:link_portal_account'
  ) then
    raise exception 'A denied role received the portal-link permission';
  end if;
end;
$$;

insert into public.customers (id, contact_name, email, phone, active, status)
values (
  '30000000-0000-4000-8000-000000000008',
  'TEST Same Email No Auto Link',
  'same-identity@example.invalid',
  null,
  true,
  'active'
);

insert into auth.users (id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
  ('20000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'test-link-actor@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('20000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'test-link-denied@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('20000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'test-link-portal@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('20000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'test-link-inactive@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('20000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'test-link-second@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('20000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'test-link-business-actor@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('20000000-0000-4000-8000-000000000007', 'authenticated', 'authenticated', 'test-link-admin-actor@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('20000000-0000-4000-8000-000000000008', 'authenticated', 'authenticated', 'test-link-accountant-actor@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('20000000-0000-4000-8000-000000000009', 'authenticated', 'authenticated', 'test-link-warehouse-actor@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('20000000-0000-4000-8000-000000000010', 'authenticated', 'authenticated', 'test-link-support-actor@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('20000000-0000-4000-8000-000000000011', 'authenticated', 'authenticated', 'test-link-client-actor@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('20000000-0000-4000-8000-000000000012', 'authenticated', 'authenticated', 'test-link-business-target@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('20000000-0000-4000-8000-000000000013', 'authenticated', 'authenticated', 'test-link-admin-target@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('20000000-0000-4000-8000-000000000014', 'authenticated', 'authenticated', 'test-link-accountant-target@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('20000000-0000-4000-8000-000000000015', 'authenticated', 'authenticated', 'same-identity@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

update public.users set role_id = '10000000-0000-4000-8000-000000000001'
where id = '20000000-0000-4000-8000-000000000001';
update public.users set role_id = '10000000-0000-4000-8000-000000000002'
where id = '20000000-0000-4000-8000-000000000002';
update public.users set active = false
where id = '20000000-0000-4000-8000-000000000004';
update public.users set role_id = '10000000-0000-4000-8000-000000000003'
where id = '20000000-0000-4000-8000-000000000006';
update public.users set role_id = '10000000-0000-4000-8000-000000000004'
where id = '20000000-0000-4000-8000-000000000007';
update public.users set role_id = '10000000-0000-4000-8000-000000000005'
where id = '20000000-0000-4000-8000-000000000008';
update public.users set role_id = '10000000-0000-4000-8000-000000000006'
where id = '20000000-0000-4000-8000-000000000009';
update public.users set role_id = '10000000-0000-4000-8000-000000000007'
where id = '20000000-0000-4000-8000-000000000010';

do $$
begin
  if (select phone is not null from public.users where id = '20000000-0000-4000-8000-000000000003') then
    raise exception 'Missing Auth phone was not stored as NULL';
  end if;
  if exists (select 1 from public.customers where user_id = '20000000-0000-4000-8000-000000000003') then
    raise exception 'Auth signup automatically created or linked a customer';
  end if;
  if (select user_id is not null from public.customers where id = '30000000-0000-4000-8000-000000000008') then
    raise exception 'Equal email automatically linked the pre-existing customer';
  end if;
end;
$$;

insert into public.customers (id, contact_name, email, phone, active, status) values
  ('30000000-0000-4000-8000-000000000001', 'TEST Manual Link Main', null, null, true, 'active'),
  ('30000000-0000-4000-8000-000000000002', 'TEST Manual Link Conflict', null, null, true, 'active'),
  ('30000000-0000-4000-8000-000000000003', 'TEST Manual Link Denied', null, null, true, 'active'),
  ('30000000-0000-4000-8000-000000000004', 'TEST Manual Link Inactive', null, null, false, 'inactive'),
  ('30000000-0000-4000-8000-000000000005', 'TEST Business Owner Link', null, null, true, 'active'),
  ('30000000-0000-4000-8000-000000000006', 'TEST Admin Link', null, null, true, 'active'),
  ('30000000-0000-4000-8000-000000000007', 'TEST Accountant Link', null, null, true, 'active');

insert into public.products (
  id,
  sku,
  slug,
  name,
  brand,
  stock,
  retail_price,
  wholesale_price,
  cost_price,
  active,
  status
)
values (
  '40000000-0000-4000-8000-000000000001',
  'TEST-IDENTITY-CHECKOUT',
  'test-identity-checkout',
  'TEST Identity Checkout Product',
  'TEST',
  10,
  100,
  80,
  50,
  true,
  'active'
);

insert into public.company_settings (id)
values ('50000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000015', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', '20000000-0000-4000-8000-000000000015', 'role', 'authenticated')::text,
  true
);

do $$
declare
  customers_before integer;
  customers_after_first integer;
  customers_after_second integer;
  first_order_id uuid;
  second_order_id uuid;
  first_customer_id uuid;
  second_customer_id uuid;
begin
  select count(*) into customers_before from public.customers;

  select checkout.order_id into first_order_id
  from public.create_checkout_order(
    'TEST Checkout Account',
    'same-identity@example.invalid',
    '99999999',
    null,
    'TEST Local Address',
    'retail',
    'cash',
    null,
    jsonb_build_array(jsonb_build_object('product_id', '40000000-0000-4000-8000-000000000001', 'quantity', 1))
  ) checkout;

  select orders.customer_id into first_customer_id
  from public.orders
  where orders.id = first_order_id;
  select count(*) into customers_after_first from public.customers;

  if customers_after_first <> customers_before + 1 then
    raise exception 'First authenticated checkout did not create exactly one unlinked operational customer';
  end if;
  if first_customer_id = '30000000-0000-4000-8000-000000000008' then
    raise exception 'Authenticated checkout matched a customer by equal email';
  end if;
  if exists (select 1 from public.customers where user_id = '20000000-0000-4000-8000-000000000015') then
    raise exception 'Authenticated checkout automatically linked customers.user_id';
  end if;
  if (select user_id is not null from public.customers where id = first_customer_id) then
    raise exception 'Checkout operational customer did not keep user_id NULL';
  end if;

  select checkout.order_id into second_order_id
  from public.create_checkout_order(
    'TEST Checkout Account',
    'same-identity@example.invalid',
    '99999999',
    null,
    'TEST Local Address',
    'retail',
    'cash',
    null,
    jsonb_build_array(jsonb_build_object('product_id', '40000000-0000-4000-8000-000000000001', 'quantity', 1))
  ) checkout;

  select orders.customer_id into second_customer_id
  from public.orders
  where orders.id = second_order_id;
  select count(*) into customers_after_second from public.customers;

  if second_customer_id <> first_customer_id then
    raise exception 'Second authenticated checkout did not reuse exact prior-order provenance';
  end if;
  if customers_after_second <> customers_after_first then
    raise exception 'Second authenticated checkout left a temporary customer behind';
  end if;
  if exists (select 1 from public.customers where user_id = '20000000-0000-4000-8000-000000000015') then
    raise exception 'Repeated checkout automatically linked customers.user_id';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', '20000000-0000-4000-8000-000000000001', 'role', 'authenticated')::text,
  true
);

do $$
declare
  result_row record;
begin
  select * into result_row
  from public.link_customer_portal_account_manual(
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000003',
    'Identidad revisada manualmente.',
    true
  );
  if not result_row.ok or result_row.status <> 'linked' then
    raise exception 'Expected successful manual link';
  end if;

  select * into result_row
  from public.link_customer_portal_account_manual(
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000003',
    'Identidad revisada manualmente.',
    true
  );
  if not result_row.ok or result_row.status <> 'already_linked' then
    raise exception 'Expected idempotent already_linked result';
  end if;

  if (select count(*) from public.audit_logs
      where record_id = '30000000-0000-4000-8000-000000000001'
        and action = 'customer_portal_link.linked_manual') <> 1 then
    raise exception 'Successful link audit was duplicated';
  end if;

  if (select user_id from public.customers where id = '30000000-0000-4000-8000-000000000001')
      <> '20000000-0000-4000-8000-000000000003' then
    raise exception 'Customer user_id was not linked';
  end if;

  if (select contact_name from public.customers where id = '30000000-0000-4000-8000-000000000001')
      <> 'TEST Manual Link Main' then
    raise exception 'Manual link changed customer identity';
  end if;

  select * into result_row
  from public.link_customer_portal_account_manual(
    '30000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000003',
    'Conflicto revisado manualmente.',
    true
  );
  if result_row.ok or result_row.status <> 'portal_account_conflict' then
    raise exception 'Expected portal account conflict';
  end if;

  select * into result_row
  from public.link_customer_portal_account_manual(
    '30000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000005',
    'Conflicto del customer revisado.',
    true
  );
  if result_row.ok or result_row.status <> 'customer_conflict' then
    raise exception 'Expected customer conflict';
  end if;

  select * into result_row
  from public.link_customer_portal_account_manual(
    '30000000-0000-4000-8000-000000000099',
    '20000000-0000-4000-8000-000000000005',
    'Customer inexistente revisado.',
    true
  );
  if result_row.ok or result_row.status <> 'customer_not_found' then
    raise exception 'Expected missing customer rejection';
  end if;

  select * into result_row
  from public.link_customer_portal_account_manual(
    '30000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000099',
    'Cuenta inexistente revisada.',
    true
  );
  if result_row.ok or result_row.status <> 'invalid_portal_account' then
    raise exception 'Expected missing portal account rejection';
  end if;

  select * into result_row
  from public.link_customer_portal_account_manual(
    '30000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000004',
    'corto',
    true
  );
  if result_row.ok or result_row.status <> 'reason_required' then
    raise exception 'Expected reason validation';
  end if;

  select * into result_row
  from public.link_customer_portal_account_manual(
    '30000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000004',
    'Confirmación revisada manualmente.',
    false
  );
  if result_row.ok or result_row.status <> 'confirmation_required' then
    raise exception 'Expected explicit confirmation validation';
  end if;

  select * into result_row
  from public.link_customer_portal_account_manual(
    '30000000-0000-4000-8000-000000000004',
    '20000000-0000-4000-8000-000000000004',
    'Estado revisado manualmente.',
    true
  );
  if result_row.ok or result_row.status <> 'inactive_customer' then
    raise exception 'Expected inactive customer rejection';
  end if;

  select * into result_row
  from public.link_customer_portal_account_manual(
    '30000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000004',
    'Cuenta revisada manualmente.',
    true
  );
  if result_row.ok or result_row.status <> 'invalid_portal_account' then
    raise exception 'Expected inactive portal account rejection';
  end if;
end;
$$;

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000003', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', '20000000-0000-4000-8000-000000000003', 'role', 'authenticated')::text,
  true
);

do $$
declare
  customers_before integer;
  customers_after integer;
  checkout_order_id uuid;
  checkout_customer_id uuid;
begin
  select count(*) into customers_before from public.customers;

  select checkout.order_id into checkout_order_id
  from public.create_checkout_order(
    'TEST Linked Checkout',
    'test-link-portal@example.invalid',
    '98888888',
    null,
    'TEST Linked Address',
    'retail',
    'cash',
    null,
    jsonb_build_array(jsonb_build_object('product_id', '40000000-0000-4000-8000-000000000001', 'quantity', 1))
  ) checkout;

  select orders.customer_id into checkout_customer_id
  from public.orders
  where orders.id = checkout_order_id;
  select count(*) into customers_after from public.customers;

  if checkout_customer_id <> '30000000-0000-4000-8000-000000000001' then
    raise exception 'Linked checkout did not use the exact manually linked customer';
  end if;
  if customers_after <> customers_before then
    raise exception 'Linked checkout left a temporary customer behind';
  end if;
  if (select user_id from public.customers where id = '30000000-0000-4000-8000-000000000001')
      <> '20000000-0000-4000-8000-000000000003' then
    raise exception 'Linked checkout changed the existing customer link';
  end if;
end;
$$;

do $$
declare
  link_case record;
  result_row record;
begin
  for link_case in
    select *
    from (values
      ('20000000-0000-4000-8000-000000000006'::uuid, '30000000-0000-4000-8000-000000000005'::uuid, '20000000-0000-4000-8000-000000000012'::uuid, 'business_owner'),
      ('20000000-0000-4000-8000-000000000007'::uuid, '30000000-0000-4000-8000-000000000006'::uuid, '20000000-0000-4000-8000-000000000013'::uuid, 'admin'),
      ('20000000-0000-4000-8000-000000000008'::uuid, '30000000-0000-4000-8000-000000000007'::uuid, '20000000-0000-4000-8000-000000000014'::uuid, 'contadora')
    ) as approved(actor_id, customer_id, portal_user_id, role_name)
  loop
    perform set_config('request.jwt.claim.sub', link_case.actor_id::text, true);
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', link_case.actor_id, 'role', 'authenticated')::text,
      true
    );

    select * into result_row
    from public.link_customer_portal_account_manual(
      link_case.customer_id,
      link_case.portal_user_id,
      'Identidad revisada por rol autorizado.',
      true
    );

    if not result_row.ok or result_row.status <> 'linked' then
      raise exception 'Expected successful manual link for role %', link_case.role_name;
    end if;
  end loop;
end;
$$;

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', '20000000-0000-4000-8000-000000000002', 'role', 'authenticated')::text,
  true
);

do $$
declare
  result_row record;
begin
  select * into result_row
  from public.link_customer_portal_account_manual(
    '30000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000004',
    'Permiso revisado manualmente.',
    true
  );
  if result_row.ok or result_row.status <> 'permission_denied' then
    raise exception 'Expected permission rejection';
  end if;
end;
$$;

do $$
declare
  denied_case record;
  result_row record;
begin
  for denied_case in
    select *
    from (values
      ('20000000-0000-4000-8000-000000000009'::uuid, 'bodega'),
      ('20000000-0000-4000-8000-000000000010'::uuid, 'soporte'),
      ('20000000-0000-4000-8000-000000000011'::uuid, 'cliente')
    ) as denied(actor_id, role_name)
  loop
    perform set_config('request.jwt.claim.sub', denied_case.actor_id::text, true);
    perform set_config(
      'request.jwt.claims',
      jsonb_build_object('sub', denied_case.actor_id, 'role', 'authenticated')::text,
      true
    );

    select * into result_row
    from public.link_customer_portal_account_manual(
      '30000000-0000-4000-8000-000000000003',
      '20000000-0000-4000-8000-000000000005',
      'Permiso del rol revisado manualmente.',
      true
    );

    if result_row.ok or result_row.status <> 'permission_denied' then
      raise exception 'Expected permission rejection for role %', denied_case.role_name;
    end if;
  end loop;
end;
$$;

select set_config('request.jwt.claim.sub', '', true);
select set_config(
  'request.jwt.claims',
  jsonb_build_object('role', 'anon')::text,
  true
);

do $$
declare
  result_row record;
begin
  select * into result_row
  from public.link_customer_portal_account_manual(
    '30000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000005',
    'Acceso anónimo revisado.',
    true
  );
  if result_row.ok or result_row.status <> 'permission_denied' then
    raise exception 'Expected anonymous rejection';
  end if;
end;
$$;

rollback;

do $$
begin
  if exists (select 1 from auth.users where id::text like '20000000-0000-4000-8000-%')
    or exists (select 1 from public.customers where id::text like '30000000-0000-4000-8000-%')
    or exists (select 1 from public.roles where id::text like '10000000-0000-4000-8000-%')
    or exists (select 1 from public.products where id::text like '40000000-0000-4000-8000-%')
    or exists (select 1 from public.company_settings where id::text like '50000000-0000-4000-8000-%')
  then
    raise exception 'Disposable identity fixtures remained after rollback';
  end if;
end;
$$;

\echo 'Manual customer/Auth linking local integration checks passed; transaction rolled back and fixtures are zero.'
