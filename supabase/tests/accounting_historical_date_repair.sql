\set ON_ERROR_STOP on

begin;

select plan(18);

select ok(
  to_regclass('public.accounting_entry_date_repair_batches') is not null
  and to_regclass('public.accounting_entry_date_repair_manifest') is not null
  and to_regclass('public.accounting_entry_date_repairs') is not null,
  'historical repair contract tables exist'
);

select is(
  (select count(*)::integer from public.accounting_entry_date_repair_manifest),
  37,
  'manifest is limited to the approved 37 journal entries'
);

select is(
  (select count(distinct journal_entry_id)::integer from public.accounting_entry_date_repair_manifest),
  37,
  'every manifest journal entry is unique'
);

select is(
  (select row(sum(debit_total), sum(credit_total))::text
     from public.accounting_entry_date_repair_manifest),
  row(134905.59::numeric, 134905.59::numeric)::text,
  'manifest preserves the approved balanced totals'
);

select is(
  (select jsonb_object_agg(repair_group, row_count order by repair_group)
     from (
       select repair_group, count(*)::integer as row_count
       from public.accounting_entry_date_repair_manifest
       group by repair_group
     ) grouped),
  '{"A":22,"B":15}'::jsonb,
  'cross-month and within-month groups reproduce exactly'
);

select is(
  (select jsonb_object_agg(source_type, row_count order by source_type)
     from (
       select source_type, count(*)::integer as row_count
       from public.accounting_entry_date_repair_manifest
       group by source_type
     ) grouped),
  '{"inventory_movement":26,"order":6,"supplier_payment":5}'::jsonb,
  'sales, COGS, and supplier-payment composition reproduces exactly'
);

select is(
  (select count(*)::integer
     from public.accounting_entry_date_repair_manifest
     where accounting_outbox_id is not null),
  32,
  'only the 32 unequivocally related outboxes are eligible'
);

select is(
  (select jsonb_object_agg(accounting_date_source, row_count order by accounting_date_source)
     from (
       select accounting_date_source, count(*)::integer as row_count
       from public.accounting_entry_date_repair_manifest
       group by accounting_date_source
     ) grouped),
  '{"invoices.invoice_date":21,"orders.requested_invoice_date":11,"supplier_payments.paid_at":5}'::jsonb,
  'every repaired date records its canonical authority'
);

select ok(
  not exists (
    select 1
    from public.accounting_entry_date_repair_manifest
    where document_number = '0090915'
       or source_type in ('pending_data', 'reversal')
  ),
  'CROMOS, pending-data cases, and reversals are excluded'
);

select ok(
  not exists (
    select 1
    from public.accounting_entry_date_repair_manifest
    where new_accounting_date is null
       or new_accounting_date > old_entry_date
       or line_count < 1
       or debit_total <> credit_total
  ),
  'all proposed dates are non-null, retroactive, balanced, and line-backed'
);

select is(
  (select row(expected_count, expected_debit, expected_credit, status)::text
   from public.accounting_entry_date_repair_batches
   where manifest_hash = '45456813ee199442eacc31dd7ea94e8692c2b781b62bbd5b10bc20359e8cd857'),
  row(37, 134905.59::numeric, 134905.59::numeric, 'approved')::text,
  'batch contract is approved with the exact hash, count, and totals on a clean reset'
);

select is(
  (select count(*)::integer from public.accounting_entry_date_repairs),
  0,
  'a clean local reset contains no fabricated production repair audit rows'
);

select ok(
  (select bool_and(relrowsecurity)
   from pg_class
   where oid in (
     'public.accounting_entry_date_repair_batches'::regclass,
     'public.accounting_entry_date_repair_manifest'::regclass,
     'public.accounting_entry_date_repairs'::regclass
   )),
  'RLS is enabled on all repair contract tables'
);

select ok(
  not has_table_privilege('authenticated', 'public.accounting_entry_date_repairs', 'INSERT')
  and not has_table_privilege('authenticated', 'public.accounting_entry_date_repairs', 'UPDATE')
  and not has_table_privilege('authenticated', 'public.accounting_entry_date_repairs', 'DELETE')
  and not has_table_privilege('service_role', 'public.accounting_entry_date_repairs', 'INSERT')
  and not has_table_privilege('service_role', 'public.accounting_entry_date_repairs', 'UPDATE')
  and not has_table_privilege('service_role', 'public.accounting_entry_date_repairs', 'DELETE'),
  'application and service roles cannot mutate repair audits'
);

select trigger_is(
  'public', 'accounting_entry_date_repairs',
  'accounting_entry_date_repairs_append_only',
  'public', 'guard_accounting_entry_date_repairs_append_only_v1',
  'repair audit table has an append-only guard'
);

select ok(
  position('app.accounting_date_repair_manifest_hash' in
    pg_get_functiondef('public.guard_journal_entry_status()'::regprocedure)) = 0
  and position('Las partidas publicadas no se editan' in
    pg_get_functiondef('public.guard_journal_entry_status()'::regprocedure)) > 0,
  'the permanent published-entry guard is strict and contains no reusable bypass context'
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.accounting_entry_date_repair_line_hash_v1(uuid)',
    'EXECUTE'
  )
  and not has_function_privilege(
    'service_role',
    'public.accounting_entry_date_repair_line_hash_v1(uuid)',
    'EXECUTE'
  ),
  'line hashing helper is not executable from application roles'
);

select is(
  (select count(*)::integer
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname ~ 'accounting.*date.*repair'
     and p.prokind = 'f'
     and p.pronargs > 1),
  0,
  'no permanent manifest-application RPC is exposed'
);

select * from finish();
rollback;
