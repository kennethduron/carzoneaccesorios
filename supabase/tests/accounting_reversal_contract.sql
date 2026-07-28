\set ON_ERROR_STOP on

begin;

insert into auth.users (
  id, instance_id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '10000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'reversal-contract@example.test', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
);

update public.users
set
  role_id = (select id from public.roles where name = 'technical_owner'),
  full_name = 'Reversal contract test',
  email = 'reversal-contract@example.test',
  active = true
where id = '10000000-0000-0000-0000-000000000001';

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

insert into public.accounting_accounts (id, code, name, type, normal_balance, created_by)
values
  ('20000000-0000-0000-0000-000000000001', 'TEST-1101001', 'CAJA TEST', 'asset', 'debit', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000002', 'TEST-2109001', 'ANTICIPOS TEST', 'liability', 'credit', '10000000-0000-0000-0000-000000000001');

insert into public.products (
  id, category_id, sku, internal_code, slug, name, brand, description,
  stock, retail_price, wholesale_price, cost_price, status, active
) values (
  '50000000-0000-0000-0000-000000000001',
  (select id from public.categories where slug = 'exterior'),
  'CZ-TEST-1045', 'OEM-TEST-1045', 'producto-prueba-busqueda',
  'ACEITE DE MOTOR PRUEBA', 'MARCA PRUEBA', 'Producto local para contrato de búsqueda',
  7, 500, 450, 321, 'active', true
);

insert into public.products (
  category_id, sku, internal_code, slug, name, brand, description,
  stock, retail_price, wholesale_price, cost_price, status, active
)
select
  (select id from public.categories where slug = 'exterior'),
  'LOAD-' || lpad(series::text, 4, '0'),
  'LOAD-OEM-' || lpad(series::text, 4, '0'),
  'producto-prueba-escala-' || series,
  'ACEITE PRUEBA ESCALA ' || series,
  'MARCA ESCALA',
  'Fixture local para validar búsqueda paginada',
  3, 200, 180, 100, 'active', true
from generate_series(1, 3000) as series;

insert into public.journal_entries (
  id, entry_number, entry_date, description, status, source_type, source_id,
  created_by, posted_by, posted_at, metadata
) values (
  '30000000-0000-0000-0000-000000000001',
  'TEST-REV-ORIGINAL', (now() at time zone 'America/Tegucigalpa')::date, 'Partida original de contrato', 'borrador',
  'manual', 'reversal-contract',
  '10000000-0000-0000-0000-000000000001',
  null, null, '{}'::jsonb
);

insert into public.journal_entry_lines (journal_entry_id, account_id, debit, credit, description)
values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 12800, 0, 'Caja original'),
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 0, 12800, 'Anticipo original');

update public.journal_entries
set
  status = 'publicada',
  posted_by = '10000000-0000-0000-0000-000000000001',
  posted_at = now()
where id = '30000000-0000-0000-0000-000000000001';

select public.reverse_journal_entry(
  '30000000-0000-0000-0000-000000000001',
  'Corrección contable validada por prueba automatizada',
  '127.0.0.1',
  'supabase-local-contract-test'
);

do $$
declare
  original public.journal_entries%rowtype;
  reversal public.journal_entries%rowtype;
  inverse_count integer;
  aggregate_debit numeric;
  aggregate_credit numeric;
  account_matches integer;
  purchase_cost numeric;
  inventory_matches integer;
  paged_count integer;
  paged_total bigint;
begin
  select * into strict original
  from public.journal_entries
  where id = '30000000-0000-0000-0000-000000000001';

  if original.status <> 'reversada' or original.reversed_entry_id is null then
    raise exception 'La original no quedó reversada y vinculada.';
  end if;

  select * into strict reversal
  from public.journal_entries
  where id = original.reversed_entry_id;

  if reversal.status <> 'publicada'
     or reversal.source_type <> 'journal_reversal'
     or reversal.source_id <> original.id::text
     or reversal.metadata->>'reversal_reason' is null then
    raise exception 'La reversa publicada no conserva su contrato de trazabilidad.';
  end if;

  raise notice 'dates Honduras=%, original=%, reversal=%', (now() at time zone 'America/Tegucigalpa')::date, original.entry_date, reversal.entry_date;

  select count(*) into inverse_count
  from public.journal_entry_lines original_line
  join public.journal_entry_lines reversal_line
    on reversal_line.journal_entry_id = reversal.id
   and reversal_line.account_id = original_line.account_id
   and reversal_line.debit = original_line.credit
   and reversal_line.credit = original_line.debit
  where original_line.journal_entry_id = original.id;

  if inverse_count <> 2 then
    raise exception 'Las líneas de la reversa no son el inverso exacto.';
  end if;

  select sum(debit_total), sum(credit_total)
  into aggregate_debit, aggregate_credit
  from public.get_accounting_report_aggregates(
    (now() at time zone 'America/Tegucigalpa')::date,
    (now() at time zone 'America/Tegucigalpa')::date,
    array['20000000-0000-0000-0000-000000000002'::uuid],
    'period'
  );

  raise notice 'aggregate debit=%, credit=%', aggregate_debit, aggregate_credit;

  if aggregate_debit <> 12800 or aggregate_credit <> 12800 then
    raise exception 'El agregado no incluyó original reversada y reversa publicada.';
  end if;

  select count(*) into account_matches
  from public.search_accounting_accounts_v1('anticipos', 25, 0, false)
  where code = 'TEST-2109001';
  if account_matches <> 1 then
    raise exception 'La búsqueda de cuentas por nombre parcial no encontró la cuenta.';
  end if;

  select cost_price into purchase_cost
  from public.search_purchase_products_v1('CZ-TEST', 25, 0, false)
  where sku = 'CZ-TEST-1045';
  if purchase_cost <> 321 then
    raise exception 'La búsqueda autorizada de compras no devolvió el costo esperado.';
  end if;

  select count(*) into inventory_matches
  from public.search_inventory_products_v1('aceite', 25, 0, false)
  where sku = 'CZ-TEST-1045' and available_stock = 7;
  if inventory_matches <> 1 then
    raise exception 'La búsqueda autorizada de inventario no devolvió el producto esperado.';
  end if;

  select count(*), max(total_count)
  into paged_count, paged_total
  from public.search_purchase_products_v1('aceite', 25, 25, false);
  if paged_count <> 25 or paged_total <> 3001 then
    raise exception 'La búsqueda paginada no escaló al fixture de 3,001 productos.';
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'public_catalog_products_v1'
      and column_name = 'cost_price'
  ) then
    raise exception 'El contrato público expone cost_price.';
  end if;

  if has_column_privilege('anon', 'public.products', 'cost_price', 'select')
     or has_column_privilege('authenticated', 'public.products', 'cost_price', 'select')
     or not has_column_privilege('service_role', 'public.products', 'cost_price', 'select') then
    raise exception 'Los privilegios de cost_price no cumplen el contrato público/interno.';
  end if;

  begin
    perform public.reverse_journal_entry(
      reversal.id,
      'Este intento de reversar una reversa debe rechazarse',
      '127.0.0.1',
      'supabase-local-contract-test'
    );
    raise exception 'La reversa de reversa fue aceptada.';
  exception
    when sqlstate '22023' then null;
  end;
end;
$$;

rollback;

\echo 'Accounting reversal transactional contract: OK'
