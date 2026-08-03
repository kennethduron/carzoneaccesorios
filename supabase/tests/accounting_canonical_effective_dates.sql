\set ON_ERROR_STOP on

begin;

select plan(8);

select has_column(
  'public', 'accounting_outbox_v2', 'accounting_date',
  'outbox stores the explicit accounting date'
);

select has_column(
  'public', 'accounting_outbox_v2', 'accounting_date_source',
  'outbox stores the accounting date authority'
);

select is(
  public.resolve_canonical_accounting_date_v1(
    'unknown_source', 'd1000000-0000-4000-8000-000000000001', 'unknown_event'
  ),
  null::date,
  'unknown sources never fall back to the processing date'
);

select is(
  ('2026-08-01 05:59:59+00'::timestamptz at time zone 'America/Tegucigalpa')::date,
  date '2026-07-31',
  'Honduras timezone preserves the prior local calendar date at the UTC boundary'
);

insert into public.suppliers (id, name, is_active)
values ('d1000000-0000-4000-8000-000000000002', 'Canonical date fixture', true);

insert into public.purchases (
  id, supplier_id, purchase_number, purchase_date, status, total
) values (
  'd1000000-0000-4000-8000-000000000003',
  'd1000000-0000-4000-8000-000000000002',
  'CANONICAL-DATE-PURCHASE', date '2026-07-20', 'draft', 100
);

insert into public.supplier_invoices (
  id, supplier_id, purchase_id, invoice_number, invoice_date, status, total
) values (
  'd1000000-0000-4000-8000-000000000004',
  'd1000000-0000-4000-8000-000000000002',
  'd1000000-0000-4000-8000-000000000003',
  'CANONICAL-DATE-INVOICE', date '2026-07-18', 'draft', 100
);

select is(
  public.resolve_canonical_accounting_date_v1(
    'supplier_invoice', 'd1000000-0000-4000-8000-000000000004',
    'supplier_invoice_received'
  ),
  date '2026-07-18',
  'supplier invoice uses its document date'
);

select is(
  public.resolve_canonical_accounting_date_v1(
    'purchase', 'd1000000-0000-4000-8000-000000000003',
    'purchase_confirmed'
  ),
  date '2026-07-18',
  'purchase prefers the linked supplier invoice date'
);

insert into public.accounting_outbox_v2 (
  id, feature_key, topic, source_type, source_id, event_purpose,
  posting_version, scenario, idempotency_key, occurred_at, cutover_at,
  status
) values (
  'd1000000-0000-4000-8000-000000000005',
  'sales_draft_v2', 'sales.recognized', 'order',
  'd1000000-0000-4000-8000-000000000006', 'sale_recognized',
  'v2', 'missing_canonical_date', 'canonical-date-missing-source',
  now(), now() - interval '1 minute', 'queued'
);

select set_config('request.jwt.claims', '{role:service_role}', true);

select is(
  public.process_accounting_outbox_v2(
    'd1000000-0000-4000-8000-000000000005',
    'canonical-date-test-worker', false
  )->>'error_code',
  'ACCOUNTING_DATE_REQUIRED',
  'missing canonical date is rejected with a controlled error'
);

select ok(
  exists (
    select 1 from public.accounting_outbox_v2
    where id = 'd1000000-0000-4000-8000-000000000005'
      and status = 'pending_data'
      and financial_event_id is null
      and journal_entry_id is null
      and last_error_code = 'ACCOUNTING_DATE_REQUIRED'
  ),
  'missing date remains pending without an event or journal draft'
);

select * from finish();
rollback;
