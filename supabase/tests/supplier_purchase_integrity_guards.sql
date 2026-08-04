\set ON_ERROR_STOP on

begin;
select no_plan();
\ir fixtures/supplier_payment_opening_balance_repair_fixture.sql.inc

insert into public.suppliers (id, name, is_active, created_by)
values (
  'ae12f73b-a9bf-49cb-b5b8-f015d0b305bb',
  'FRANKLIN NAPOLEON OLIVA CABALLERO',
  true,
  '91000000-0000-4000-8000-000000000001'
);

insert into public.accounting_accounts (
  id, code, name, type, normal_balance, is_active, created_by
) values (
  'f1000000-0000-4000-8000-000000000020',
  '1101005',
  'BAC CHEQUES LPS LOCAL',
  'asset',
  'debit',
  true,
  '91000000-0000-4000-8000-000000000001'
);

insert into public.accounting_mappings (
  mapping_type, source_key, account_id, priority, is_active,
  effective_from, created_by
) values (
  'payment_method',
  'supplier_payment_bank',
  'f1000000-0000-4000-8000-000000000020',
  1,
  true,
  '2026-01-01',
  '91000000-0000-4000-8000-000000000001'
);

insert into public.purchases (
  id, supplier_id, purchase_number, purchase_date, status,
  subtotal, tax_amount, discount_amount, shipping_amount, total,
  currency, notes, created_by
) values
  (
    'f1000000-0000-4000-8000-000000000001',
    '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
    'CROMOS-INTEGRITY-LOCAL-ONLY',
    '2026-07-28',
    'confirmed',
    2800, 0, 0, 0, 2800,
    'HNL',
    'CROMOS-INTEGRITY-LOCAL-ONLY',
    '91000000-0000-4000-8000-000000000001'
  ),
  (
    'f1000000-0000-4000-8000-000000000002',
    'ae12f73b-a9bf-49cb-b5b8-f015d0b305bb',
    'FRANKLIN-INTEGRITY-LOCAL-ONLY',
    '2026-07-29',
    'confirmed',
    2800, 0, 0, 0, 2800,
    'HNL',
    'CROMOS-INTEGRITY-LOCAL-ONLY',
    '91000000-0000-4000-8000-000000000001'
  );

select has_function(
  'public',
  'validate_supplier_purchase_integrity_v1',
  array['uuid', 'uuid', 'uuid'],
  'canonical supplier-purchase validator exists'
);

select lives_ok(
  $$select public.validate_supplier_purchase_integrity_v1(
    '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
    'f1000000-0000-4000-8000-000000000001',
    null
  )$$,
  'same-supplier purchase is accepted'
);

select throws_ok(
  $$select public.validate_supplier_purchase_integrity_v1(
    '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
    'f1000000-0000-4000-8000-000000000002',
    null
  )$$,
  '23514',
  'SUPPLIER_PURCHASE_MISMATCH: La compra seleccionada pertenece a otro proveedor. Seleccione una compra del mismo proveedor antes de continuar.',
  'cross-supplier purchase is rejected'
);

select lives_ok(
  $$insert into public.supplier_invoices (
    id, supplier_id, purchase_id, invoice_number, invoice_date,
    due_date, status, subtotal, total, currency, notes, created_by
  ) values (
    'f1000000-0000-4000-8000-000000000003',
    '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
    'f1000000-0000-4000-8000-000000000001',
    'CROMOS-INTEGRITY-LOCAL-ONLY',
    '2026-07-28',
    '2026-07-28',
    'posted_to_ap',
    2800,
    2800,
    'HNL',
    'CROMOS-INTEGRITY-LOCAL-ONLY',
    '91000000-0000-4000-8000-000000000001'
  )$$,
  'same-supplier invoice and purchase are accepted'
);

select throws_ok(
  $$insert into public.supplier_invoices (
    id, supplier_id, purchase_id, invoice_number, invoice_date,
    status, subtotal, total, currency, created_by
  ) values (
    'f1000000-0000-4000-8000-000000000004',
    '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
    'f1000000-0000-4000-8000-000000000002',
    'CROMOS-CROSS-LOCAL-ONLY',
    '2026-07-28',
    'draft',
    2800,
    2800,
    'HNL',
    '91000000-0000-4000-8000-000000000001'
  )$$,
  '23514',
  'SUPPLIER_PURCHASE_MISMATCH: La compra seleccionada pertenece a otro proveedor. Seleccione una compra del mismo proveedor antes de continuar.',
  'supplier invoice cannot reference another supplier purchase'
);

select lives_ok(
  $$insert into public.supplier_invoices (
    id, supplier_id, purchase_id, invoice_number, invoice_date,
    due_date, status, subtotal, total, currency, notes, created_by
  ) values (
    'f1000000-0000-4000-8000-000000000005',
    '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
    null,
    'CROMOS-NO-PURCHASE-LOCAL-ONLY',
    '2026-07-28',
    '2026-07-28',
    'posted_to_ap',
    2800,
    2800,
    'HNL',
    'CROMOS-INTEGRITY-LOCAL-ONLY',
    '91000000-0000-4000-8000-000000000001'
  )$$,
  'supplier invoice without purchase remains valid'
);

select lives_ok(
  $$insert into public.accounts_payable (
    id, supplier_id, purchase_id, supplier_invoice_id,
    total_amount, paid_amount, due_date, status, currency, notes, created_by
  ) values (
    'f1000000-0000-4000-8000-000000000006',
    '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
    null,
    'f1000000-0000-4000-8000-000000000005',
    2800,
    0,
    '2026-07-28',
    'pending',
    'HNL',
    'CROMOS-INTEGRITY-LOCAL-ONLY',
    '91000000-0000-4000-8000-000000000001'
  )$$,
  'accounts payable without purchase remains valid'
);

select throws_ok(
  $$insert into public.accounts_payable (
    id, supplier_id, purchase_id, supplier_invoice_id,
    total_amount, paid_amount, status, currency, created_by
  ) values (
    'f1000000-0000-4000-8000-000000000007',
    '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
    'f1000000-0000-4000-8000-000000000002',
    null,
    2800,
    0,
    'pending',
    'HNL',
    '91000000-0000-4000-8000-000000000001'
  )$$,
  '23514',
  'SUPPLIER_PURCHASE_MISMATCH: La compra seleccionada pertenece a otro proveedor. Seleccione una compra del mismo proveedor antes de continuar.',
  'accounts payable cannot reference another supplier purchase'
);

select throws_ok(
  $$update public.purchases
    set supplier_id = 'ae12f73b-a9bf-49cb-b5b8-f015d0b305bb'
    where id = 'f1000000-0000-4000-8000-000000000001'$$,
  '23514',
  'SUPPLIER_PURCHASE_MISMATCH: La compra tiene facturas u obligaciones de otro proveedor.',
  'supplier change cannot invalidate linked invoices'
);

alter table public.supplier_invoices
  disable trigger supplier_invoices_purchase_integrity_v1;
alter table public.accounts_payable
  disable trigger accounts_payable_purchase_integrity_v1;

insert into public.supplier_invoices (
  id, supplier_id, purchase_id, invoice_number, invoice_date,
  due_date, status, subtotal, total, currency, notes, created_by
) values (
  'f1000000-0000-4000-8000-000000000008',
  '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
  'f1000000-0000-4000-8000-000000000002',
  'CROMOS-CORRUPTED-LOCAL-ONLY',
  '2026-07-28',
  '2026-07-28',
  'posted_to_ap',
  2800,
  2800,
  'HNL',
  'CROMOS-INTEGRITY-LOCAL-ONLY',
  '91000000-0000-4000-8000-000000000001'
);

insert into public.accounts_payable (
  id, supplier_id, purchase_id, supplier_invoice_id,
  total_amount, paid_amount, due_date, status, currency, notes, created_by
) values (
  'f1000000-0000-4000-8000-000000000009',
  '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
  'f1000000-0000-4000-8000-000000000002',
  'f1000000-0000-4000-8000-000000000008',
  2800,
  0,
  '2026-07-28',
  'pending',
  'HNL',
  'CROMOS-INTEGRITY-LOCAL-ONLY',
  '91000000-0000-4000-8000-000000000001'
);

alter table public.supplier_invoices
  enable trigger supplier_invoices_purchase_integrity_v1;
alter table public.accounts_payable
  enable trigger accounts_payable_purchase_integrity_v1;

select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

update public.accounting_feature_flags
set state = 'enabled',
    cutover_at = '2026-07-01 00:00:00-06',
    updated_by = '91000000-0000-4000-8000-000000000001'
where key in (
  'supplier_payment_draft_v2',
  'supplier_multi_invoice_payment_v1'
);

insert into public.journal_entries (
  id, entry_number, entry_date, description, status,
  source_type, source_id, created_by, updated_by, posted_by, posted_at
) values (
  'f1000000-0000-4000-8000-000000000021',
  'CROMOS-INTEGRITY-LOCAL-ONLY',
  '2026-07-28',
  'CROMOS-INTEGRITY-LOCAL-ONLY recognition',
  'publicada',
  'financial_event',
  'f1000000-0000-4000-8000-000000000022',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  now()
);

insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version, status,
  occurred_at, source_snapshot, validation_errors, journal_entry_id, created_by
) values (
  'f1000000-0000-4000-8000-000000000022',
  'accounts_payable',
  'f1000000-0000-4000-8000-000000000006',
  'accounts_payable_created',
  'v1',
  'posted',
  '2026-07-28 12:00:00-06',
  '{}'::jsonb,
  '[]'::jsonb,
  'f1000000-0000-4000-8000-000000000021',
  '91000000-0000-4000-8000-000000000001'
);

create temporary table cromos_integrity_results (
  name text primary key,
  result jsonb not null
) on commit drop;

insert into cromos_integrity_results values (
  'payment',
  public.register_supplier_multi_payment_v1(
    'f1000000-0000-4000-8000-000000000023',
    '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
    'bank_transfer',
    '2026-07-28',
    'CROMOS-INTEGRITY-LOCAL-ONLY',
    '[{"accounts_payable_id":"f1000000-0000-4000-8000-000000000006","applied_amount":2800}]',
    'CROMOS-INTEGRITY-LOCAL-ONLY',
    null
  )
);

select lives_ok(
  $$do $replays$
  declare
    attempt integer;
  begin
    for attempt in 1..4 loop
      perform public.register_supplier_multi_payment_v1(
        'f1000000-0000-4000-8000-000000000023',
        '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
        'bank_transfer',
        '2026-07-28',
        'CROMOS-INTEGRITY-LOCAL-ONLY',
        '[{"accounts_payable_id":"f1000000-0000-4000-8000-000000000006","applied_amount":2800}]',
        'CROMOS-INTEGRITY-LOCAL-ONLY',
        null
      );
    end loop;
  end;
  $replays$;$$,
  'five confirmations replay one payment without duplication'
);

select ok(
  (
    select
      result ->> 'status' = 'paid'
      and (result ->> 'payment_total')::numeric = 2800
      and (result ->> 'application_count')::integer = 1
      and result ->> 'accounting_date' = '2026-07-28'
    from cromos_integrity_results
    where name = 'payment'
  ),
  'Camino B pays one no-purchase obligation on the reviewed civil date'
);

select is(
  (
    select row(paid_amount, balance, status)::text
    from public.accounts_payable
    where id = 'f1000000-0000-4000-8000-000000000006'
  ),
  row(2800.00::numeric, 0.00::numeric, 'paid'::text)::text,
  'local repaired payable moves from L 2,800 to zero exactly once'
);

select is(
  (
    select count(*)::integer
    from public.supplier_payments
    where idempotency_key =
      'supplier_multi_payment:v1:f1000000-0000-4000-8000-000000000023'
  ),
  1,
  'five confirmations create one payment'
);

select is(
  (
    select count(*)::integer
    from public.supplier_payment_applications application
    join public.supplier_payments payment
      on payment.id = application.supplier_payment_id
    where payment.idempotency_key =
      'supplier_multi_payment:v1:f1000000-0000-4000-8000-000000000023'
  ),
  1,
  'five confirmations create one application'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"service_role"}',
  true
);

insert into cromos_integrity_results values (
  'worker',
  public.process_accounting_outbox_v2(
    (
      select (result ->> 'outbox_id')::uuid
      from cromos_integrity_results
      where name = 'payment'
    ),
    'CROMOS-INTEGRITY-LOCAL-ONLY',
    false
  )
);

select ok(
  (
    select
      entry.status = 'borrador'
      and entry.entry_date = date '2026-07-28'
      and sum(line.debit) = 2800
      and sum(line.credit) = 2800
      and count(*) = 2
    from public.accounting_outbox_v2 box
    join public.journal_entries entry
      on entry.id = box.journal_entry_id
    join public.journal_entry_lines line
      on line.journal_entry_id = entry.id
    where box.id = (
      select (result ->> 'outbox_id')::uuid
      from cromos_integrity_results
      where name = 'payment'
    )
    group by entry.status, entry.entry_date
  ),
  'worker creates one balanced manual draft dated July 28'
);

select is(
  (
    select jsonb_object_agg(account.code, totals.amount order by account.code)
    from (
      select line.account_id, sum(line.debit + line.credit) as amount
      from public.accounting_outbox_v2 box
      join public.journal_entry_lines line
        on line.journal_entry_id = box.journal_entry_id
      where box.id = (
        select (result ->> 'outbox_id')::uuid
        from cromos_integrity_results
        where name = 'payment'
      )
      group by line.account_id
    ) totals
    join public.accounting_accounts account on account.id = totals.account_id
  ),
  '{"1101005":2800,"2101001":2800}'::jsonb,
  'payment draft debits 2101001 and credits 1101005'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select throws_ok(
  $$select * from public.register_supplier_payment_v2(
    'f1000000-0000-4000-8000-000000000009',
    2800,
    'card_credit',
    '2026-07-28',
    'CROMOS-INTEGRITY-LOCAL-ONLY',
    'f1000000-0000-4000-8000-000000000010'
  )$$,
  '23514',
  'SUPPLIER_PURCHASE_MISMATCH: La compra seleccionada pertenece a otro proveedor. Seleccione una compra del mismo proveedor antes de continuar.',
  'individual payment RPC is protected by the canonical payment guard'
);

select throws_ok(
  $$select public.register_supplier_multi_payment_v1(
    'f1000000-0000-4000-8000-000000000011',
    '335b38ff-d06d-4bf1-88f0-ea51f034ee5f',
    'card_credit',
    '2026-07-28',
    null,
    '[{"accounts_payable_id":"f1000000-0000-4000-8000-000000000009","applied_amount":2800}]',
    'CROMOS-INTEGRITY-LOCAL-ONLY',
    null
  )$$,
  '23514',
  'La compra no corresponde al proveedor de la obligación.',
  'multi-invoice payment RPC rejects the same corrupted relationship'
);

select is(
  (
    select count(*)::integer
    from public.supplier_payments
    where idempotency_key in (
      'f1000000-0000-4000-8000-000000000010',
      'supplier_multi_payment:v1:f1000000-0000-4000-8000-000000000011'
    )
  ),
  0,
  'rejected payment paths leave zero payments'
);

select is(
  (
    select balance
    from public.accounts_payable
    where id = 'f1000000-0000-4000-8000-000000000009'
  ),
  2800.00::numeric,
  'rejected payment paths leave the balance unchanged'
);

select is(
  (
    select count(*)::integer
    from public.supplier_payment_applications
    where accounts_payable_id = 'f1000000-0000-4000-8000-000000000009'
  ),
  0,
  'rejected payment paths leave zero applications'
);

select * from finish();
rollback;
