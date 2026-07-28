-- Exact, local-only reconstruction of the approved evidence population.
-- The caller owns the transaction and cleanup.

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '91000000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'opening-repair@example.test', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
);

update public.users
set role_id = (select id from public.roles where name = 'technical_owner'),
    full_name = 'Opening repair local fixture',
    email = 'opening-repair@example.test',
    active = true
where id = '91000000-0000-4000-8000-000000000001';

insert into public.accounting_accounts (
  id, code, name, type, normal_balance, is_active, created_by
) values
  (
    '05847d56-7097-492b-b153-2db33a00b9cd',
    '2101001', 'PROVEEDORES LOCALES', 'liability', 'credit', true,
    '91000000-0000-4000-8000-000000000001'
  ),
  (
    'a84f16c1-42da-4ed5-bca8-d3b20c5c3733',
    '2110001', 'TARJETA DE CREDITO', 'liability', 'credit', true,
    '91000000-0000-4000-8000-000000000001'
  ),
  (
    '92000000-0000-4000-8000-000000000003',
    '3101001', 'PATRIMONIO APERTURA PRUEBA', 'equity', 'credit', true,
    '91000000-0000-4000-8000-000000000001'
  );

insert into public.accounting_mappings (
  mapping_type, source_key, account_id, priority, is_active,
  effective_from, created_by
) values
  (
    'default_account', 'accounts_payable',
    '05847d56-7097-492b-b153-2db33a00b9cd',
    1, true, '2026-01-01', '91000000-0000-4000-8000-000000000001'
  ),
  (
    'payment_method', 'supplier_payment_card',
    'a84f16c1-42da-4ed5-bca8-d3b20c5c3733',
    1, true, '2026-01-01', '91000000-0000-4000-8000-000000000001'
  );

insert into public.suppliers (id, name, is_active, created_by) values
  ('105da9a0-d1dc-4358-b1c6-bbcf56ef59b1', 'DIFORZA', true, '91000000-0000-4000-8000-000000000001'),
  ('c8ce3a31-2f25-4f6a-80d7-d7d9c45044fe', 'KOOLAUDIO', true, '91000000-0000-4000-8000-000000000001'),
  ('d7f4840f-03dd-40a8-a16b-27cf25a71ca8', 'VARIEDADES', true, '91000000-0000-4000-8000-000000000001'),
  ('335b38ff-d06d-4bf1-88f0-ea51f034ee5f', 'CROMOS TORRE FUERTE', true, '91000000-0000-4000-8000-000000000001'),
  ('97226fc4-4e67-48d1-8108-33a511e5f2e2', 'EDGAR JOEL', true, '91000000-0000-4000-8000-000000000001'),
  ('da0489ab-f013-453a-8542-c568bd219bfc', 'GRUPO', true, '91000000-0000-4000-8000-000000000001'),
  ('11c49454-0a13-4eed-b19b-e8b349533a31', 'CONCEPTOS', true, '91000000-0000-4000-8000-000000000001'),
  ('39599165-6a6d-4cba-84d4-40ba0d79158e', 'CHRISTOFHER', true, '91000000-0000-4000-8000-000000000001');

insert into public.accounts_payable (
  id, supplier_id, total_amount, paid_amount, status, currency,
  created_by, created_at
) values
  ('96a95d10-d4c6-4f2d-ac48-0e904e619cf4', '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1', 6000.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:00+00'),
  ('13f1ec0e-300c-4493-bd5e-2c18333e2d6e', '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1', 49200.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:01+00'),
  ('0a7b7cfd-b7b8-407a-a923-d05792602a84', '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1', 3600.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:02+00'),
  ('3a1e6e25-6755-436b-b59d-cb6cb826541a', '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1', 2700.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:03+00'),
  ('a45e7c75-364d-40e9-90ad-f452097dd4a5', '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1', 32920.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:04+00'),
  ('0fcd480c-13ac-4942-adf7-6c77e37a1488', '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1', 4462.50, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:05+00'),
  ('a1dd3335-b682-4bac-9924-579b9a812c76', 'c8ce3a31-2f25-4f6a-80d7-d7d9c45044fe', 2875.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:06+00'),
  ('3decb1cc-fa18-49e2-ac9a-c97e84916f5b', 'c8ce3a31-2f25-4f6a-80d7-d7d9c45044fe', 11746.50, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:07+00'),
  ('96aa009b-03d7-49ee-a874-77aec8fa30e7', 'c8ce3a31-2f25-4f6a-80d7-d7d9c45044fe', 9297.75, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:08+00'),
  ('90809e69-b29d-4a27-b551-778a441298a4', 'c8ce3a31-2f25-4f6a-80d7-d7d9c45044fe', 3519.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:09+00'),
  ('b6f011f8-b1f1-417e-9c31-755d4f8e0e76', 'c8ce3a31-2f25-4f6a-80d7-d7d9c45044fe', 5535.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:10+00'),
  ('6db34078-e987-48e8-89ff-3d81957b8dfe', 'd7f4840f-03dd-40a8-a16b-27cf25a71ca8', 53850.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:11+00'),
  ('67d9cd9b-e137-409a-a09e-745c3fb0599c', 'd7f4840f-03dd-40a8-a16b-27cf25a71ca8', 10700.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:12+00'),
  ('9d173203-b8e0-4041-98d8-1a76d5d7a4b1', 'd7f4840f-03dd-40a8-a16b-27cf25a71ca8', 29000.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:13+00'),
  ('5421d871-4ab4-49f6-a778-99bdbe0f609e', '335b38ff-d06d-4bf1-88f0-ea51f034ee5f', 73200.00, 9800.00, 'partial', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:14+00'),
  ('a2250e0c-7718-4203-92a1-178429a86018', '97226fc4-4e67-48d1-8108-33a511e5f2e2', 656938.41, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:15+00'),
  ('7e4885ee-aca9-45d0-8914-49f8992c7e6f', '97226fc4-4e67-48d1-8108-33a511e5f2e2', 365000.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:16+00'),
  ('a48a7e92-648a-41d4-a928-f7d94c3e7624', '97226fc4-4e67-48d1-8108-33a511e5f2e2', 168768.30, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:17+00'),
  ('040fb5dc-c06b-49e7-b1ff-9eec24a5ed59', 'da0489ab-f013-453a-8542-c568bd219bfc', 1380.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:18+00'),
  ('1250db16-8803-40f4-a4a5-4afca0271ced', 'da0489ab-f013-453a-8542-c568bd219bfc', 4715.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:19+00'),
  ('76f46a09-dc11-4f0d-b1b2-0ca7deccd720', 'da0489ab-f013-453a-8542-c568bd219bfc', 2990.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:20+00'),
  ('fd8f8839-4eda-4b29-86c3-c721123becd5', 'da0489ab-f013-453a-8542-c568bd219bfc', 1150.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:21+00'),
  ('a860a6d4-7232-4ce7-80a3-8395b2a8f974', 'da0489ab-f013-453a-8542-c568bd219bfc', 1150.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:22+00'),
  ('1ad89254-6032-4abf-a064-da3c0693d2d3', 'da0489ab-f013-453a-8542-c568bd219bfc', 5778.75, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:23+00'),
  ('33d64b82-7d28-4b45-9ede-15f4953813d9', '11c49454-0a13-4eed-b19b-e8b349533a31', 13496.40, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:24+00'),
  ('c570d0ff-862a-4650-bdd1-b3cd04479a4c', '39599165-6a6d-4cba-84d4-40ba0d79158e', 70000.00, 0, 'pending', 'HNL', '91000000-0000-4000-8000-000000000001', '2026-07-14 19:00:25+00');

insert into public.journal_entries (
  id, entry_number, entry_date, description, status,
  created_by, updated_by, created_at, posted_by, posted_at, metadata
) values (
  '5843045f-db47-429c-ad19-f75dc61cdd3e',
  'PC-20260714-621782',
  '2026-07-11',
  'BALANCE INICIAL DE ZAFRA',
  'borrador',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  '2026-07-14 20:23:42.016954+00',
  null, null,
  '{"fixture":"opening_balance_repair"}'::jsonb
);

insert into public.journal_entry_lines (
  id, journal_entry_id, account_id, debit, credit, description
) values
  (
    'f7389203-9ac0-40b8-9822-edfceb0e38fb',
    '5843045f-db47-429c-ad19-f75dc61cdd3e',
    '05847d56-7097-492b-b153-2db33a00b9cd',
    0, 1589972.61, 'PROVEEDORES LOCALES'
  ),
  (
    '92000000-0000-4000-8000-000000000004',
    '5843045f-db47-429c-ad19-f75dc61cdd3e',
    '92000000-0000-4000-8000-000000000003',
    1589972.61, 0, 'CONTRAPARTIDA APERTURA'
  );

update public.journal_entries
set status = 'publicada',
    posted_by = '91000000-0000-4000-8000-000000000001',
    posted_at = '2026-07-14 20:25:00+00'
where id = '5843045f-db47-429c-ad19-f75dc61cdd3e';

alter table public.supplier_payments disable trigger user;
insert into public.supplier_payments (
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at, created_by, created_at
) values (
  'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804',
  '5421d871-4ab4-49f6-a778-99bdbe0f609e',
  '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
  9800.00, 'TARJETA', null, 'paid',
  '2026-07-12 12:00:00-06',
  '91000000-0000-4000-8000-000000000001',
  '2026-07-12 12:00:00-06'
);
alter table public.supplier_payments enable trigger user;

insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version, status,
  occurred_at, source_snapshot, validation_errors, created_by
) values (
  '6dd1e200-f628-450e-8bfc-f8a6c700b442',
  'supplier_payment',
  'fd93d49b-e4b3-4dcc-a0ca-5feb0488c804',
  'supplier_payment',
  'v1',
  'pending',
  '2026-07-12 12:00:00-06',
  '{"fixture":"approved_historical_payment"}'::jsonb,
  '[]'::jsonb,
  '91000000-0000-4000-8000-000000000001'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"service_role"}',
  true
);
