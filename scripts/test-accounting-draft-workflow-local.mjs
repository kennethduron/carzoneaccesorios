import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const container = `car-zone-journal-workflow-${process.pid}`;
assert.match(container, /^car-zone-journal-workflow-\d+$/);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function psql(sql) {
  return run("docker", ["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { input: sql });
}

const prelude = String.raw`
create extension if not exists pgcrypto;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create table public.roles (
  id uuid primary key default gen_random_uuid(), name text unique not null,
  permissions jsonb not null default '[]'::jsonb, updated_at timestamptz not null default now()
);
create table public.users (
  id uuid primary key, role_id uuid references public.roles(id), email text, active boolean not null default true
);
create or replace function public.has_permission(permission_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.users u join public.roles r on r.id = u.role_id
    where u.id = auth.uid() and u.active and r.permissions ? permission_name
  )
$$;

create table public.customers (id uuid primary key);
create table public.products (id uuid primary key);
create table public.suppliers (id uuid primary key, name text not null);
create table public.accounting_accounts (
  id uuid primary key default gen_random_uuid(), code text unique not null, name text not null,
  type text not null, is_active boolean not null default true
);
create table public.journal_entries (
  id uuid primary key default gen_random_uuid(), entry_number text unique not null,
  entry_date date not null, description text not null,
  status text not null default 'borrador' check (status in ('borrador','publicada','reversada','anulada')),
  source_type text, source_id text, created_by uuid not null references public.users(id),
  posted_by uuid references public.users(id), posted_at timestamptz,
  reversed_entry_id uuid references public.journal_entries(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((source_type is null and source_id is null) or (source_type is not null and source_id is not null)),
  check (status <> 'publicada' or (posted_by is not null and posted_at is not null))
);
create table public.journal_entry_lines (
  id uuid primary key default gen_random_uuid(), journal_entry_id uuid not null references public.journal_entries(id) on delete cascade,
  account_id uuid not null references public.accounting_accounts(id), debit numeric(14,2) not null default 0,
  credit numeric(14,2) not null default 0, description text,
  customer_id uuid references public.customers(id), vendor_id uuid, product_id uuid references public.products(id),
  created_at timestamptz not null default now(),
  check (debit >= 0 and credit >= 0), check ((debit > 0 and credit = 0) or (credit > 0 and debit = 0))
);
create table public.accounting_event_log (
  id uuid primary key default gen_random_uuid(), event_type text not null, entity_type text not null,
  entity_id uuid, source_type text, source_id text, metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.users(id), created_at timestamptz not null default now()
);
create table public.audit_logs (
  id uuid primary key default gen_random_uuid(), table_name text, record_id uuid, action text,
  old_data jsonb, new_data jsonb, user_id uuid, ip_address text, user_agent text, created_at timestamptz default now()
);
create or replace function public.write_audit_log(
  table_name_value text, record_id_value uuid, action_value text, old_data_value jsonb,
  new_data_value jsonb, ip_address_value text default null, user_agent_value text default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare result uuid;
begin
  insert into public.audit_logs(table_name, record_id, action, old_data, new_data, user_id, ip_address, user_agent)
  values (table_name_value, record_id_value, action_value, old_data_value, new_data_value, auth.uid(), ip_address_value, user_agent_value)
  returning id into result;
  return result;
end $$;

create table public.accounting_periods (id uuid primary key default gen_random_uuid(), starts_on date, ends_on date, status text);
create or replace function public.is_date_in_closed_accounting_period(value date) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.accounting_periods where value between starts_on and ends_on and status = 'closed')
$$;

create table public.accounting_mappings (
  id uuid primary key default gen_random_uuid(), mapping_type text not null, source_key text not null,
  account_id uuid not null references public.accounting_accounts(id), priority integer not null default 100,
  is_active boolean not null default true, effective_from date, effective_to date
);
create table public.financial_events (
  id uuid primary key default gen_random_uuid(), source_type text not null, source_id text not null,
  event_purpose text not null, status text not null, source_snapshot jsonb not null default '{}'::jsonb,
  validation_errors jsonb not null default '[]'::jsonb, journal_entry_id uuid references public.journal_entries(id),
  created_by uuid references public.users(id), created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.purchases (
  id uuid primary key, supplier_id uuid not null references public.suppliers(id), purchase_number text not null,
  purchase_date date not null, status text not null, subtotal numeric(12,2), tax_amount numeric(12,2),
  discount_amount numeric(12,2), shipping_amount numeric(12,2), total numeric(12,2), currency text
);
create table public.purchase_items (
  id uuid primary key default gen_random_uuid(), purchase_id uuid references public.purchases(id),
  quantity numeric(12,2), unit_cost numeric(12,2), tax_amount numeric(12,2), discount_amount numeric(12,2)
);
create table public.supplier_invoices (
  id uuid primary key, supplier_id uuid not null references public.suppliers(id), purchase_id uuid references public.purchases(id),
  invoice_number text not null, invoice_date date not null, due_date date, status text not null,
  subtotal numeric(12,2), tax_amount numeric(12,2), discount_amount numeric(12,2), total numeric(12,2), currency text
);
create table public.accounts_payable (
  id uuid primary key, supplier_id uuid not null references public.suppliers(id), purchase_id uuid references public.purchases(id),
  supplier_invoice_id uuid references public.supplier_invoices(id), total_amount numeric(12,2), paid_amount numeric(12,2),
  balance numeric(12,2), due_date date, status text, currency text, created_at timestamptz default now()
);

alter table public.journal_entries enable row level security;
alter table public.journal_entry_lines enable row level security;
create policy "Accounting read journal entries" on public.journal_entries for select to authenticated using (true);
create policy "Accounting read journal lines" on public.journal_entry_lines for select to authenticated using (true);
create policy "Accounting create journal entries" on public.journal_entries for insert to authenticated with check (true);
create policy "Accounting update journal entries" on public.journal_entries for update to authenticated using (true);
create policy "Accounting delete draft journal entries" on public.journal_entries for delete to authenticated using (status = 'borrador');
create policy "Accounting create journal lines" on public.journal_entry_lines for insert to authenticated with check (true);
create policy "Accounting update journal lines" on public.journal_entry_lines for update to authenticated using (true);
create policy "Accounting delete journal lines" on public.journal_entry_lines for delete to authenticated using (true);
grant usage on schema public, auth to authenticated;
grant select, insert, update, delete on public.journal_entries, public.journal_entry_lines to authenticated;
grant select on public.financial_events to authenticated;
`;

const fixture = String.raw`
insert into public.roles(id, name, permissions) values
  ('10000000-0000-4000-8000-000000000001', 'contadora', '["accounting:create","accounting:edit_draft_entries","accounting:post","accounting:reverse","accounting:manage"]'),
  ('10000000-0000-4000-8000-000000000002', 'sin_permisos', '[]');
insert into public.users(id, role_id, email) values
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'contadora@example.com'),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'denied@example.com');
insert into public.accounting_accounts(id, code, name, type) values
  ('30000000-0000-4000-8000-000000000001', '1103001', 'INVENTARIO GENERAL', 'asset'),
  ('30000000-0000-4000-8000-000000000002', '1112001', 'ISV CREDITO FISCAL 15%', 'asset'),
  ('30000000-0000-4000-8000-000000000003', '2101001', 'PROVEEDORES LOCALES', 'liability');
insert into public.accounting_mappings(mapping_type, source_key, account_id, priority) values
  ('inventory', 'purchase_inventory', '30000000-0000-4000-8000-000000000001', 10),
  ('tax', 'purchase_tax', '30000000-0000-4000-8000-000000000002', 10),
  ('default_account', 'accounts_payable', '30000000-0000-4000-8000-000000000003', 10);
insert into public.suppliers values ('40000000-0000-4000-8000-000000000001', 'Proveedor prueba');
insert into public.purchases values (
  '50000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'COMP-1', '2026-07-21',
  'received', 8000, 1200, 0, 0, 9200, 'HNL'
);
insert into public.supplier_invoices values (
  '60000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001', 'FAC-1', '2026-07-21', '2026-08-20', 'received', 8000, 1200, 0, 9200, 'HNL'
);
insert into public.accounts_payable values (
  '70000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001',
  9200, 0, 9200, '2026-08-20', 'pending', 'HNL', now()
);
insert into public.financial_events(id, source_type, source_id, event_purpose, status, created_by) values (
  '80000000-0000-4000-8000-000000000001', 'accounts_payable', '70000000-0000-4000-8000-000000000001',
  'accounts_payable_created', 'pending', '20000000-0000-4000-8000-000000000001'
);
`;

const tests = String.raw`
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000001', false);
set role authenticated;

select public.create_manual_journal_draft(
  '2026-07-21', 'Partida manual de prueba',
  '[{"account_id":"30000000-0000-4000-8000-000000000001","debit":100,"credit":0},{"account_id":"30000000-0000-4000-8000-000000000003","debit":0,"credit":100}]',
  '127.0.0.1', 'integration-test'
);

do $$
declare entry_id uuid; old_version integer; old_count integer;
begin
  select id, version into entry_id, old_version from public.journal_entries where source_type is null;
  select count(*) into old_count from public.journal_entry_lines where journal_entry_id = entry_id;
  begin
    perform public.update_journal_draft(entry_id, old_version, '2026-07-21', 'Desbalanceada',
      '[{"account_id":"30000000-0000-4000-8000-000000000001","debit":120,"credit":0},{"account_id":"30000000-0000-4000-8000-000000000003","debit":0,"credit":100}]',
      'Prueba de desbalance', null, null);
    raise exception 'Expected balance rejection';
  exception when others then
    if sqlerrm = 'Expected balance rejection' then raise; end if;
  end;
  if (select version from public.journal_entries where id = entry_id) <> old_version then raise exception 'Version changed after rejected update'; end if;
  if (select count(*) from public.journal_entry_lines where journal_entry_id = entry_id) <> old_count then raise exception 'Lines changed after rejected update'; end if;

  perform public.update_journal_draft(entry_id, old_version, '2026-07-22', 'Partida corregida',
    '[{"account_id":"30000000-0000-4000-8000-000000000001","debit":120,"credit":0},{"account_id":"30000000-0000-4000-8000-000000000002","debit":0,"credit":120}]',
    'Correccion valida de prueba', '127.0.0.1', 'integration-test');
  if (select version from public.journal_entries where id = entry_id) <> old_version + 1 then raise exception 'Version was not incremented'; end if;
  begin
    perform public.update_journal_draft(entry_id, old_version, '2026-07-22', 'Version obsoleta',
      '[{"account_id":"30000000-0000-4000-8000-000000000001","debit":120,"credit":0},{"account_id":"30000000-0000-4000-8000-000000000002","debit":0,"credit":120}]',
      'Conflicto esperado', null, null);
    raise exception 'Expected stale version rejection';
  exception when sqlstate '40001' then null;
  end;

  perform public.post_journal_entry(entry_id, old_version + 1, null, null);
  if (select status from public.journal_entries where id = entry_id) <> 'publicada' then raise exception 'Posting failed'; end if;
  begin
    perform public.update_journal_draft(entry_id, old_version + 2, '2026-07-22', 'No editable',
      '[{"account_id":"30000000-0000-4000-8000-000000000001","debit":120,"credit":0},{"account_id":"30000000-0000-4000-8000-000000000002","debit":0,"credit":120}]',
      'Debe fallar publicada', null, null);
    raise exception 'Expected published rejection';
  exception when others then
    if sqlerrm = 'Expected published rejection' then raise; end if;
  end;
  perform public.reverse_journal_entry(entry_id);
  if (select status from public.journal_entries where id = entry_id) <> 'reversada' then raise exception 'Reversal failed'; end if;
end $$;

select public.create_journal_draft_from_financial_event(
  '80000000-0000-4000-8000-000000000001', '2026-07-21', 'Cuenta por pagar sin desglose',
  '[{"account_id":"30000000-0000-4000-8000-000000000001","debit":9200,"credit":0},{"account_id":"30000000-0000-4000-8000-000000000003","debit":0,"credit":9200}]',
  null, null
);

do $$
declare entry_id uuid; result jsonb;
begin
  select id into entry_id from public.journal_entries where source_id = '80000000-0000-4000-8000-000000000001';
  result := public.recalculate_journal_draft_from_source(entry_id, 1, 'Sincronizar impuesto de compra', '127.0.0.1', 'integration-test');
  if (result->>'journal_entry_id')::uuid <> entry_id then raise exception 'Recalculation replaced the entry'; end if;
  if (select version from public.journal_entries where id = entry_id) <> 2 then raise exception 'Recalculation did not increment version'; end if;
  if (select count(*) from public.journal_entry_lines where journal_entry_id = entry_id) <> 3 then raise exception 'Expected three fiscal lines'; end if;
  if not exists (select 1 from public.journal_entry_lines where journal_entry_id = entry_id and account_id = '30000000-0000-4000-8000-000000000001' and debit = 8000) then raise exception 'Inventory subtotal missing'; end if;
  if not exists (select 1 from public.journal_entry_lines where journal_entry_id = entry_id and account_id = '30000000-0000-4000-8000-000000000002' and debit = 1200) then raise exception 'Tax line missing'; end if;
  if not exists (select 1 from public.journal_entry_lines where journal_entry_id = entry_id and account_id = '30000000-0000-4000-8000-000000000003' and credit = 9200) then raise exception 'Payable credit missing'; end if;
  if (select status from public.financial_events where id = '80000000-0000-4000-8000-000000000001') <> 'draft_created' then raise exception 'Event was not synchronized'; end if;
end $$;

reset role;
insert into public.accounting_periods(starts_on, ends_on, status) values ('2026-06-01', '2026-06-30', 'closed');
set role authenticated;
do $$ begin
  begin
    perform public.create_manual_journal_draft('2026-06-15', 'Periodo cerrado',
      '[{"account_id":"30000000-0000-4000-8000-000000000001","debit":10,"credit":0},{"account_id":"30000000-0000-4000-8000-000000000003","debit":0,"credit":10}]', null, null);
    raise exception 'Expected closed period rejection';
  exception when others then if sqlerrm = 'Expected closed period rejection' then raise; end if; end;
end $$;

reset role;
select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', false);
set role authenticated;
do $$ begin
  begin
    perform public.recalculate_journal_draft_from_source(
      (select id from public.journal_entries where source_id = '80000000-0000-4000-8000-000000000001'), 2,
      'Usuario sin permiso', null, null);
    raise exception 'Expected permission rejection';
  exception when others then if sqlerrm = 'Expected permission rejection' then raise; end if; end;
end $$;

reset role;
do $$ begin
  if (select count(*) from public.audit_logs where action like 'accounting%') < 7 then raise exception 'Insufficient audit history'; end if;
  if not exists (select 1 from public.accounting_event_log where event_type = 'accounting_line_added') then raise exception 'Line add event missing'; end if;
  if not exists (select 1 from public.accounting_event_log where event_type = 'accounting_entry_published') then raise exception 'Publish event missing'; end if;
end $$;

set role authenticated;
do $$ begin
  begin
    insert into public.journal_entries(entry_number, entry_date, description, created_by)
    values ('DIRECT-WRITE', current_date, 'Debe fallar', '20000000-0000-4000-8000-000000000001');
    raise exception 'Expected direct write rejection';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
select 'ACCOUNTING_DRAFT_WORKFLOW_OK' as result;
`;

try {
  run("docker", ["run", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=postgres", "postgres:17-alpine"]);
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const check = spawnSync("docker", ["exec", container, "pg_isready", "-U", "postgres"], { encoding: "utf8" });
    if (check.status === 0) { ready = true; break; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  assert.equal(ready, true, "PostgreSQL test container did not become ready");
  psql(prelude);
  psql(readFileSync(new URL("../supabase/migrations/202607210001_accounting_draft_workflow.sql", import.meta.url), "utf8"));
  psql(readFileSync(new URL("../supabase/migrations/202607210002_harden_accounting_journal_writes.sql", import.meta.url), "utf8"));
  psql(fixture);
  const output = psql(tests);
  assert.match(output, /ACCOUNTING_DRAFT_WORKFLOW_OK/);
  console.log("Accounting draft workflow PostgreSQL integration tests passed.");
} finally {
  spawnSync("docker", ["rm", "-f", container], { encoding: "utf8" });
}
