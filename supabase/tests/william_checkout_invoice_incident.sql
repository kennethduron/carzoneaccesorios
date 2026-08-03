\set ON_ERROR_STOP on

begin;
select plan(1);

do $$
begin
  if public.normalize_accounting_delivery_mode_v1('store_pickup') <> 'pickup'
    or public.normalize_accounting_delivery_mode_v1('customer_arranged') <> 'pickup'
    or public.normalize_accounting_delivery_mode_v1('home_delivery') <> 'home_delivery'
    or public.normalize_accounting_delivery_mode_v1('shipping') <> 'shipping' then
    raise exception 'Delivery normalization matrix failed.';
  end if;

  if public.cash_on_delivery_applies_v1('cash', 'on_delivery', 'store_pickup')
    or not public.cash_on_delivery_applies_v1('cash', 'on_delivery', 'home_delivery')
    or public.cash_on_delivery_applies_v1('bank_transfer', 'before_delivery', 'shipping') then
    raise exception 'Cash-on-delivery applicability matrix failed.';
  end if;

  perform public.calculate_sale_financials_v1(
    '[{"quantity":2,"unit_price":1600},{"quantity":1,"unit_price":1000}]'::jsonb,
    0.15, 0, 0, 0, 0, '[]'::jsonb, 10000, 3000, 120,
    'store_pickup', 'wholesale', 'HNL'
  );
end;
$$;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  'a1000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'william-incident-test@example.test', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
);

update public.users
set role_id = (select id from public.roles where name = 'technical_owner'),
    full_name = 'William incident contract',
    email = 'william-incident-test@example.test',
    active = true
where id = 'a1000000-0000-4000-8000-000000000001';

update public.accounting_feature_flags
set state = 'enabled',
    cutover_at = now() - interval '1 minute',
    updated_by = 'a1000000-0000-4000-8000-000000000001'
where key = 'sales_draft_v2';

insert into public.accounting_outbox_v2 (
  id, feature_key, topic, source_type, source_id, event_purpose,
  posting_version, scenario, idempotency_key, occurred_at, cutover_at,
  status, actor_id, accounting_date, accounting_date_source
) values (
  'a2000000-0000-4000-8000-000000000001',
  'sales_draft_v2', 'sales.recognized', 'order',
  'a3000000-0000-4000-8000-000000000001', 'sale_recognized',
  'v2', 'unsupported_incident_fixture', 'william-incident-worker-fixture-v1',
  now(), now() - interval '1 minute', 'queued',
  'a1000000-0000-4000-8000-000000000001',
  (now() at time zone 'America/Tegucigalpa')::date,
  'incident_test_explicit_date'
);

select set_config('request.jwt.claims', '{"role":"service_role"}', true);

do $$
declare
  result jsonb;
begin
  result := public.hold_accounting_outbox_v1(
    'a2000000-0000-4000-8000-000000000001',
    'Controlled incident test hold'
  );
  if result->>'status' <> 'held'
    or not (select processing_hold from public.accounting_outbox_v2 where id = 'a2000000-0000-4000-8000-000000000001') then
    raise exception 'The outbox was not held: %', result;
  end if;

  if exists (
    select 1 from public.claim_due_accounting_outbox_v2(100)
    where outbox_id = 'a2000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'A held outbox remained claimable.';
  end if;

  result := public.process_accounting_outbox_v2(
    'a2000000-0000-4000-8000-000000000001',
    'incident-test-worker',
    false
  );
  if result->>'reason' <> 'processing_hold'
    or (select attempt_count from public.accounting_outbox_v2 where id = 'a2000000-0000-4000-8000-000000000001') <> 0 then
    raise exception 'A held outbox was processed: %', result;
  end if;

  result := public.release_accounting_outbox_v1(
    'a2000000-0000-4000-8000-000000000001',
    'Controlled incident test hold'
  );
  if result->>'status' <> 'released'
    or (select processing_hold from public.accounting_outbox_v2 where id = 'a2000000-0000-4000-8000-000000000001') then
    raise exception 'The outbox was not released: %', result;
  end if;

  if not exists (
    select 1 from public.claim_due_accounting_outbox_v2(100)
    where outbox_id = 'a2000000-0000-4000-8000-000000000001'
  ) then
    raise exception 'A released due outbox was not claimable.';
  end if;

  result := public.process_accounting_outbox_v2(
    'a2000000-0000-4000-8000-000000000001',
    'incident-test-worker',
    false
  );
  if result->>'reason' <> 'sale_source_missing'
    or (select attempt_count from public.accounting_outbox_v2 where id = 'a2000000-0000-4000-8000-000000000001') <> 1 then
    raise exception 'First retryable data failure was not counted durably: %', result;
  end if;

  update public.accounting_outbox_v2
  set next_attempt_at = now() - interval '1 second'
  where id = 'a2000000-0000-4000-8000-000000000001';

  result := public.process_accounting_outbox_v2(
    'a2000000-0000-4000-8000-000000000001',
    'incident-test-worker',
    false
  );
  if (select attempt_count from public.accounting_outbox_v2 where id = 'a2000000-0000-4000-8000-000000000001') <> 2 then
    raise exception 'Second technical failure was not counted durably: %', result;
  end if;

  update public.accounting_outbox_v2
  set attempt_count = max_attempts,
      next_attempt_at = now() - interval '1 second'
  where id = 'a2000000-0000-4000-8000-000000000001';

  result := public.process_accounting_outbox_v2(
    'a2000000-0000-4000-8000-000000000001',
    'incident-test-worker',
    false
  );
  if result->>'reason' <> 'max_attempts_reached' then
    raise exception 'Maximum attempts did not stop retrying: %', result;
  end if;
end;
$$;

do $$
begin
  if has_function_privilege('anon', 'public.hold_accounting_outbox_v1(uuid,text)', 'EXECUTE')
    or has_function_privilege('anon', 'public.release_accounting_outbox_v1(uuid,text)', 'EXECUTE')
    or has_function_privilege('anon', 'public.repair_checkout_order_commercial_snapshot_v1(uuid,uuid,text,text,uuid,uuid,uuid,numeric,integer,numeric,integer,text,text)', 'EXECUTE')
    or has_function_privilege('anon', 'public.generate_fiscal_invoice_from_order_v2(uuid,uuid)', 'EXECUTE') then
    raise exception 'An incident mutation RPC is exposed to anon.';
  end if;
end;
$$;

select pass('William checkout, invoice, accounting hold and retry protections remain intact');
select * from finish();
rollback;

\echo 'William checkout/invoice incident containment contract: OK'
