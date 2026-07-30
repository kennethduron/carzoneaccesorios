\set ON_ERROR_STOP on

begin;
select no_plan();
\ir fixtures/supplier_payment_opening_balance_repair_fixture.sql

insert into public.accounting_opening_balance_batches (
  id, journal_entry_id, control_line_id, control_account_id, batch_key,
  payables_created_before, protected_count, protected_supplier_count,
  protected_total, protected_hash, status
) values (
  '94000000-0000-4000-8000-000000000001',
  '5843045f-db47-429c-ad19-f75dc61cdd3e',
  'f7389203-9ac0-40b8-9822-edfceb0e38fb',
  '05847d56-7097-492b-b153-2db33a00b9cd',
  'test:supplier-multi-payment:opening',
  '2026-07-14 20:23:42.016954+00',
  26, 8, 1589972.61,
  '0e858a6fc17e097fbccfff3638584622d30e34a500f01b42116da2b865c390cd',
  'active'
);

insert into public.accounting_accounts (
  id, code, name, type, normal_balance, is_active, created_by
) values
  (
    '94000000-0000-4000-8000-000000000002',
    '1101001', 'CAJA GENERAL', 'asset', 'debit', true,
    '91000000-0000-4000-8000-000000000001'
  ),
  (
    '94000000-0000-4000-8000-000000000003',
    '1101005', 'BAC CHEQUES LPS', 'asset', 'debit', true,
    '91000000-0000-4000-8000-000000000001'
  ),
  (
    '94000000-0000-4000-8000-000000000004',
    '1101010', 'TARJETA DE DEBITO', 'asset', 'debit', true,
    '91000000-0000-4000-8000-000000000001'
  );

insert into public.accounting_mappings (
  mapping_type, source_key, account_id, priority, is_active,
  effective_from, created_by
) values
  (
    'payment_method', 'supplier_payment_cash',
    '94000000-0000-4000-8000-000000000002',
    1, true, '2026-01-01',
    '91000000-0000-4000-8000-000000000001'
  ),
  (
    'payment_method', 'supplier_payment_bank',
    '94000000-0000-4000-8000-000000000003',
    1, true, '2026-01-01',
    '91000000-0000-4000-8000-000000000001'
  ),
  (
    'payment_method', 'supplier_payment_card_debit',
    '94000000-0000-4000-8000-000000000004',
    1, true, '2026-01-01',
    '91000000-0000-4000-8000-000000000001'
  );

update public.accounting_feature_flags
set state = 'enabled',
    cutover_at = '2026-07-01 00:00:00-06',
    updated_by = '91000000-0000-4000-8000-000000000001'
where key in (
  'supplier_payment_draft_v2',
  'supplier_multi_invoice_payment_v1'
);

-- Two valid direct recognitions; the remaining obligations use the
-- immutable opening-balance control from the shared fixture.
insert into public.journal_entries (
  id, entry_number, entry_date, description, status,
  source_type, source_id, created_by, updated_by, posted_by, posted_at
) values (
  '94000000-0000-4000-8000-000000000005',
  'TEST-MULTI-DIRECT', '2026-07-15', 'Direct payable recognition',
  'publicada', 'financial_event',
  '94000000-0000-4000-8000-000000000006',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001',
  '91000000-0000-4000-8000-000000000001', now()
);

insert into public.financial_events (
  id, source_type, source_id, event_purpose, posting_version, status,
  occurred_at, source_snapshot, validation_errors, journal_entry_id, created_by
) values
  (
    '94000000-0000-4000-8000-000000000006',
    'accounts_payable', '96a95d10-d4c6-4f2d-ac48-0e904e619cf4',
    'accounts_payable_created', 'v1', 'posted', '2026-07-15 12:00:00-06',
    '{}'::jsonb, '[]'::jsonb,
    '94000000-0000-4000-8000-000000000005',
    '91000000-0000-4000-8000-000000000001'
  ),
  (
    '94000000-0000-4000-8000-000000000007',
    'accounts_payable', '13f1ec0e-300c-4493-bd5e-2c18333e2d6e',
    'accounts_payable_created', 'v1', 'posted', '2026-07-15 12:00:00-06',
    '{}'::jsonb, '[]'::jsonb,
    '94000000-0000-4000-8000-000000000005',
    '91000000-0000-4000-8000-000000000001'
  );

create temporary table multi_payment_results (
  name text primary key,
  result jsonb not null
) on commit drop;

select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

insert into multi_payment_results values (
  'single_full',
  public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000001',
    '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1',
    'cash', '2026-07-30', null,
    '[{"accounts_payable_id":"96a95d10-d4c6-4f2d-ac48-0e904e619cf4","applied_amount":6000.00}]',
    'Pago completo local', null
  )
);
select ok(
  (select (result->>'payment_total')::numeric = 6000
     and (result->>'application_count')::integer = 1
     and result->>'status' = 'paid'
   from multi_payment_results where name = 'single_full'),
  'one payable is paid by one economic header'
);

insert into multi_payment_results values (
  'two_mixed',
  public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000002',
    '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1',
    'bank_transfer', '2026-07-30', '  BAC   REF  0001  ',
    '[
      {"accounts_payable_id":"13f1ec0e-300c-4493-bd5e-2c18333e2d6e","applied_amount":100.00},
      {"accounts_payable_id":"0a7b7cfd-b7b8-407a-a923-d05792602a84","applied_amount":3600.00}
    ]',
    'Mezcla directa y saldo inicial', null
  )
);
select ok(
  (select (result->>'payment_total')::numeric = 3700
     and (result->>'application_count')::integer = 2
   from multi_payment_results where name = 'two_mixed'),
  'two payables support a full and partial mixed distribution'
);
select is(
  (
    select reference from public.supplier_payments
    where id = (
      select (result->>'payment_id')::uuid
      from multi_payment_results where name = 'two_mixed'
    )
  ),
  'BAC REF 0001',
  'bank reference whitespace is normalized'
);
select is(
  (
    select count(distinct recognition_origin)::integer
    from public.supplier_payment_applications
    where supplier_payment_id = (
      select (result->>'payment_id')::uuid
      from multi_payment_results where name = 'two_mixed'
    )
  ),
  2,
  'direct-event and opening-balance recognition can coexist safely'
);

insert into multi_payment_results values (
  'five_mixed',
  public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000003',
    'da0489ab-f013-453a-8542-c568bd219bfc',
    'card_credit', '2026-07-30', 'CARD-TEST-01',
    '[
      {"accounts_payable_id":"040fb5dc-c06b-49e7-b1ff-9eec24a5ed59","applied_amount":100.00},
      {"accounts_payable_id":"1250db16-8803-40f4-a4a5-4afca0271ced","applied_amount":4715.00},
      {"accounts_payable_id":"76f46a09-dc11-4f0d-b1b2-0ca7deccd720","applied_amount":100.00},
      {"accounts_payable_id":"fd8f8839-4eda-4b29-86c3-c721123becd5","applied_amount":100.00},
      {"accounts_payable_id":"a860a6d4-7232-4ce7-80a3-8395b2a8f974","applied_amount":100.00}
    ]',
    'Cinco aplicaciones', null
  )
);
select is(
  (
    select count(*)::integer
    from public.supplier_payment_applications
    where supplier_payment_id = (
      select (result->>'payment_id')::uuid
      from multi_payment_results where name = 'five_mixed'
    )
  ),
  5,
  'five applications are persisted beneath one header'
);

insert into multi_payment_results values (
  'all_partial_debit',
  public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000004',
    'c8ce3a31-2f25-4f6a-80d7-d7d9c45044fe',
    'card_debit', '2026-07-30', 'DEBIT-TEST-01',
    '[
      {"accounts_payable_id":"a1dd3335-b682-4bac-9924-579b9a812c76","applied_amount":100.00},
      {"accounts_payable_id":"96aa009b-03d7-49ee-a874-77aec8fa30e7","applied_amount":200.00}
    ]',
    'Dos aplicaciones parciales', null
  )
);
select is(
  (
    select count(*)::integer
    from public.accounts_payable payable
    where payable.id in (
      'a1dd3335-b682-4bac-9924-579b9a812c76',
      '96aa009b-03d7-49ee-a874-77aec8fa30e7'
    ) and payable.status = 'partial'
  ),
  2,
  'all-partial applications update each payable independently'
);

select is(
  (
    select count(*)::integer
    from public.accounting_outbox_v2
    where source_id = (
      select (result->>'payment_id')::uuid
      from multi_payment_results where name = 'two_mixed'
    )
      and event_purpose = 'supplier_payment'
  ),
  1,
  'one multi payment creates one V2 outbox'
);

insert into multi_payment_results values (
  'two_mixed_replay',
  public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000002',
    '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1',
    'bank_transfer', '2026-07-30', 'BAC REF 0001',
    '[
      {"accounts_payable_id":"0a7b7cfd-b7b8-407a-a923-d05792602a84","applied_amount":3600.00},
      {"accounts_payable_id":"13f1ec0e-300c-4493-bd5e-2c18333e2d6e","applied_amount":100.00}
    ]',
    'Mezcla directa y saldo inicial', null
  )
);
select ok(
  (select (result->>'replayed')::boolean
   from multi_payment_results where name = 'two_mixed_replay'),
  'identical request replays after balances changed without a second effect'
);
select throws_ok(
  $$select public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000002',
    '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1',
    'bank_transfer', '2026-07-30', 'DIFFERENT',
    '[{"accounts_payable_id":"13f1ec0e-300c-4493-bd5e-2c18333e2d6e","applied_amount":100.00}]',
    null, null
  )$$,
  '23505',
  'La clave de solicitud ya fue usada con un pago diferente.',
  'same request key with a different fingerprint is rejected'
);

select throws_ok(
  $$select public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000010',
    '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1',
    'cash', '2026-07-30', null,
    '[{"accounts_payable_id":"13f1ec0e-300c-4493-bd5e-2c18333e2d6e","applied_amount":1.00,"total":1.00}]',
    null, null
  )$$,
  '22023',
  'Cada aplicacion debe contener solo una CxP UUID y un importe positivo con dos decimales.',
  'additional application fields are rejected'
);
select throws_ok(
  $$select public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000011',
    '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1',
    'cash', '2026-07-30', null,
    '[
      {"accounts_payable_id":"13f1ec0e-300c-4493-bd5e-2c18333e2d6e","applied_amount":1.00},
      {"accounts_payable_id":"13f1ec0e-300c-4493-bd5e-2c18333e2d6e","applied_amount":1.00}
    ]',
    null, null
  )$$,
  '22023',
  'Una cuenta por pagar no puede aparecer dos veces.',
  'duplicate payable applications are rejected'
);
select throws_ok(
  $$select public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000012',
    '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1',
    'cash', '2026-07-30', null,
    '[{"accounts_payable_id":"13f1ec0e-300c-4493-bd5e-2c18333e2d6e","applied_amount":0}]',
    null, null
  )$$,
  '22023',
  'Todas las aplicaciones deben ser mayores que cero.',
  'zero application is rejected'
);
select throws_ok(
  $$select public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000013',
    '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1',
    'cash', '2026-07-30', null,
    '[{"accounts_payable_id":"13f1ec0e-300c-4493-bd5e-2c18333e2d6e","applied_amount":999999.99}]',
    null, null
  )$$,
  '40001',
  'El saldo de una cuenta por pagar cambio o la aplicacion lo excede.',
  'application above the locked balance is rejected'
);
select throws_ok(
  $$select public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000014',
    '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1',
    'cash', '2026-07-30', null,
    '[{"accounts_payable_id":"a1dd3335-b682-4bac-9924-579b9a812c76","applied_amount":1.00}]',
    null, null
  )$$,
  '22023',
  'Todas las cuentas por pagar deben pertenecer al mismo proveedor.',
  'mixed suppliers are rejected'
);
select throws_ok(
  $$select public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000015',
    '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1',
    'cash', '2026-07-30', null,
    '[{"accounts_payable_id":"94100000-0000-4000-8000-000000000099","applied_amount":1.00}]',
    null, null
  )$$,
  'P0002',
  'Una o mas cuentas por pagar no existen.',
  'missing payable rejects the whole transaction'
);
select throws_ok(
  $$select public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000016',
    '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1',
    'cash', '2026-07-30', null,
    '[{"accounts_payable_id":"96a95d10-d4c6-4f2d-ac48-0e904e619cf4","applied_amount":1.00}]',
    null, null
  )$$,
  '22023',
  'Una cuenta por pagar esta pagada, cancelada o no admite aplicaciones.',
  'a fully paid payable is rejected'
);
select throws_ok(
  $$select public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000017',
    '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1',
    'bank_transfer', '2026-07-30', null,
    '[{"accounts_payable_id":"13f1ec0e-300c-4493-bd5e-2c18333e2d6e","applied_amount":1.00}]',
    null, null
  )$$,
  '22023',
  'La referencia es obligatoria para una transferencia bancaria.',
  'bank transfer requires a reference'
);

update public.accounts_payable
set currency = 'USD'
where id = '6db34078-e987-48e8-89ff-3d81957b8dfe';
select throws_ok(
  $$select public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000018',
    'd7f4840f-03dd-40a8-a16b-27cf25a71ca8',
    'cash', '2026-07-30', null,
    '[{"accounts_payable_id":"6db34078-e987-48e8-89ff-3d81957b8dfe","applied_amount":1.00}]',
    null, null
  )$$,
  '22023',
  'La primera version acepta unicamente obligaciones en HNL.',
  'non-HNL payable is rejected'
);
update public.accounts_payable
set currency = 'HNL'
where id = '6db34078-e987-48e8-89ff-3d81957b8dfe';

update public.accounting_mappings
set is_active = false
where mapping_type = 'payment_method'
  and source_key = 'supplier_payment_cash';
select throws_ok(
  $$select public.register_supplier_multi_payment_v1(
    '94100000-0000-4000-8000-000000000019',
    'd7f4840f-03dd-40a8-a16b-27cf25a71ca8',
    'cash', '2026-07-30', null,
    '[{"accounts_payable_id":"6db34078-e987-48e8-89ff-3d81957b8dfe","applied_amount":1.00}]',
    null, null
  )$$,
  '55000',
  'Falta un mapping contable activo para el pago.',
  'inactive payment mapping blocks the whole payment'
);
update public.accounting_mappings
set is_active = true
where mapping_type = 'payment_method'
  and source_key = 'supplier_payment_cash';

select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"service_role"}',
  true
);
insert into multi_payment_results values (
  'worker_two',
  public.process_accounting_outbox_v2(
    (
      select (result->>'outbox_id')::uuid
      from multi_payment_results where name = 'two_mixed'
    ),
    'pg-tap-multi-worker', false
  )
);
select ok(
  (select (result->>'ok')::boolean
   from multi_payment_results where name = 'worker_two'),
  'the V2 worker processes the multi-application outbox'
);
select is(
  (
    select count(*)::integer
    from public.financial_events
    where source_type = 'supplier_payment'
      and source_id = (
        select result->>'payment_id'
        from multi_payment_results where name = 'two_mixed'
      )
      and event_purpose = 'supplier_payment'
      and posting_version = 'v2'
  ),
  1,
  'the worker creates exactly one V2 event'
);
select is(
  (
    select count(*)::integer
    from public.journal_entry_lines line
    join public.accounting_outbox_v2 box
      on box.journal_entry_id = line.journal_entry_id
    where box.id = (
      select (result->>'outbox_id')::uuid
      from multi_payment_results where name = 'two_mixed'
    )
  ),
  2,
  'the worker creates exactly two journal lines'
);
select ok(
  (
    select entry.status = 'borrador'
      and sum(line.debit) = 3700
      and sum(line.credit) = 3700
    from public.accounting_outbox_v2 box
    join public.journal_entries entry on entry.id = box.journal_entry_id
    join public.journal_entry_lines line on line.journal_entry_id = entry.id
    where box.id = (
      select (result->>'outbox_id')::uuid
      from multi_payment_results where name = 'two_mixed'
    )
    group by entry.status
  ),
  'the single draft is balanced and remains manual'
);
select is(
  (
    select count(*)::integer
    from public.financial_events
    where source_type = 'supplier_payment'
      and source_id = (
        select result->>'payment_id'
        from multi_payment_results where name = 'two_mixed'
      )
      and posting_version = 'v1'
  ),
  0,
  'multi-application payments do not enter V1'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
insert into multi_payment_results values (
  'void_before_worker',
  public.void_supplier_multi_payment_v1(
    (
      select (result->>'payment_id')::uuid
      from multi_payment_results where name = 'five_mixed'
    ),
    '94200000-0000-4000-8000-000000000001',
    'Prueba local antes del worker'
  )
);
select ok(
  (select result->>'status' = 'voided'
     and not (result->>'replayed')::boolean
   from multi_payment_results where name = 'void_before_worker'),
  'full reversal succeeds before the worker'
);
select is(
  (
    select count(*)::integer
    from public.supplier_payment_applications
    where supplier_payment_id = (
      select (result->>'payment_id')::uuid
      from multi_payment_results where name = 'five_mixed'
    ) and status = 'voided'
  ),
  5,
  'reversal preserves and voids every application snapshot'
);

insert into multi_payment_results values (
  'void_draft',
  public.void_supplier_multi_payment_v1(
    (
      select (result->>'payment_id')::uuid
      from multi_payment_results where name = 'two_mixed'
    ),
    '94200000-0000-4000-8000-000000000002',
    'Prueba local con borrador'
  )
);
select is(
  (
    select entry.status
    from public.accounting_outbox_v2 box
    join public.journal_entries entry on entry.id = box.journal_entry_id
    where box.id = (
      select (result->>'outbox_id')::uuid
      from multi_payment_results where name = 'two_mixed'
    )
  ),
  'anulada',
  'reversal annuls an existing draft'
);
insert into multi_payment_results values (
  'void_draft_replay',
  public.void_supplier_multi_payment_v1(
    (
      select (result->>'payment_id')::uuid
      from multi_payment_results where name = 'two_mixed'
    ),
    '94200000-0000-4000-8000-000000000002',
    'Prueba local con borrador'
  )
);
select ok(
  (select (result->>'replayed')::boolean
   from multi_payment_results where name = 'void_draft_replay'),
  'full reversal is idempotent'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"service_role"}',
  true
);
insert into multi_payment_results values (
  'worker_published',
  public.process_accounting_outbox_v2(
    (
      select (result->>'outbox_id')::uuid
      from multi_payment_results where name = 'all_partial_debit'
    ),
    'pg-tap-published-worker', false
  )
);
select set_config(
  'request.jwt.claims',
  '{"sub":"91000000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);
select lives_ok(
  format(
    'select public.post_journal_entry(%L::uuid, %s, null, null)',
    (
      select box.journal_entry_id
      from public.accounting_outbox_v2 box
      where box.id = (
        select (result->>'outbox_id')::uuid
        from multi_payment_results where name = 'all_partial_debit'
      )
    ),
    (
      select entry.version
      from public.accounting_outbox_v2 box
      join public.journal_entries entry on entry.id = box.journal_entry_id
      where box.id = (
        select (result->>'outbox_id')::uuid
        from multi_payment_results where name = 'all_partial_debit'
      )
    )
  ),
  'the draft can only be published through the explicit manual RPC'
);
insert into multi_payment_results values (
  'void_published',
  public.void_supplier_multi_payment_v1(
    (
      select (result->>'payment_id')::uuid
      from multi_payment_results where name = 'all_partial_debit'
    ),
    '94200000-0000-4000-8000-000000000003',
    'Prueba local despues de publicar'
  )
);
select is(
  (
    select count(*)::integer
    from public.accounting_outbox_v2 box
    where box.source_type = 'supplier_payment'
      and box.source_id = (
        select (result->>'payment_id')::uuid
        from multi_payment_results where name = 'all_partial_debit'
      )
      and box.event_purpose = 'supplier_payment_compensation'
      and box.posting_version = 'v2'
  ),
  1,
  'reversal after publication creates one compensation outbox'
);
insert into multi_payment_results values (
  'void_published_replay',
  public.void_supplier_multi_payment_v1(
    (
      select (result->>'payment_id')::uuid
      from multi_payment_results where name = 'all_partial_debit'
    ),
    '94200000-0000-4000-8000-000000000003',
    'Prueba local despues de publicar'
  )
);
select ok(
  (select (result->>'replayed')::boolean
   from multi_payment_results where name = 'void_published_replay')
  and (
    select count(*) = 1
    from public.accounting_outbox_v2 box
    where box.source_id = (
      select (result->>'payment_id')::uuid
      from multi_payment_results where name = 'all_partial_debit'
    ) and box.event_purpose = 'supplier_payment_compensation'
  ),
  'published-payment reversal replay creates no second compensation'
);

set local role authenticated;
select throws_ok(
  $$insert into public.supplier_payments (
    accounts_payable_id, supplier_id, amount, payment_method, status,
    paid_at, created_by
  ) values (
    '13f1ec0e-300c-4493-bd5e-2c18333e2d6e',
    '105da9a0-d1dc-4358-b1c6-bbcf56ef59b1',
    1, 'cash', 'paid', now(),
    '91000000-0000-4000-8000-000000000001'
  )$$,
  '42501',
  'permission denied for table supplier_payments',
  'authenticated direct payment insert is denied'
);
reset role;
select ok(
  has_table_privilege(
    'service_role', 'public.supplier_payment_applications', 'INSERT'
  ) and not has_table_privilege(
    'authenticated', 'public.supplier_payment_applications', 'INSERT'
  ),
  'service role retains internal access while authenticated writes are revoked'
);
select ok(
  exists (
    select 1 from public.supplier_payment_allocations_v1
    where allocation_mode = 'legacy_single'
  ) and exists (
    select 1 from public.supplier_payment_allocations_v1
    where allocation_mode = 'applications_v1'
  ),
  'canonical allocation view exposes legacy and new payments without backfill'
);
select ok(
  not exists (
    select 1
    from public.supplier_payments payment
    where payment.allocation_mode = 'applications_v1'
      and (
        select coalesce(sum(application.applied_amount), 0)
        from public.supplier_payment_applications application
        where application.supplier_payment_id = payment.id
      ) <> payment.amount
  ),
  'every multi-payment header equals its immutable application total'
);

select * from finish();
rollback;
