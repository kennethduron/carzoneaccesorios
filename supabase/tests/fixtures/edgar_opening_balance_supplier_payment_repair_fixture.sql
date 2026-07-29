\ir supplier_payment_opening_balance_repair_fixture.sql

-- Extend the local-only opening-balance fixture with the exact audited Edgar
-- payment and the already-completed CROMOS reference repair.

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  'a164cfce-d103-4bfb-a7cf-969b5eb195f3',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'edgar-payment-actor@example.test', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
);

update public.users
set role_id = (select id from public.roles where name = 'contadora'),
    full_name = 'Edgar payment actor local fixture',
    email = 'edgar-payment-actor@example.test',
    active = true
where id = 'a164cfce-d103-4bfb-a7cf-969b5eb195f3';

update public.suppliers
set name = 'EDGAR JOEL LEIVA PAZ'
where id = '97226fc4-4e67-48d1-8108-33a511e5f2e2';

update public.accounts_payable
set paid_amount = 2500.00,
    status = 'partial',
    due_date = date '2026-07-01',
    created_at = '2026-07-14 15:27:07.733378+00'
where id = 'a2250e0c-7718-4203-92a1-178429a86018';

update public.accounting_mappings
set id = '529ab9bd-5b03-424d-9e63-9551d29d68f9',
    priority = 100,
    effective_from = null,
    effective_to = null
where mapping_type = 'default_account'
  and source_key = 'accounts_payable';

insert into public.accounting_accounts (
  id, code, name, type, normal_balance, is_active, created_by
) values (
  'f5d451ec-4985-4c07-97a1-6d8e0a0fadf6',
  '1101005', 'BAC CHEQUES LPS', 'asset', 'debit', true,
  '91000000-0000-4000-8000-000000000001'
);

insert into public.accounting_mappings (
  id, mapping_type, source_key, account_id, priority, is_active,
  effective_from, effective_to, created_by
) values (
  'ae4ccc50-4ad4-40ba-b92e-d2549c51bf0b',
  'payment_method', 'supplier_payment_bank',
  'f5d451ec-4985-4c07-97a1-6d8e0a0fadf6',
  100, true, null, null,
  '91000000-0000-4000-8000-000000000001'
);

update public.accounting_feature_flags
set state = 'enabled',
    cutover_at = '2026-07-28 20:30:00+00'
where key = 'supplier_payment_draft_v2';

-- CROMOS remains present as already-repaired, published reference evidence.
update public.supplier_payments
set paid_at = '2026-07-13 00:00:00+00'
where id = 'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804';

insert into public.journal_entries (
  id, entry_number, entry_date, description, status, source_type, source_id,
  created_by, updated_by, posted_by, posted_at, metadata
) values (
  '4f76ec5b-7371-4765-be42-674f80d4db6b',
  'PC-20260728-E70E1AA7',
  date '2026-07-12',
  'Borrador dirigido pago CROMOS TORRE FUERTE L 9,800',
  'borrador',
  'financial_event',
  '6dd1e200-f628-450e-8bfc-f8a6c700b442',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  null,
  null,
  jsonb_build_object(
    'repair_contract', 'supplier_payment_9800_opening_balance_v2',
    'repair_idempotency_key',
      'supplier_payment_repair:fd93d49b-e4b3-4dcc-a0ca-5feb0488c804:6dd1e200-f628-450e-8bfc-f8a6c700b442'
  )
);

insert into public.journal_entry_lines (
  id, journal_entry_id, account_id, debit, credit, description, vendor_id
) values
  (
    '6cdf15b4-daf8-494f-9ba1-ff43d06bf7fe',
    '4f76ec5b-7371-4765-be42-674f80d4db6b',
    '05847d56-7097-492b-b153-2db33a00b9cd',
    9800.00, 0.00,
    'Disminucion de cuenta por pagar CROMOS TORRE FUERTE',
    '335b38ff-d06d-4bf1-88f0-ea51f034ee5f'
  ),
  (
    '4375b184-bb5b-439c-a29d-75406622d909',
    '4f76ec5b-7371-4765-be42-674f80d4db6b',
    'a84f16c1-42da-4ed5-bca8-d3b20c5c3733',
    0.00, 9800.00,
    'Pago con tarjeta de credito CROMOS TORRE FUERTE',
    '335b38ff-d06d-4bf1-88f0-ea51f034ee5f'
  );

update public.journal_entries
set status = 'publicada',
    posted_by = '91000000-0000-4000-8000-000000000001',
    posted_at = '2026-07-28 21:43:25.25883+00'
where id = '4f76ec5b-7371-4765-be42-674f80d4db6b';

update public.financial_events
set status = 'posted',
    journal_entry_id = '4f76ec5b-7371-4765-be42-674f80d4db6b'
where id = '6dd1e200-f628-450e-8bfc-f8a6c700b442';

insert into public.accounting_event_log (
  event_type, entity_type, entity_id, source_type, source_id, metadata, created_by
) values (
  'accounting.directed_repair_supplier_payment_9800',
  'journal_entries',
  '4f76ec5b-7371-4765-be42-674f80d4db6b',
  'supplier_payment',
  'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804',
  jsonb_build_object(
    'payment_id', 'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804',
    'financial_event_id', '6dd1e200-f628-450e-8bfc-f8a6c700b442',
    'journal_entry_id', '4f76ec5b-7371-4765-be42-674f80d4db6b',
    'repair_contract', 'supplier_payment_9800_opening_balance_v2',
    'repair_idempotency_key',
      'supplier_payment_repair:fd93d49b-e4b3-4dcc-a0ca-5feb0488c804:6dd1e200-f628-450e-8bfc-f8a6c700b442'
  ),
  '91000000-0000-4000-8000-000000000001'
);

-- Exact Edgar payment. Triggers are disabled so the fixture reproduces the
-- audited absence of a V2 outbox without invoking any processing path.
alter table public.supplier_payments disable trigger user;
insert into public.supplier_payments (
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at, notes, created_by, created_at,
  idempotency_key, request_fingerprint
) values (
  '3b88e1ac-74ae-460e-a399-3d1e0c0189e1',
  'a2250e0c-7718-4203-92a1-178429a86018',
  '97226fc4-4e67-48d1-8108-33a511e5f2e2',
  2500.00,
  'bank_transfer',
  'bank_transfer',
  'paid',
  '2026-07-13 06:00:00+00',
  '410000077',
  'a164cfce-d103-4bfb-a7cf-969b5eb195f3',
  '2026-07-28 21:47:52.583406+00',
  'fixture-edgar-payment-idempotency-v2',
  '0123456789abcdef0123456789abcdef'
);
alter table public.supplier_payments enable trigger user;

insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version, status,
  occurred_at, source_snapshot, validation_errors, created_by
) values (
  '1c85a425-8f28-4115-8ea3-d8217e8af897',
  'supplier_payment',
  '3b88e1ac-74ae-460e-a399-3d1e0c0189e1',
  'supplier_payment',
  'v1',
  'pending',
  '2026-07-13 06:00:00+00',
  '{"fixture":"approved_edgar_historical_payment"}'::jsonb,
  '["Modo de automatización desactivado; evento registrado solo por escaneo manual."]'::jsonb,
  'a164cfce-d103-4bfb-a7cf-969b5eb195f3'
);

insert into public.audit_logs (
  user_id, actor_role, table_name, record_id, action, old_data, new_data
) values (
  'a164cfce-d103-4bfb-a7cf-969b5eb195f3',
  'contadora',
  'supplier_payments',
  '3b88e1ac-74ae-460e-a399-3d1e0c0189e1',
  'supplier_payments.pay_v2',
  '{"previous_paid_amount":0}'::jsonb,
  jsonb_build_object(
    'amount', 2500.00,
    'effective_date', '2026-07-13',
    'payment_method', 'bank_transfer',
    'outbox_id', null,
    'status', 'partial'
  )
);

select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"service_role"}',
  true
);
