-- One-time, manifest-bound repair of 37 published accounting dates.
-- Manifest SHA-256: 45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857
-- The strict published-entry guard is restored before this transaction commits.

begin;

create table if not exists public.accounting_entry_date_repair_batches (
  manifest_hash text primary key check (manifest_hash ~ '^[0-9a-f]{64}$'),
  migration_name text not null unique,
  expected_count integer not null check (expected_count > 0),
  expected_debit numeric(14,2) not null,
  expected_credit numeric(14,2) not null,
  status text not null check (status in ('approved', 'applied', 'rolled_back')),
  strict_guard_hash_before text,
  strict_guard_hash_after text,
  executed_by name,
  executed_at timestamptz,
  rolled_back_at timestamptz,
  created_at timestamptz not null default clock_timestamp()
);

create table if not exists public.accounting_entry_date_repair_manifest (
  manifest_hash text not null references public.accounting_entry_date_repair_batches(manifest_hash) on delete restrict,
  journal_entry_id uuid not null,
  financial_event_id uuid not null,
  accounting_outbox_id uuid,
  source_type text not null,
  source_id uuid not null,
  document_type text not null,
  document_number text,
  old_entry_date date not null,
  old_event_accounting_date date,
  old_outbox_accounting_date date,
  new_accounting_date date not null,
  accounting_date_source text not null,
  debit_total numeric(14,2) not null,
  credit_total numeric(14,2) not null,
  line_count integer not null check (line_count > 0),
  line_hash text not null check (line_hash ~ '^[0-9a-f]{64}$'),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  repair_group text not null check (repair_group in ('A', 'B')),
  primary key (manifest_hash, journal_entry_id),
  unique (journal_entry_id)
);

create table if not exists public.accounting_entry_date_repairs (
  id uuid primary key default gen_random_uuid(),
  manifest_hash text not null references public.accounting_entry_date_repair_batches(manifest_hash) on delete restrict,
  migration_name text not null,
  action text not null check (action in ('repair', 'rollback', 'reapply')),
  journal_entry_id uuid not null references public.journal_entries(id) on delete restrict,
  financial_event_id uuid not null references public.financial_events(id) on delete restrict,
  accounting_outbox_id uuid references public.accounting_outbox_v2(id) on delete restrict,
  source_type text not null,
  source_id uuid not null,
  document_number text,
  old_entry_date date not null,
  new_entry_date date not null,
  old_event_accounting_date date,
  new_event_accounting_date date,
  old_outbox_accounting_date date,
  new_outbox_accounting_date date,
  debit_total numeric(14,2) not null,
  credit_total numeric(14,2) not null,
  line_count integer not null,
  line_hash text not null,
  source_hash text not null,
  reason text not null,
  before_state jsonb not null,
  after_state jsonb not null,
  executed_by name not null default current_user,
  executed_at timestamptz not null default clock_timestamp(),
  unique (manifest_hash, journal_entry_id, action)
);

alter table public.accounting_entry_date_repair_batches enable row level security;
alter table public.accounting_entry_date_repair_manifest enable row level security;
alter table public.accounting_entry_date_repairs enable row level security;

drop policy if exists accounting_entry_date_repairs_authorized_read
  on public.accounting_entry_date_repairs;
create policy accounting_entry_date_repairs_authorized_read
  on public.accounting_entry_date_repairs for select
  using (
    public.has_permission('accounting:read')
    and public.current_actor_role() in ('technical_owner', 'business_owner', 'admin', 'contadora')
  );

grant select on public.accounting_entry_date_repairs to authenticated, service_role;
revoke insert, update, delete on public.accounting_entry_date_repairs from public, anon, authenticated, service_role;
revoke all on public.accounting_entry_date_repair_batches from public, anon, authenticated, service_role;
revoke all on public.accounting_entry_date_repair_manifest from public, anon, authenticated, service_role;

create or replace function public.guard_accounting_entry_date_repairs_append_only_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 'ACCOUNTING_DATE_REPAIR_AUDIT_IMMUTABLE';
end;
$$;

revoke all on function public.guard_accounting_entry_date_repairs_append_only_v1()
  from public, anon, authenticated, service_role;

drop trigger if exists accounting_entry_date_repairs_append_only
  on public.accounting_entry_date_repairs;
create trigger accounting_entry_date_repairs_append_only
before update or delete on public.accounting_entry_date_repairs
for each row execute function public.guard_accounting_entry_date_repairs_append_only_v1();

create or replace function public.accounting_entry_date_repair_line_hash_v1(target_entry_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select encode(extensions.digest(coalesce(string_agg(
    format('%s|%s|%s|%s|%s|%s|%s|%s',
      line.id::text,
      line.account_id::text,
      to_char(line.debit, 'FM999999999990.00'),
      to_char(line.credit, 'FM999999999990.00'),
      coalesce(line.description, ''),
      coalesce(line.customer_id::text, ''),
      coalesce(line.vendor_id::text, ''),
      coalesce(line.product_id::text, '')
    ), E'\n' order by line.created_at, line.id
  ), ''), 'sha256'), 'hex')
  from public.journal_entry_lines line
  where line.journal_entry_id = target_entry_id
$$;

revoke all on function public.accounting_entry_date_repair_line_hash_v1(uuid)
  from public, anon, authenticated, service_role;

insert into public.accounting_entry_date_repair_batches (
  manifest_hash, migration_name, expected_count, expected_debit, expected_credit, status
) values (
  '45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857',
  '202608030004_accounting_historical_date_repair.sql',
  37, 134905.59, 134905.59, 'approved'
) on conflict (manifest_hash) do nothing;

-- MANIFEST_VALUES_START
insert into public.accounting_entry_date_repair_manifest (
  manifest_hash, journal_entry_id, financial_event_id, accounting_outbox_id, source_type, source_id, document_type, document_number, old_entry_date, old_event_accounting_date, old_outbox_accounting_date, new_accounting_date, accounting_date_source, debit_total, credit_total, line_count, line_hash, source_hash, repair_group
) values
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '04607445-1720-467e-9227-ebacca79662e'::uuid, 'bd2dad93-36f3-4479-a5ce-cf04c1a4fd52'::uuid, '3d3c9a70-65b6-4939-95da-b8d701b31a44'::uuid, 'inventory_movement', '3618acfb-6c5f-41bc-a3df-40b48462ec60'::uuid, 'sale_cogs', '000-001-01-00001023', '2026-08-03'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 2800.00, 2800.00, 2, '478fdf2225e95b1b663f27a35036ff1e3a76119de8fb6d0c2d7b78d012938d6c', 'ce673fe254f219c8eadfde810ef9ef999d64899d8a5e96cf6a3bd16ac84b7dc6', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '1a8bc65c-a1fd-4521-a3a8-1ca7f0366268'::uuid, 'a23ee57c-ee18-4008-92ba-391c98899735'::uuid, 'e257fa43-41ae-48a2-80c5-960a4d69efa1'::uuid, 'inventory_movement', '45ea6d1f-82d4-4b65-bb57-7e2922d801e7'::uuid, 'sale_cogs', '000-001-01-00001023', '2026-08-03'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 2200.00, 2200.00, 2, '664db98fc32f57b934c792d8af9d95641ccd3a5ecddac8446e380b985c8f7c3b', '1f1cc68c420b3253b232841cebbfefc4290fdb166bc3cd036b6b5f370c8291e5', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '2d3b947d-70d8-4104-898d-195da8d3094b'::uuid, '464d7819-619d-4f60-aff2-438e5a780dc7'::uuid, '23dff238-57d0-49cf-9963-6c7a0d40d55a'::uuid, 'inventory_movement', 'fcfb71cc-e0cf-4083-a26f-b7305baeb81f'::uuid, 'sale_cogs', 'CZ-260803195704-AB20E7', '2026-08-03'::date, null, null, '2026-07-14'::date, 'orders.requested_invoice_date', 399.00, 399.00, 2, 'd3131e8a0b44aff84bbf582280afeded301b9edf4bf7f811709dc616eb722306', 'b68a6e69fa2ad48b62afcc864f36960c237485f39e58ff0efeae28b62ba41eb1', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '4bd4111e-e9a2-447f-ad92-0442c9434ad1'::uuid, '15828dc9-9ce5-45ae-b6b0-2fbe9567f575'::uuid, '1163ab54-0e10-442b-a4a3-2b771fbbf163'::uuid, 'inventory_movement', '806679c6-ef5c-4f72-bfaf-4c26b6e7ffe1'::uuid, 'sale_cogs', '000-001-01-00001023', '2026-08-03'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 1182.00, 1182.00, 2, '0cb994b0aeb3ff374ba6d22f90db64d083fc75a2413d411f9013b7a28ef5f703', '61858c5712f6d8b379f894f66aa918303a171645dd1fbb6f512ce666bd7f8da7', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '6739724a-b127-4e02-bbd6-d9b2f8ca7ae4'::uuid, '02e749e6-213a-470d-8b3c-538dba9a431b'::uuid, '5e07c932-ee08-477e-9536-64c6d4d90f46'::uuid, 'inventory_movement', '78f6ccdc-c812-4e61-a36e-677a783c22c0'::uuid, 'sale_cogs', '000-001-01-00001023', '2026-08-03'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 1170.00, 1170.00, 2, 'fed94ba4c873c51ce2f10d756d9304ac0e246ab819ce486c1514bcea9b2966a6', 'da6eefd83ba0f204295105463257cac8b72815e4406094106dc2b9a4311abc50', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '6a41b658-87fc-4803-b63d-1d18883030c4'::uuid, '917a1792-bd0c-4e24-8f38-75c8d8c2d396'::uuid, 'a011fae6-44da-4452-a681-7587be51f5c1'::uuid, 'inventory_movement', '67fc0e80-d843-415c-9ce1-a4b0740274aa'::uuid, 'sale_cogs', 'CZ-260803195704-AB20E7', '2026-08-03'::date, null, null, '2026-07-14'::date, 'orders.requested_invoice_date', 144.00, 144.00, 2, '72803b9bf1a817cb85929cf5a25dc38c936498b9b80714d3dc3d943d46048402', '797c92fcc7245be091645b70f28a54788aea06f9bc9bad54b721cbf67534ff75', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '711c2d4d-1eb0-4e8d-8e03-58956a4fc31f'::uuid, 'aad58c2a-66ed-419a-895d-814d31ca3a9c'::uuid, '19ca3e6d-7589-416e-b5e1-4523f4b7ac55'::uuid, 'order', '7371998d-7fb7-4286-bc92-1b3272686a2e'::uuid, 'customer_invoice', '000-001-01-00001023', '2026-08-03'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 18450.00, 18450.00, 3, '0015fa6c893c931093f9eb4731fec6a1592b6cec3a07dde8a83091fd4e46063b', '92fb04ae8507d283aea89c5ca6edb4c9dbfbdf5069c54750d6633e39cc6e7e8f', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '728dabd1-5d35-435b-8b6d-679db8551b26'::uuid, '96bbf832-466d-47e1-85cd-40095a8ca4a6'::uuid, '23537eb6-1440-4e61-8b91-2e816267e36f'::uuid, 'inventory_movement', 'b5215c9d-4a1f-4ec4-a048-1ae7fbdc7543'::uuid, 'sale_cogs', 'CZ-260803195704-AB20E7', '2026-08-03'::date, null, null, '2026-07-14'::date, 'orders.requested_invoice_date', 216.00, 216.00, 2, '24944a2d14dc113ec861af8d6d5f9a78c2423010fef0a54e68b11b844fca7d79', '5e7ee28f6abb96551320b09dc4a6ef7beb0c33eb3c98e0be73ebe2766e4a6a26', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '897c244f-063f-47ec-971b-1332e3159483'::uuid, '8c8486c8-28ac-4040-86d2-5fb1465f9cf1'::uuid, 'c1fe489b-640a-4ff0-b5a5-c199b3591344'::uuid, 'inventory_movement', '37dcb362-3621-4c0b-9636-e9ff5dbd78f9'::uuid, 'sale_cogs', 'CZ-260803195704-AB20E7', '2026-08-03'::date, null, null, '2026-07-14'::date, 'orders.requested_invoice_date', 144.00, 144.00, 2, '851c39b55ee7e531235d9f731c5aca6d73cb52f3fd2c856cd256f6b2dfb83c32', 'de6f4dce68b264cc904d718afb78c527738ce53c3ef60f2606aa77b03ce63692', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '89b6afd7-7608-4afd-97fc-f5f26c98e015'::uuid, '473a91c9-73cb-4dbb-be90-60e6b7fdaa3e'::uuid, '890811b1-7432-4d4f-866c-fba7b44dffc6'::uuid, 'inventory_movement', '889cca18-c6eb-4402-b170-1aa29de6d2e3'::uuid, 'sale_cogs', 'CZ-260803195704-AB20E7', '2026-08-03'::date, null, null, '2026-07-14'::date, 'orders.requested_invoice_date', 700.00, 700.00, 2, 'b6b3988d7a7193d48a9e82289b7a637f23f3157cae7c335237f6ab9be70444b6', '35ec4f0b3f700a41cccf733573101c069fa9de745461c2ba1c3077e900131557', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '8a76dcff-a019-4a04-8efc-c311fa6cbe49'::uuid, 'c76edcbe-c85b-434b-b8b7-7ba6ec88dc79'::uuid, '01734b61-cc57-4f67-8626-d59fbc7435e3'::uuid, 'supplier_payment', '68a60830-9aa9-4ce2-91f0-750c2bae8221'::uuid, 'supplier_payment', '412472690/COMPRA DE DIVISSA 430$', '2026-08-03'::date, null, null, '2026-07-13'::date, 'supplier_payments.paid_at', 11565.84, 11565.84, 2, 'e31a39a98c90d0b6ebc8c3720ef3d3ebecccb6346dcabc6005e85e272b34c00b', '13b572f76c7bc320b090c8508a57e41db3dec2350e38c30eef694414165ba34e', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '8e120422-bfb4-4bc3-b91b-1280fb7a6641'::uuid, '3e69c6b7-2243-4cb8-9b54-91a2d1f40ed1'::uuid, '3abefbca-3eb6-4bcd-a3c9-f61bf39a0cdc'::uuid, 'inventory_movement', '8355a93f-4d33-4c25-a2c9-5c9ee0d34ff4'::uuid, 'sale_cogs', 'CZ-260803195704-AB20E7', '2026-08-03'::date, null, null, '2026-07-14'::date, 'orders.requested_invoice_date', 700.00, 700.00, 2, '0227a05422f845413ddc7a7e2b6daefdb71339c0660b54cdf8fdcfd23866c2d0', '254e27661328fbe8620b9382b3cdce4dd1b9a468fc55e7ae885845e301ac7d66', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'a5d20df0-2a0f-4ed5-8657-43d18f58d334'::uuid, '90acdcbd-174a-47cf-901e-11bf26c5d827'::uuid, '4040d762-9cd3-4ad5-a8fe-7df8e6d71b82'::uuid, 'inventory_movement', '5a08fec5-e67d-44ad-8f4c-5876018eeacd'::uuid, 'sale_cogs', 'CZ-260803195704-AB20E7', '2026-08-03'::date, null, null, '2026-07-14'::date, 'orders.requested_invoice_date', 144.00, 144.00, 2, '249861b0a8fc023850101a658894122b7bca14246b19efd2302997da8b52489d', 'c7ab161e69d86a31ea205886df3fe3a229ec76578fe7615d9072e09f475031ca', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'b3c9425d-b19e-4bed-b3cc-79190c41413a'::uuid, '218c0e18-8b7c-4ad1-adef-371d82d9dcc3'::uuid, 'd1a568c0-f11e-4b5b-af58-b55a7a6a1f2b'::uuid, 'inventory_movement', '90da6f92-c3d6-4b32-be65-637c2cec513d'::uuid, 'sale_cogs', '000-001-01-00001023', '2026-08-03'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 2200.00, 2200.00, 2, '0b0626d45a6d9196ec668f763e3f13e3ba07fe75539ca6b3fdc804e08b580238', '2df131946058e2cbc9dbdb45af28fbc8001e95b276622404e16c468429daceb7', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'bd581f0c-e382-4140-9fca-33a44a02d8f8'::uuid, '6c010426-32c1-494e-8128-90221abb04f7'::uuid, '06f1cd6f-f1b0-408c-89de-f03fbc61fcb7'::uuid, 'supplier_payment', '1647687c-8191-46e3-ac25-6adff804e317'::uuid, 'supplier_payment', '412482862/FACT#52341-52810-52799-52640', '2026-08-03'::date, null, null, '2026-07-27'::date, 'supplier_payments.paid_at', 16762.50, 16762.50, 2, '83601952d64331555d9613b4e4d2f588ef8da4593f2cf8eda946ca440d9c77b3', '3a4a4f45552db3bf625c1b33af9fbf61e5597685e9601e38434b955501cb925d', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'bda720ff-404a-4b79-a790-7b7ba78b2108'::uuid, '76facbf6-bca1-483d-9b96-95396066a3a9'::uuid, '9f6cf1e4-bb4b-4eee-9764-c1868d819246'::uuid, 'inventory_movement', 'c8a00836-c333-43f5-94c3-831cf7d7ea73'::uuid, 'sale_cogs', 'CZ-260803195704-AB20E7', '2026-08-03'::date, null, null, '2026-07-14'::date, 'orders.requested_invoice_date', 660.86, 660.86, 2, 'c0f0a0705d4da10630c8602803a308c39ce6d72f98e4f8e3eafd6fff61d74e5a', 'c84408cd51ade0749972f334d422da3f618e270160a3c037b02cc7cbef471f85', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'c729d941-eb0e-4af6-84b6-a66a1ae82f7b'::uuid, 'ea821ba7-b2a4-46ed-a637-025ec637f97a'::uuid, '3c740232-4fdb-4bcf-924b-5aad51f3c1c6'::uuid, 'supplier_payment', '2ef116eb-d5d1-4288-a94a-d6743baf141c'::uuid, 'supplier_payment', '412424517/COMPRA DE DIVISAS $1,000.00', '2026-08-03'::date, null, null, '2026-07-11'::date, 'supplier_payments.paid_at', 26897.30, 26897.30, 2, '5ec3284a1f98eed67bc08c36e3877d0b5e0b9362b8c944c83ffab82e3f38c9a5', 'add934d7e6813420ebe0e0744d392e7aff9131f0b6a4dbff303797ef6de68e6d', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'cb02df15-12c6-4220-aff4-33f7d1c3012d'::uuid, '7e5bdf23-b86e-492e-9e42-2f23ec34b19e'::uuid, 'da170dde-a65c-405f-a59f-579d6afbe8cf'::uuid, 'inventory_movement', 'ea6eac1e-30f7-407b-8ad2-6e32b4822f67'::uuid, 'sale_cogs', 'CZ-260803195704-AB20E7', '2026-08-03'::date, null, null, '2026-07-14'::date, 'orders.requested_invoice_date', 1533.00, 1533.00, 2, '89a6ad5eabfe6ae95a403bde6386093154014ee87c7d64c00f76b64ac4c70771', '3664bfc7f8ab5d79134870b2a955a6fc39418083ab23e18a9be07b13981cc287', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'cb1eeb3a-158f-47e6-8520-ae5a1fbca573'::uuid, '1a04dac8-16eb-497b-be50-195fbced3026'::uuid, '22a291eb-801e-459f-8880-b122c6a53b5d'::uuid, 'order', '570b489d-b70c-476f-911a-a4b157f03c58'::uuid, 'order', 'CZ-260803195704-AB20E7', '2026-08-03'::date, null, null, '2026-07-14'::date, 'orders.requested_invoice_date', 8550.00, 8550.00, 3, '80d55d60e89766ca2f322118a5b1ebaff19a745b60ad856c72a17224be550462', '1c02c86d2684b559df3fa539d98701935c2ab711de9d164ee4a9c8acb0b1c122', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'e5e09fc8-c44c-4c12-9e99-b33ad43bb2a2'::uuid, 'ac051205-f606-4b72-8b78-b00134d9bd8a'::uuid, '7dcba8aa-3af9-4afd-9573-9ba2a8a780c3'::uuid, 'inventory_movement', '830f8008-3ba1-4b25-9a0e-22b38f7d579a'::uuid, 'sale_cogs', 'CZ-260803195704-AB20E7', '2026-08-03'::date, null, null, '2026-07-14'::date, 'orders.requested_invoice_date', 144.00, 144.00, 2, '03574fa56b73478a840ac2f03e7aa29bf0926f3ad2767324f2197d3f8d47d9f8', 'acea54a893a996ba855f2f7210fef46919ca9264d55c56d53e2d815d62b4ae75', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'eaddcb08-0342-4f99-ab15-d174aaa9bec3'::uuid, 'e2d15361-8a9d-4c05-848e-90f5905c5078'::uuid, '7bea87bd-3dde-40e6-81c8-c3929295b20f'::uuid, 'inventory_movement', 'd3529134-feba-4e75-aa45-dc81e557aaa7'::uuid, 'sale_cogs', '000-001-01-00001023', '2026-08-03'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 845.22, 845.22, 2, 'e1fbb79c2ee19798fe507a21d3cf0f2527c45d95eb0276310a55bd5319ba3b47', '88e6f7f43bbc69b844ba5917cf0e4716858ae38d6ea9f4cc16abab44c9047b55', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'fc7e9205-c542-40c1-b809-fd96663e5be0'::uuid, '64988091-bede-454c-be87-f4b93570c173'::uuid, '6cc5aae1-8345-4a8b-919f-d8e399d1b69d'::uuid, 'inventory_movement', '0b6719a9-2b70-4dfd-a2af-5e7cbaeb24f6'::uuid, 'sale_cogs', '000-001-01-00001023', '2026-08-03'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 326.09, 326.09, 2, 'b164f5b5046b0ec0d8a4319b2a1bcc3ca2047cb40ae15c480fa920cd764e585f', '4f252d5e95ab3ceecf7c56a4899cad1bcf5a80de42009a43949602182ab461fb', 'A'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '03ace245-f2b6-40a4-9252-393aa69fdbef'::uuid, '93b321f4-f556-4130-9fbd-a897c65e7fa5'::uuid, null, 'inventory_movement', 'f5d3e818-4720-4b59-9f77-a47265de10b1'::uuid, 'sale_cogs', '000-001-01-00001017', '2026-07-27'::date, null, null, '2026-07-13'::date, 'invoices.invoice_date', 500.00, 500.00, 2, '015ea9ee6265923d8d82e55a9da9d7e8ded3a64eadcf1775ddda20335e6676d2', '4600a3fc79ae5c172865c6a37f1cdac95fb113a5824bcdc99597f32ee0fe92d3', 'B'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '26571769-cea5-4979-bfdb-f4de286af6d1'::uuid, '992f35cb-152e-4d6c-9f98-b34a2d5d868e'::uuid, null, 'order', '2d6f5276-a507-4151-9698-4f81904ca35f'::uuid, 'customer_invoice', '000-001-01-00001017', '2026-07-27'::date, null, null, '2026-07-13'::date, 'invoices.invoice_date', 1200.00, 1200.00, 3, 'b039e7cf26daa27841164955e7f98d8a1b8b7d8cdf18ad82649e7918e9f93151', '35b452604599cd98a6155004e4eebd3815c9aa96ab5b5ef35b8ae1bc7a9695a0', 'B'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '2f133a29-17da-43d0-b1b1-ee8a853d48cc'::uuid, 'd1a9f452-af86-4e8b-aeef-1ac3758a0370'::uuid, 'a8eec133-2ae0-4226-a1d8-824712e0285a'::uuid, 'inventory_movement', '972602df-fc64-42e2-b9af-cdd447a0b340'::uuid, 'sale_cogs', '000-001-01-00001021', '2026-07-31'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 707.25, 707.25, 2, '643b2fc4c41db18b96f559596502313a5bd379c9556806d0851cd5f26ed1324a', 'cef9888f48acedfb7ce2c3d58687501e8d61e7302cff2a0e3891bc2ce42c57ef', 'B'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '4a5ca5ee-d6a3-4f5d-b1d8-0ecf00d5f5a0'::uuid, '5daddf43-db26-4305-bbdb-0ddfb48d19f0'::uuid, '70a7aa6f-c315-42ef-9c11-ba1d48d10cb3'::uuid, 'order', '56aeffe1-9347-4475-974c-370be67ee981'::uuid, 'customer_invoice', '000-001-01-00001021', '2026-07-31'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 3950.00, 3950.00, 3, '70ecb2d8b1e60e6e678bdee6d37da8b68162075e3a739606a3b80c56cb5bcbf3', 'ca96667165915320bf8c8f364352abbe43b90df764885610ed7cd78419b8144d', 'B'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '6e0bec04-7be9-4aff-9b44-ae416fdc2d76'::uuid, '3607b5e3-ca93-4901-a774-388bf57b911e'::uuid, null, 'inventory_movement', '37a5d450-08df-4df2-ba5c-1c6b0b831080'::uuid, 'sale_cogs', '000-001-01-00001018', '2026-07-27'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 663.00, 663.00, 2, '74afc08ad478c08e34686191b6f5cfc57f10995dfc6fb6abd9cd5fab12bf0cef', 'a5522c8cb18e18887fd69917cb9252e340801fd8750ef75d35661eb78415476d', 'B'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '7a15e001-d4a6-4cbb-a4b6-df50d9cfdafe'::uuid, '3d973ed8-b9db-4fbe-9772-fe4edd0dcb01'::uuid, '45bcaff7-e87b-48d8-87d9-5bb6d6c2dd69'::uuid, 'inventory_movement', '86650a7a-16e7-426f-9b40-6099e34c7cc8'::uuid, 'sale_cogs', '000-001-01-00001019', '2026-07-28'::date, null, null, '2026-07-15'::date, 'invoices.invoice_date', 8000.00, 8000.00, 2, '6b2daa3d9d7e7230ac28c418224952234717743c1845cb495b05c50f8d2eb067', 'b160c84ca6e6bc0ac1cf8719b7e3b47d63ebdf152e21cdefc636485f9bad35ba', 'B'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', '90ce4ab2-bfd3-429e-9f24-bc744c6891c5'::uuid, '7e9354cb-ce73-4042-9e20-f60c21e49213'::uuid, '0c9a458f-aa89-46cd-be53-e445c84a929d'::uuid, 'inventory_movement', 'c5f67eb1-b2a4-466a-b95b-c17cc7cb3ab7'::uuid, 'sale_cogs', '000-001-01-00001021', '2026-07-31'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 505.00, 505.00, 2, '4a758476000010787a4fcaf03c45e3c50c50aef497336420363fa68b73b79edf', '8e0898bcf096edd5542bc9c824dac6e9300848b180c10965e6ae0cdfbc4efe0c', 'B'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'bc7e1490-cda1-4d3e-a55f-a6aa9de90289'::uuid, '2e7df624-ead6-4b8a-a7bd-3dff8bea1063'::uuid, null, 'inventory_movement', 'c098b46a-49ee-4584-a5a2-4dc53444eacc'::uuid, 'sale_cogs', '000-001-01-00001017', '2026-07-27'::date, null, null, '2026-07-13'::date, 'invoices.invoice_date', 209.00, 209.00, 2, '5f946c78291d8dcd4a17319237ec0b3826bdfa70432974dcc78eb70980b5a599', '0ee1399705d9c141e3bb04dabb56d8ea991fc2a53bf1620595cde141d2915646', 'B'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'c88e9235-1838-46cd-9547-b16b90ff0c5b'::uuid, '038492f4-482f-4965-bf3e-1bf7cb36b9e7'::uuid, null, 'order', '638187f9-abce-4518-af6c-8518b1ab71fe'::uuid, 'customer_invoice', '000-001-01-00001018', '2026-07-27'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 1300.00, 1300.00, 3, '50f5f109aeeb837b78297b16c1421833e0c853b7b5b5ecd69c44959133761739', 'aed1ef9ebce296c8c4327c1e21cfe9213dd2ddf11cdd18e4604b194e76c7c5c6', 'B'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'c8fef0ab-44df-46f1-a869-9f0b0ed58e19'::uuid, '752dfc14-6e95-43b2-bd49-21af7c5a3f6c'::uuid, '5b3dad1e-5a30-4732-8712-1ec3a888f859'::uuid, 'supplier_payment', 'c8c47ce4-e4c7-4102-9594-413f27e97efe'::uuid, 'supplier_payment', 'c8c47ce4-e4c7-4102-9594-413f27e97efe', '2026-07-30'::date, null, null, '2026-07-23'::date, 'supplier_payments.paid_at', 4710.00, 4710.00, 2, 'e71968d5d79d02f64baec0a44d5d9ade7996b24fb72085ad60335dde7fcf438b', 'c6bb875d66151434b10fafd118e179700f8457b5e3683773ea78ae2e626096a1', 'B'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'e0ca58b8-606c-45c3-9586-8d050cca3df1'::uuid, 'e801a9a5-0115-4a82-b7a4-669796a963a8'::uuid, '2ac79f8b-408c-429b-92dc-98d501c3bca4'::uuid, 'inventory_movement', '76055dee-fc2a-46cd-8ff0-4a6d0fc98e34'::uuid, 'sale_cogs', '000-001-01-00001021', '2026-07-31'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 150.00, 150.00, 2, '0fd1a98a695ee8c905da212980f03336fda72f6e8baaad51e9abb9b479539768', 'd9f2256465e144ff44949a652f78a7cfe0ba6f071f9f5f63dd394b22bc1a7504', 'B'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'f3f57273-a206-4c47-b934-6a2fca783b28'::uuid, '91271a82-1c1d-486b-b444-98da49893d9b'::uuid, '9e2393a3-aa2e-43cf-b437-062960b4626f'::uuid, 'supplier_payment', '6a9b4063-a65e-4128-adfd-6e7b1ddce261'::uuid, 'supplier_payment', '6a9b4063-a65e-4128-adfd-6e7b1ddce261', '2026-07-29'::date, null, null, '2026-07-13'::date, 'supplier_payments.paid_at', 3200.00, 3200.00, 2, 'ee9f5ab81228abdd6200556ff616344ad2743fc3c3c48a27529c4bfd45399002', '404cfc610f91cc3780c8cfe7a09f24f809fab98f4a054866226cef0ee4d51265', 'B'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'f7e497d6-38a7-4af5-a537-c94a54599d8d'::uuid, '9461d15b-e4df-4ef6-be1b-a1884f6833d5'::uuid, 'd245f934-9084-404a-8306-72e17a3be9d0'::uuid, 'inventory_movement', '5378f525-0965-4297-ae21-868b88433b08'::uuid, 'sale_cogs', '000-001-01-00001021', '2026-07-31'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 150.00, 150.00, 2, '93ff5d9abdcb4ddaf8387d948c3efc150b45755e50727d2935ad9d4638207e6a', 'f8b661a94100fdf3eb41ccf4701315c5603af2da76d2bb4916079359b6f4e5b8', 'B'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'f8650f19-7837-4796-9b11-f59456656e29'::uuid, 'ca203a59-92ce-425a-8308-82b02e7e231b'::uuid, '3ec7c0f9-76d8-4a74-b7d8-6c8fa2db8f59'::uuid, 'order', 'b0a09603-f40d-49a1-8469-a91cdc1407df'::uuid, 'customer_invoice', '000-001-01-00001019', '2026-07-28'::date, null, null, '2026-07-15'::date, 'invoices.invoice_date', 11000.00, 11000.00, 3, '353ff2135a95b34c98c3ac18298efd5ba710cf48a89cf7117363741ec88789ef', '254901ed9fa661b1b3abea4121e0e490483d30b997c96b7d2c18e6f185ff2e51', 'B'),
  ('45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857', 'f9ddec33-2a73-4f28-880d-fb093f3dabaf'::uuid, 'd493e025-66ca-4720-a528-f57a7427976a'::uuid, '5477d8ac-5e37-4564-8789-a12feaf4f23b'::uuid, 'inventory_movement', 'cad270d7-9550-401a-bd2f-12c49323b9be'::uuid, 'sale_cogs', '000-001-01-00001021', '2026-07-31'::date, null, null, '2026-07-14'::date, 'invoices.invoice_date', 927.53, 927.53, 2, 'e2b014d55db168c60d3991137857c31db0b251ca69bd303c526b3715e515d8cc', '3bd8ccdfea92f27139197bdbd664cbb632d56933b02191fb33c5b62160e3aabe', 'B')
on conflict (manifest_hash, journal_entry_id) do nothing;
-- MANIFEST_VALUES_END

do $repair$
declare
  target_hash constant text := '45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857';
  target_migration constant text := '202608030004_accounting_historical_date_repair.sql';
  batch public.accounting_entry_date_repair_batches%rowtype;
  item record;
  matched_count integer;
  total_entries bigint;
  actual_count integer;
  actual_debit numeric(14,2);
  actual_credit numeric(14,2);
  actual_line_count integer;
  actual_line_debit numeric(14,2);
  actual_line_credit numeric(14,2);
  actual_line_hash text;
  manifest_outbox_count integer;
  migration_role name := current_user;
  transaction_marker text := txid_current()::text;
  strict_guard_definition text;
  supplier_observer_definition text;
  opening_observer_definition text;
  captured_guard_hash_before text;
  captured_guard_hash_after text;
  supplier_observer_hash_before text;
  opening_observer_hash_before text;
  guard_rejected boolean := false;
  audit_action text := 'repair';
begin
  perform pg_advisory_xact_lock(hashtextextended(
    'accounting_historical_date_repair:' || target_hash, 0
  ));

  select * into batch
  from public.accounting_entry_date_repair_batches
  where manifest_hash = target_hash
  for update;
  if batch.manifest_hash is null
    or batch.migration_name <> target_migration
    or batch.expected_count <> 37
    or batch.expected_debit <> 134905.59
    or batch.expected_credit <> 134905.59
  then
    raise exception using errcode = '23514', message = 'ACCOUNTING_DATE_REPAIR_BATCH_MISMATCH';
  end if;

  select count(*) into matched_count
  from public.accounting_entry_date_repair_manifest manifest
  join public.journal_entries entry on entry.id = manifest.journal_entry_id
  where manifest.manifest_hash = target_hash;
  select count(*) into total_entries from public.journal_entries;
  if matched_count = 0 and total_entries = 0 then
    raise notice 'ACCOUNTING_DATE_REPAIR_LOCAL_EMPTY_SCHEMA_SKIP';
    return;
  end if;

  lock table public.journal_entries in access exclusive mode;
  lock table public.journal_entry_lines in share mode;
  lock table public.financial_events in share row exclusive mode;
  lock table public.accounting_outbox_v2 in share row exclusive mode;
  lock table public.orders, public.invoices, public.inventory_movements,
    public.supplier_payments, public.suppliers, public.accounting_periods in share mode;

  if batch.status = 'applied' then
    if (select count(*) from public.accounting_entry_date_repairs audit
        where audit.manifest_hash = target_hash and audit.action = 'repair') = 37
      and not exists (
        select 1
        from public.accounting_entry_date_repair_manifest manifest
        join public.journal_entries entry on entry.id = manifest.journal_entry_id
        join public.financial_events event on event.id = manifest.financial_event_id
        left join public.accounting_outbox_v2 box
          on box.id = manifest.accounting_outbox_id
        where manifest.manifest_hash = target_hash
          and (entry.entry_date is distinct from manifest.new_accounting_date
            or event.accounting_date is distinct from manifest.new_accounting_date
            or (manifest.accounting_outbox_id is not null
              and (box.accounting_date is distinct from manifest.new_accounting_date
                or box.accounting_date_source is distinct from manifest.accounting_date_source))
            or public.accounting_entry_date_repair_line_hash_v1(entry.id)
              <> manifest.line_hash)
      )
    then
      raise notice 'ACCOUNTING_DATE_REPAIR_ALREADY_APPLIED';
      return;
    end if;
    raise exception using errcode = '55000', message = 'ACCOUNTING_DATE_REPAIR_APPLIED_STATE_MISMATCH';
  end if;
  if batch.status not in ('approved', 'rolled_back') then
    raise exception using errcode = '55000', message = 'ACCOUNTING_DATE_REPAIR_BATCH_STATE_INVALID';
  end if;
  if batch.status = 'approved' and exists (
    select 1 from public.accounting_entry_date_repairs
    where manifest_hash = target_hash
  ) then
    raise exception using errcode = '23514', message = 'ACCOUNTING_DATE_REPAIR_UNEXPECTED_PRIOR_AUDIT';
  end if;
  if batch.status = 'rolled_back' then
    if (select count(*) from public.accounting_entry_date_repairs
        where manifest_hash = target_hash and action = 'repair') <> 37
      or (select count(*) from public.accounting_entry_date_repairs
        where manifest_hash = target_hash and action = 'rollback') <> 37
      or exists (select 1 from public.accounting_entry_date_repairs
        where manifest_hash = target_hash and action = 'reapply')
    then
      raise exception using errcode = '23514', message = 'ACCOUNTING_DATE_REPAIR_REAPPLY_AUDIT_STATE_INVALID';
    end if;
    audit_action := 'reapply';
  end if;

  select count(*), round(coalesce(sum(debit_total), 0), 2),
    round(coalesce(sum(credit_total), 0), 2),
    count(accounting_outbox_id)
  into actual_count, actual_debit, actual_credit, manifest_outbox_count
  from public.accounting_entry_date_repair_manifest
  where manifest_hash = target_hash;
  if actual_count <> 37
    or actual_debit <> 134905.59
    or actual_credit <> 134905.59
    or actual_debit <> actual_credit
    or manifest_outbox_count <> 32
  then
    raise exception using errcode = '23514', message = 'ACCOUNTING_DATE_REPAIR_MANIFEST_TOTAL_MISMATCH';
  end if;

  for item in
    select manifest.*, entry.status, entry.source_type entry_source_type,
      entry.source_id entry_source_id, entry.reversed_entry_id,
      event.source_type event_source_type, event.source_id event_source_id,
      event.event_purpose, event.accounting_date event_accounting_date,
      box.id current_outbox_id, box.status outbox_status,
      box.source_type outbox_source_type, box.source_id outbox_source_id,
      box.event_purpose outbox_event_purpose,
      box.financial_event_id outbox_event_id,
      box.journal_entry_id outbox_entry_id,
      box.accounting_date outbox_accounting_date
    from public.accounting_entry_date_repair_manifest manifest
    join public.journal_entries entry on entry.id = manifest.journal_entry_id
    join public.financial_events event on event.id = manifest.financial_event_id
    left join public.accounting_outbox_v2 box
      on box.id = manifest.accounting_outbox_id
    where manifest.manifest_hash = target_hash
    order by manifest.journal_entry_id
    for update of entry, event
  loop
    select count(*), round(coalesce(sum(line.debit), 0), 2),
      round(coalesce(sum(line.credit), 0), 2)
    into actual_line_count, actual_line_debit, actual_line_credit
    from public.journal_entry_lines line
    where line.journal_entry_id = item.journal_entry_id;
    actual_line_hash := public.accounting_entry_date_repair_line_hash_v1(
      item.journal_entry_id
    );

    if item.status <> 'publicada'
      or item.entry_source_type <> 'financial_event'
      or item.entry_source_id <> item.financial_event_id::text
      or item.event_source_type <> item.source_type
      or item.event_source_id <> item.source_id::text
      or item.reversed_entry_id is not null
      or exists (
        select 1 from public.journal_entries reversal
        where reversal.source_type = 'journal_reversal'
          and reversal.source_id = item.journal_entry_id::text
      )
      or item.old_entry_date is distinct from (
        select entry_date from public.journal_entries where id = item.journal_entry_id
      )
      or item.event_accounting_date is distinct from item.old_event_accounting_date
      or actual_line_count <> item.line_count
      or actual_line_debit <> item.debit_total
      or actual_line_credit <> item.credit_total
      or actual_line_debit <> actual_line_credit
      or actual_line_hash <> item.line_hash
      or public.resolve_canonical_accounting_date_v1(
        item.source_type, item.source_id, item.event_purpose
      ) is distinct from item.new_accounting_date
      or public.is_date_in_closed_accounting_period(item.new_accounting_date)
      or item.source_type not in ('order', 'inventory_movement', 'supplier_payment')
      or item.document_number = '0090915'
      or (item.accounting_outbox_id is not null and (
        item.current_outbox_id is null
        or item.outbox_status <> 'completed'
        or item.outbox_source_type <> item.source_type
        or item.outbox_source_id <> item.source_id
        or item.outbox_event_purpose <> item.event_purpose
        or item.outbox_event_id <> item.financial_event_id
        or item.outbox_entry_id <> item.journal_entry_id
        or item.outbox_accounting_date is distinct from item.old_outbox_accounting_date
      ))
      or (item.source_type = 'supplier_payment' and exists (
        select 1
        from public.supplier_payments payment
        join public.suppliers supplier on supplier.id = payment.supplier_id
        where payment.id = item.source_id and supplier.name ilike '%CROMOS%'
      ))
    then
      raise exception using errcode = '23514',
        message = 'ACCOUNTING_DATE_REPAIR_PRECONDITION_FAILED',
        detail = item.journal_entry_id::text;
    end if;
  end loop;

  create temporary table accounting_entry_date_repair_before
  on commit drop
  as
  select manifest.journal_entry_id, manifest.financial_event_id,
    manifest.accounting_outbox_id,
    to_jsonb(entry) entry_row, to_jsonb(event) event_row,
    case when box.id is null then null else to_jsonb(box) end outbox_row
  from public.accounting_entry_date_repair_manifest manifest
  join public.journal_entries entry on entry.id = manifest.journal_entry_id
  join public.financial_events event on event.id = manifest.financial_event_id
  left join public.accounting_outbox_v2 box
    on box.id = manifest.accounting_outbox_id
  where manifest.manifest_hash = target_hash;

  select pg_get_functiondef('public.guard_journal_entry_status()'::regprocedure),
    encode(extensions.digest(pg_get_functiondef(
      'public.guard_journal_entry_status()'::regprocedure), 'sha256'), 'hex'),
    pg_get_functiondef('public.observe_supplier_payment_outbox_v2()'::regprocedure),
    pg_get_functiondef(
      'public.observe_opening_balance_supplier_payment_completion_v1()'::regprocedure
    )
  into strict_guard_definition, captured_guard_hash_before,
    supplier_observer_definition, opening_observer_definition;
  supplier_observer_hash_before := encode(extensions.digest(
    supplier_observer_definition, 'sha256'), 'hex');
  opening_observer_hash_before := encode(extensions.digest(
    opening_observer_definition, 'sha256'), 'hex');
  if strict_guard_definition is null
    or supplier_observer_definition is null
    or opening_observer_definition is null
  then
    raise exception using errcode = '55000', message = 'ACCOUNTING_DATE_REPAIR_GUARD_DEFINITION_MISSING';
  end if;

  perform set_config('app.accounting_date_repair_manifest_hash', target_hash, true);
  perform set_config('app.accounting_date_repair_transaction', transaction_marker, true);

  execute format($ddl$
    create or replace function public.guard_journal_entry_status()
    returns trigger
    language plpgsql
    as $restricted_guard$
    begin
      if tg_op = 'UPDATE'
        and current_user = %L
        and current_setting('app.accounting_date_repair_manifest_hash', true) = %L
        and current_setting('app.accounting_date_repair_transaction', true) = txid_current()::text
        and (to_jsonb(new) - 'entry_date') is not distinct from (to_jsonb(old) - 'entry_date')
        and exists (
          select 1
          from public.accounting_entry_date_repair_manifest manifest
          where manifest.manifest_hash = %L
            and manifest.journal_entry_id = old.id
            and old.status = 'publicada'
            and old.entry_date = manifest.old_entry_date
            and new.entry_date = manifest.new_accounting_date
        )
      then
        return new;
      end if;

      if tg_op = 'DELETE' then
        if old.status <> 'borrador' then
          raise exception 'Las partidas publicadas no se eliminan. Debes registrar un reverso.';
        end if;
        return old;
      end if;
      if old.status in ('reversada', 'anulada') then
        raise exception 'Esta partida ya no admite cambios.';
      end if;
      if old.status = 'publicada' then
        if new.status = 'reversada'
          and new.reversed_entry_id is not null
          and new.entry_number = old.entry_number
          and new.entry_date = old.entry_date
          and new.description = old.description
          and coalesce(new.source_type, '') = coalesce(old.source_type, '')
          and coalesce(new.source_id, '') = coalesce(old.source_id, '')
          and new.created_by = old.created_by
          and new.posted_by = old.posted_by
          and new.posted_at = old.posted_at
        then
          return new;
        end if;
        raise exception 'Las partidas publicadas no se editan. Debes registrar un reverso.';
      end if;
      return new;
    end;
    $restricted_guard$
  $ddl$, migration_role, target_hash, target_hash);

  execute $observer$
    create or replace function public.observe_supplier_payment_outbox_v2()
    returns trigger language plpgsql security definer
    set search_path = public, pg_temp
    as $body$ begin return new; end; $body$
  $observer$;
  execute $observer$
    create or replace function public.observe_opening_balance_supplier_payment_completion_v1()
    returns trigger language plpgsql security definer
    set search_path = public, pg_temp
    as $body$ begin return new; end; $body$
  $observer$;

  update public.financial_events event
  set accounting_date = manifest.new_accounting_date
  from public.accounting_entry_date_repair_manifest manifest
  where manifest.manifest_hash = target_hash
    and event.id = manifest.financial_event_id;

  update public.accounting_outbox_v2 box
  set accounting_date = manifest.new_accounting_date,
      accounting_date_source = manifest.accounting_date_source
  from public.accounting_entry_date_repair_manifest manifest
  where manifest.manifest_hash = target_hash
    and manifest.accounting_outbox_id is not null
    and box.id = manifest.accounting_outbox_id;

  update public.journal_entries entry
  set entry_date = manifest.new_accounting_date
  from public.accounting_entry_date_repair_manifest manifest
  where manifest.manifest_hash = target_hash
    and entry.id = manifest.journal_entry_id;

  execute strict_guard_definition;
  execute supplier_observer_definition;
  execute opening_observer_definition;
  perform set_config('app.accounting_date_repair_manifest_hash', '', true);
  perform set_config('app.accounting_date_repair_transaction', '', true);

  captured_guard_hash_after := encode(extensions.digest(pg_get_functiondef(
    'public.guard_journal_entry_status()'::regprocedure), 'sha256'), 'hex');
  if captured_guard_hash_after <> captured_guard_hash_before
    or encode(extensions.digest(pg_get_functiondef(
      'public.observe_supplier_payment_outbox_v2()'::regprocedure), 'sha256'), 'hex')
      <> supplier_observer_hash_before
    or encode(extensions.digest(pg_get_functiondef(
      'public.observe_opening_balance_supplier_payment_completion_v1()'::regprocedure
    ), 'sha256'), 'hex') <> opening_observer_hash_before
  then
    raise exception using errcode = '55000', message = 'ACCOUNTING_DATE_REPAIR_GUARD_RESTORE_FAILED';
  end if;

  if exists (
    select 1
    from public.accounting_entry_date_repair_manifest manifest
    join public.journal_entries entry on entry.id = manifest.journal_entry_id
    join public.financial_events event on event.id = manifest.financial_event_id
    left join public.accounting_outbox_v2 box on box.id = manifest.accounting_outbox_id
    join pg_temp.accounting_entry_date_repair_before before_row
      on before_row.journal_entry_id = manifest.journal_entry_id
    where manifest.manifest_hash = target_hash
      and (entry.entry_date is distinct from manifest.new_accounting_date
        or event.accounting_date is distinct from manifest.new_accounting_date
        or (manifest.accounting_outbox_id is not null and (
          box.accounting_date is distinct from manifest.new_accounting_date
          or box.accounting_date_source is distinct from manifest.accounting_date_source
        ))
        or public.accounting_entry_date_repair_line_hash_v1(entry.id) <> manifest.line_hash
        or (to_jsonb(entry) - 'entry_date' - 'updated_at')
          is distinct from (before_row.entry_row - 'entry_date' - 'updated_at')
        or (to_jsonb(event) - 'accounting_date' - 'updated_at')
          is distinct from (before_row.event_row - 'accounting_date' - 'updated_at')
        or (manifest.accounting_outbox_id is not null
          and (to_jsonb(box) - 'accounting_date' - 'accounting_date_source' - 'updated_at')
            is distinct from (before_row.outbox_row - 'accounting_date' - 'accounting_date_source' - 'updated_at')))
  ) then
    raise exception using errcode = '23514', message = 'ACCOUNTING_DATE_REPAIR_POSTCONDITION_FAILED';
  end if;

  insert into public.accounting_entry_date_repairs (
    manifest_hash, migration_name, action,
    journal_entry_id, financial_event_id, accounting_outbox_id,
    source_type, source_id, document_number,
    old_entry_date, new_entry_date,
    old_event_accounting_date, new_event_accounting_date,
    old_outbox_accounting_date, new_outbox_accounting_date,
    debit_total, credit_total, line_count, line_hash, source_hash,
    reason, before_state, after_state, executed_by
  )
  select manifest.manifest_hash, target_migration, audit_action,
    manifest.journal_entry_id, manifest.financial_event_id,
    manifest.accounting_outbox_id, manifest.source_type, manifest.source_id,
    manifest.document_number, manifest.old_entry_date, manifest.new_accounting_date,
    manifest.old_event_accounting_date, manifest.new_accounting_date,
    manifest.old_outbox_accounting_date,
    case when manifest.accounting_outbox_id is null then null
      else manifest.new_accounting_date end,
    manifest.debit_total, manifest.credit_total, manifest.line_count,
    manifest.line_hash, manifest.source_hash,
    'Corrección de fecha contable canónica: el flujo V2 utilizó una fecha técnica en lugar de la fecha efectiva del documento.',
    jsonb_build_object(
      'entry_date', before_row.entry_row->'entry_date',
      'event_accounting_date', before_row.event_row->'accounting_date',
      'outbox_accounting_date', before_row.outbox_row->'accounting_date',
      'entry_status', before_row.entry_row->'status',
      'entry_description', before_row.entry_row->'description',
      'entry_source_type', before_row.entry_row->'source_type',
      'entry_source_id', before_row.entry_row->'source_id',
      'posted_at', before_row.entry_row->'posted_at',
      'line_hash', manifest.line_hash
    ),
    jsonb_build_object(
      'entry_date', entry.entry_date,
      'event_accounting_date', event.accounting_date,
      'outbox_accounting_date', box.accounting_date,
      'entry_status', entry.status,
      'entry_description', entry.description,
      'entry_source_type', entry.source_type,
      'entry_source_id', entry.source_id,
      'posted_at', entry.posted_at,
      'line_hash', public.accounting_entry_date_repair_line_hash_v1(entry.id)
    ), migration_role
  from public.accounting_entry_date_repair_manifest manifest
  join pg_temp.accounting_entry_date_repair_before before_row
    on before_row.journal_entry_id = manifest.journal_entry_id
  join public.journal_entries entry on entry.id = manifest.journal_entry_id
  join public.financial_events event on event.id = manifest.financial_event_id
  left join public.accounting_outbox_v2 box on box.id = manifest.accounting_outbox_id
  where manifest.manifest_hash = target_hash;

  if (select count(*) from public.accounting_entry_date_repairs
      where manifest_hash = target_hash and action = audit_action) <> 37 then
    raise exception using errcode = '23514', message = 'ACCOUNTING_DATE_REPAIR_AUDIT_COUNT_MISMATCH';
  end if;

  update public.accounting_entry_date_repair_batches
  set status = 'applied', strict_guard_hash_before = captured_guard_hash_before,
      strict_guard_hash_after = captured_guard_hash_after,
      executed_by = migration_role, executed_at = clock_timestamp()
  where manifest_hash = target_hash;

  begin
    update public.journal_entries
    set description = description || ' [ACCOUNTING-GUARD-RESTORE-CHECK]'
    where id = (
      select journal_entry_id from public.accounting_entry_date_repair_manifest
      where manifest_hash = target_hash order by journal_entry_id limit 1
    );
  exception when others then
    if sqlerrm like 'Las partidas publicadas no se editan.%' then
      guard_rejected := true;
    else
      raise;
    end if;
  end;
  if not guard_rejected then
    raise exception using errcode = '55000', message = 'ACCOUNTING_DATE_REPAIR_STRICT_GUARD_NOT_ACTIVE';
  end if;
end;
$repair$;

commit;
