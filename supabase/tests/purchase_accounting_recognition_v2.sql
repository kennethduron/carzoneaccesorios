\set ON_ERROR_STOP on

begin;
set local timezone = 'America/Tegucigalpa';
select no_plan();

select has_column('public', 'purchases', 'accounting_recognition_version', 'purchase scope version exists');
select has_column('public', 'accounts_payable', 'accounting_recognition_version', 'AP scope version exists');
select has_function('public', 'route_purchase_recognition_accounting_v2', array['uuid','uuid'], 'purchase recognition router exists');
select has_function('public', 'process_purchase_recognition_outbox_v2', array['uuid','text','boolean'], 'purchase recognition worker exists');
select has_function('public', 'purchase_accounting_completeness_v2', array['uuid'], 'completeness classifier exists');
select has_function('public', 'purchase_recognition_validity_v2', array['uuid'], 'canonical purchase recognition validity gate exists');
select has_function('public', 'require_purchase_recognition_outbox_v2', array['uuid','uuid'], 'canonical outbox validator exists');
select is(
  (select state from public.accounting_feature_flags where key = 'purchase_recognition_draft_v2'),
  'disabled',
  'purchase recognition is installed disabled'
);
select is(
  (select value->>'mode' from public.accounting_automation_settings where key = 'automation_mode'),
  'disabled',
  'global automatic publication remains disabled'
);
select ok(
  not has_function_privilege('authenticated', 'public.process_purchase_recognition_outbox_v2(uuid,text,boolean)', 'execute'),
  'authenticated cannot execute the accounting worker'
);
select ok(
  not has_function_privilege('authenticated', 'public.purchase_accounting_completeness_v2(uuid)', 'execute'),
  'authenticated cannot bypass the accounting read authorization surface'
);
select ok(
  not has_function_privilege('authenticated', 'public.purchase_recognition_validity_v2(uuid)', 'execute'),
  'authenticated cannot execute the canonical purchase recognition validity gate'
);
select ok(
  (select prosecdef from pg_proc
   where oid = 'public.purchase_recognition_validity_v2(uuid)'::regprocedure),
  'canonical validity gate uses SECURITY DEFINER'
);
select ok(
  (select array_to_string(proconfig, ',') like '%search_path=public, pg_temp%'
   from pg_proc
   where oid = 'public.purchase_recognition_validity_v2(uuid)'::regprocedure),
  'canonical validity gate fixes its search path'
);
select ok(
  has_function_privilege('service_role', 'public.purchase_recognition_validity_v2(uuid)', 'execute'),
  'service role can execute the canonical validity gate'
);
select ok(
  not has_function_privilege('authenticated', 'public.require_purchase_recognition_outbox_v2(uuid,uuid)', 'execute'),
  'authenticated cannot invoke the canonical outbox validator'
);
select ok(
  has_function_privilege('service_role', 'public.process_purchase_recognition_outbox_v2(uuid,text,boolean)', 'execute'),
  'backend service can execute the accounting worker'
);
select ok(
  has_function_privilege('service_role', 'public.require_purchase_recognition_outbox_v2(uuid,uuid)', 'execute'),
  'backend service can validate the canonical obligation'
);

insert into public.roles(name, description, permissions)
values (
  'technical_owner',
  'Purchase recognition V2 local owner',
  '["purchases:manage","payables:manage","accounting:manage","accounting:settings"]'
)
on conflict(name) do update set permissions = excluded.permissions;

insert into auth.users(
  id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values (
  'b1010000-0000-4000-8000-000000000001',
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated', 'purchase-recognition@example.test', '',
  now(), '{}', '{}', now(), now()
);

insert into public.users(id, role_id, full_name, email, active)
values (
  'b1010000-0000-4000-8000-000000000001',
  (select id from public.roles where name = 'technical_owner'),
  'Purchase Recognition Local Owner',
  'purchase-recognition@example.test',
  true
)
on conflict(id) do update set role_id = excluded.role_id, active = true;

insert into public.suppliers(id, name, is_active, created_by)
values (
  'b1000000-0000-4000-8000-000000000001',
  'PURCHASE RECOGNITION LOCAL ONLY',
  true,
  'b1010000-0000-4000-8000-000000000001'
);

insert into public.products(
  id, category_id, sku, slug, name, brand, stock, reserved_stock,
  retail_price, wholesale_price, cost_price
)
values (
  'b1020000-0000-4000-8000-000000000001',
  (select id from public.categories order by created_at limit 1),
  'PURCHASE-RECOGNITION-LOCAL',
  'purchase-recognition-local',
  'PURCHASE RECOGNITION LOCAL ONLY',
  'Fixture', 10, 0, 200, 180, 100
);

insert into public.accounting_accounts(
  id, code, name, type, normal_balance, is_active, created_by
)
values
  ('b1100000-0000-4000-8000-000000000001', 'PRV2-INV', 'Inventario PRV2', 'asset', 'debit', true, 'b1010000-0000-4000-8000-000000000001'),
  ('b1100000-0000-4000-8000-000000000002', 'PRV2-AP', 'Proveedores PRV2', 'liability', 'credit', true, 'b1010000-0000-4000-8000-000000000001'),
  ('b1100000-0000-4000-8000-000000000003', 'PRV2-TAX', 'Impuesto compra PRV2', 'asset', 'debit', true, 'b1010000-0000-4000-8000-000000000001'),
  ('b1100000-0000-4000-8000-000000000004', 'PRV2-FRT', 'Flete compra PRV2', 'expense', 'debit', true, 'b1010000-0000-4000-8000-000000000001'),
  ('b1100000-0000-4000-8000-000000000005', 'PRV2-DIS', 'Descuento compra PRV2', 'cost', 'credit', true, 'b1010000-0000-4000-8000-000000000001'),
  ('b1100000-0000-4000-8000-000000000006', 'PRV2-CASH', 'Caja PRV2', 'asset', 'debit', true, 'b1010000-0000-4000-8000-000000000001'),
  ('b1100000-0000-4000-8000-000000000007', 'PRV2-BANK', 'Banco PRV2', 'asset', 'debit', true, 'b1010000-0000-4000-8000-000000000001'),
  ('b1100000-0000-4000-8000-000000000008', 'PRV2-CARD', 'Tarjeta PRV2', 'liability', 'credit', true, 'b1010000-0000-4000-8000-000000000001');

insert into public.accounting_mappings(
  mapping_type, source_key, account_id, priority, is_active,
  effective_from, created_by
)
values
  ('inventory', 'purchase_inventory', 'b1100000-0000-4000-8000-000000000001', 1, true, current_date - 365, 'b1010000-0000-4000-8000-000000000001'),
  ('default_account', 'accounts_payable', 'b1100000-0000-4000-8000-000000000002', 1, true, current_date - 365, 'b1010000-0000-4000-8000-000000000001'),
  ('tax', 'purchase_tax', 'b1100000-0000-4000-8000-000000000003', 1, true, current_date - 365, 'b1010000-0000-4000-8000-000000000001'),
  ('shipping', 'purchase_shipping', 'b1100000-0000-4000-8000-000000000004', 1, true, current_date - 365, 'b1010000-0000-4000-8000-000000000001'),
  ('discount', 'purchase_discount', 'b1100000-0000-4000-8000-000000000005', 1, true, current_date - 365, 'b1010000-0000-4000-8000-000000000001'),
  ('payment_method', 'supplier_payment_cash', 'b1100000-0000-4000-8000-000000000006', 1, true, current_date - 365, 'b1010000-0000-4000-8000-000000000001'),
  ('payment_method', 'supplier_payment_bank', 'b1100000-0000-4000-8000-000000000007', 1, true, current_date - 365, 'b1010000-0000-4000-8000-000000000001'),
  ('payment_method', 'supplier_payment_card', 'b1100000-0000-4000-8000-000000000008', 1, true, current_date - 365, 'b1010000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}',
  true
);

select lives_ok(
  $$select * from public.set_purchase_ap_automation_v1(true, 'Local purchase recognition V2 contract activation')$$,
  'purchase/AP confirmation is enabled locally'
);

-- Direct flag changes are local test setup only. Production activation remains
-- an independently authorized future operation through the controlled setter.
update public.accounting_feature_flags
set state = 'enabled',
    cutover_at = now() - interval '1 minute',
    updated_by = 'b1010000-0000-4000-8000-000000000001'
where key = 'supplier_payment_draft_v2';

create or replace function pg_temp.insert_purchase(
  p_id uuid,
  p_number text,
  p_date date,
  p_subtotal numeric,
  p_tax numeric,
  p_discount numeric,
  p_shipping numeric,
  p_currency text,
  p_product_id uuid default 'b1020000-0000-4000-8000-000000000001'
)
returns void
language plpgsql
as $$
begin
  insert into public.purchases(
    id, supplier_id, purchase_number, purchase_date, status,
    subtotal, tax_amount, discount_amount, shipping_amount, total,
    currency, notes, created_by
  )
  values (
    p_id, 'b1000000-0000-4000-8000-000000000001', p_number, p_date, 'draft',
    p_subtotal, p_tax, p_discount, p_shipping,
    round(p_subtotal + p_tax + p_shipping - p_discount, 2),
    p_currency, 'LOCAL SYNTHETIC ONLY', 'b1010000-0000-4000-8000-000000000001'
  );

  insert into public.purchase_items(
    purchase_id, product_id, description, quantity, unit_cost,
    tax_amount, discount_amount, total_cost
  )
  values (
    p_id, p_product_id, 'LOCAL SYNTHETIC ITEM', 1, p_subtotal,
    p_tax, p_discount, round(p_subtotal + p_tax - p_discount, 2)
  );
end;
$$;

create or replace function pg_temp.save_inventory_purchase(
  p_number text,
  p_subtotal numeric
)
returns uuid
language plpgsql
as $$
declare
  saved_id uuid;
begin
  select purchase_id into saved_id
  from public.save_purchase_with_inventory(
    null,
    jsonb_build_object(
      'supplier_id', 'b1000000-0000-4000-8000-000000000001',
      'purchase_number', p_number,
      'purchase_date', current_date,
      'shipping_amount', 0,
      'currency', 'HNL',
      'notes', 'LOCAL FEATURE OFF EQUIVALENCE'
    ),
    jsonb_build_array(jsonb_build_object(
      'product_id', 'b1020000-0000-4000-8000-000000000001',
      'description', 'LOCAL FEATURE OFF INVENTORY',
      'quantity', 1,
      'unit_cost', p_subtotal,
      'tax_amount', 0,
      'discount_amount', 0
    ))
  );
  return saved_id;
end;
$$;

create or replace function pg_temp.feature_off_signature(p_purchase_id uuid)
returns jsonb
language sql
stable
as $$
  with payable as (
    select id from public.accounts_payable where purchase_id = p_purchase_id
  ), payment as (
    select id from public.supplier_payments
    where accounts_payable_id in (select id from payable)
  ), payment_boxes as (
    select * from public.accounting_outbox_v2
    where source_type = 'supplier_payment'
      and source_id in (select id from payment)
      and event_purpose = 'supplier_payment'
      and posting_version = 'v2'
  )
  select jsonb_build_object(
    'inventory_movements', (
      select count(*) from public.inventory_movements
      where reference_type = 'purchase' and reference_id = p_purchase_id
    ),
    'payables', (select count(*) from payable),
    'supplier_payments', (select count(*) from payment),
    'purchase_v1_events', (
      select count(*) from public.financial_events event
      where event.posting_version = 'v1' and (
        (event.source_type = 'purchase' and event.source_id = p_purchase_id::text)
        or
        (event.source_type = 'accounts_payable' and event.source_id in (
          select id::text from payable
        ))
      )
    ),
    'payment_outboxes', (select count(*) from payment_boxes),
    'payment_outbox_duplicate_avoided', coalesce((
      select bool_or(duplicate_avoided) from payment_boxes
    ), false),
    'payment_route_events', (
      select count(*) from public.accounting_event_log log
      where log.source_type = 'supplier_payment'
        and log.source_id in (select id::text from payment)
    ),
    'payment_financial_events', (
      select count(*) from public.financial_events event
      where event.source_type = 'supplier_payment'
        and event.source_id in (select id::text from payment)
        and event.posting_version = 'v2'
    ),
    'payment_drafts', (
      select count(*)
      from public.journal_entries entry
      join public.financial_events event
        on entry.source_type = 'financial_event'
       and entry.source_id = event.id::text
      where event.source_type = 'supplier_payment'
        and event.source_id in (select id::text from payment)
    ),
    'purchase_recognition_outboxes', (
      select count(*) from public.accounting_outbox_v2 box
      where box.source_type = 'accounts_payable'
        and box.source_id in (select id from payable)
        and box.event_purpose = 'accounts_payable_created'
        and box.posting_version = 'v2'
    )
  );
$$;

-- Feature OFF contract: compare the preserved origin/main RPC body with the
-- V2 wrapper while purchase recognition itself remains disabled.
create temp table _feature_off_cases(
  condition text primary key,
  baseline_purchase_id uuid not null,
  wrapper_purchase_id uuid not null
);
insert into _feature_off_cases values
  ('credit',
    pg_temp.save_inventory_purchase('PRV2-OFF-BASE-CREDIT', 101),
    pg_temp.save_inventory_purchase('PRV2-OFF-WRAP-CREDIT', 101)),
  ('cash',
    pg_temp.save_inventory_purchase('PRV2-OFF-BASE-CASH', 102),
    pg_temp.save_inventory_purchase('PRV2-OFF-WRAP-CASH', 102)),
  ('partial',
    pg_temp.save_inventory_purchase('PRV2-OFF-BASE-PARTIAL', 103),
    pg_temp.save_inventory_purchase('PRV2-OFF-WRAP-PARTIAL', 103));

select * from public.confirm_purchase_with_payable_v1_pre_recognition(
  (select baseline_purchase_id from _feature_off_cases where condition = 'credit'),
  'credit', current_date + 30, 0, null, null, null,
  'b1200000-0000-4000-8000-000000000101'
);
select * from public.confirm_purchase_with_payable_v1(
  (select wrapper_purchase_id from _feature_off_cases where condition = 'credit'),
  'credit', current_date + 30, 0, null, null, null,
  'b1200000-0000-4000-8000-000000000102'
);
select * from public.confirm_purchase_with_payable_v1_pre_recognition(
  (select baseline_purchase_id from _feature_off_cases where condition = 'cash'),
  'cash', null, 0, 'cash', current_date, 'LOCAL',
  'b1200000-0000-4000-8000-000000000103'
);
select * from public.confirm_purchase_with_payable_v1(
  (select wrapper_purchase_id from _feature_off_cases where condition = 'cash'),
  'cash', null, 0, 'cash', current_date, 'LOCAL',
  'b1200000-0000-4000-8000-000000000104'
);
select * from public.confirm_purchase_with_payable_v1_pre_recognition(
  (select baseline_purchase_id from _feature_off_cases where condition = 'partial'),
  'partial', current_date + 30, 40, 'bank_transfer', current_date, 'LOCAL',
  'b1200000-0000-4000-8000-000000000105'
);
select * from public.confirm_purchase_with_payable_v1(
  (select wrapper_purchase_id from _feature_off_cases where condition = 'partial'),
  'partial', current_date + 30, 40, 'bank_transfer', current_date, 'LOCAL',
  'b1200000-0000-4000-8000-000000000106'
);

select is(
  pg_temp.feature_off_signature((select wrapper_purchase_id from _feature_off_cases where condition = 'credit')),
  pg_temp.feature_off_signature((select baseline_purchase_id from _feature_off_cases where condition = 'credit')),
  'feature OFF credit confirmation is observably baseline-equivalent'
);
select is(
  pg_temp.feature_off_signature((select wrapper_purchase_id from _feature_off_cases where condition = 'cash')),
  pg_temp.feature_off_signature((select baseline_purchase_id from _feature_off_cases where condition = 'cash')),
  'feature OFF cash confirmation is observably baseline-equivalent'
);
select is(
  pg_temp.feature_off_signature((select wrapper_purchase_id from _feature_off_cases where condition = 'partial')),
  pg_temp.feature_off_signature((select baseline_purchase_id from _feature_off_cases where condition = 'partial')),
  'feature OFF partial confirmation is observably baseline-equivalent'
);
select is(
  (
    select sum(
      ((pg_temp.feature_off_signature(wrapper_purchase_id)->>'payment_route_events')::integer)
      - ((pg_temp.feature_off_signature(baseline_purchase_id)->>'payment_route_events')::integer)
    )::integer
    from _feature_off_cases
  ),
  0,
  'feature OFF adds zero supplier-payment routing events'
);

update public.accounting_feature_flags
set state = 'enabled',
    cutover_at = now() - interval '1 minute',
    updated_by = 'b1010000-0000-4000-8000-000000000001'
where key = 'purchase_recognition_draft_v2';

-- A/E/F/G: credit purchase with inventory, tax, freight, and discount.
create temp table _credit_saved as
select * from public.save_purchase_with_inventory(
  null,
  jsonb_build_object(
    'supplier_id', 'b1000000-0000-4000-8000-000000000001',
    'purchase_number', 'PRV2-CREDIT',
    'purchase_date', current_date,
    'shipping_amount', 100,
    'currency', 'HNL',
    'notes', 'LOCAL SYNTHETIC ONLY'
  ),
  jsonb_build_array(jsonb_build_object(
    'product_id', 'b1020000-0000-4000-8000-000000000001',
    'description', 'LOCAL SYNTHETIC INVENTORY',
    'quantity', 10,
    'unit_cost', 100,
    'tax_amount', 150,
    'discount_amount', 50
  ))
);

select is(
  (select count(*)::integer from public.inventory_movements
   where reference_type = 'purchase'
     and reference_id = (select purchase_id from _credit_saved)),
  1,
  'draft purchase has its physical inventory movement'
);
select lives_ok(
  $$select * from public.confirm_purchase_with_payable_v1(
    (select purchase_id from _credit_saved), 'credit', current_date + 30,
    0, null, null, null, 'b1200000-0000-4000-8000-000000000001'
  )$$,
  'credit purchase confirmation persists AP and recognition obligation atomically'
);

create temp table _credit_fact as
select
  payable.id as payable_id,
  box.id as outbox_id
from public.accounts_payable payable
join public.accounting_outbox_v2 box
  on box.source_type = 'accounts_payable'
 and box.source_id = payable.id
 and box.event_purpose = 'accounts_payable_created'
 and box.posting_version = 'v2'
where payable.purchase_id = (select purchase_id from _credit_saved);

select is((select count(*)::integer from _credit_fact), 1, 'credit purchase has one durable recognition obligation');
select is(
  (select count(*)::integer from public.financial_events event
   where event.source_type = 'accounts_payable'
     and event.source_id = (select payable_id::text from _credit_fact)
     and event.event_purpose = 'accounts_payable_created'
     and event.posting_version = 'v1'),
  1,
  'canonical AP-created V1 event still exists exactly once'
);
select is(
  (select count(*)::integer from public.financial_events event
   where event.source_type = 'purchase'
     and event.source_id = (select purchase_id::text from _credit_saved)
     and event.event_purpose = 'purchase_confirmed'),
  1,
  'purchase-confirmed remains one operational control event'
);
select is(
  public.purchase_accounting_completeness_v2((select payable_id from _credit_fact)),
  'PURCHASE_ACCOUNTING_PENDING',
  'queued obligation is deterministically pending'
);

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);

select lives_ok(
  $$select public.process_accounting_outbox_v2(
    (select outbox_id from _credit_fact), 'pgtap-credit-worker', false
  )$$,
  'credit recognition worker creates the draft'
);
select is(
  public.purchase_accounting_completeness_v2((select payable_id from _credit_fact)),
  'PURCHASE_ACCOUNTING_DRAFTED',
  'completed purchase recognition is deterministically drafted'
);
select is(
  (select status from public.financial_events event
   where event.source_type = 'accounts_payable'
     and event.source_id = (select payable_id::text from _credit_fact)
     and event.event_purpose = 'accounts_payable_created'
     and event.posting_version = 'v1'),
  'skipped',
  'V1 AP event is preserved but made accounting-ineligible after V2 ownership'
);
select ok(
  (select validation_errors @> '["SUPERSEDED_BY_V2"]'::jsonb
   from public.financial_events event
   where event.source_type = 'accounts_payable'
     and event.source_id = (select payable_id::text from _credit_fact)
     and event.event_purpose = 'accounts_payable_created'
     and event.posting_version = 'v1'),
  'preserved V1 event exposes the superseded business state'
);
select throws_ok(
  $$select public.create_journal_draft_from_financial_event(
    (select id from public.financial_events event
     where event.source_type = 'accounts_payable'
       and event.source_id = (select payable_id::text from _credit_fact)
       and event.event_purpose = 'accounts_payable_created'
       and event.posting_version = 'v1'),
    current_date, 'Blocked duplicate V1', '[]'::jsonb, null, null
  )$$,
  '23514', 'SUPERSEDED_BY_V2',
  'manual V1 draft RPC fails closed for a V2-owned AP'
);
select throws_ok(
  $$insert into public.journal_entries(
    entry_number, entry_date, description, status,
    source_type, source_id, created_by
  ) values (
    'PRV2-BLOCK-V1', current_date, 'Blocked direct V1 journal', 'borrador',
    'financial_event',
    (select id::text from public.financial_events event
     where event.source_type = 'accounts_payable'
       and event.source_id = (select payable_id::text from _credit_fact)
       and event.event_purpose = 'accounts_payable_created'
       and event.posting_version = 'v1'),
    'b1010000-0000-4000-8000-000000000001'
  )$$,
  '23514', 'SUPERSEDED_BY_V2',
  'database journal guard blocks alternate-client V1 recognition'
);

-- Disabling the feature stops new enrollment but never transfers an already
-- owned AP back to V1.
update public.accounting_feature_flags
set state = 'disabled', cutover_at = null
where key = 'purchase_recognition_draft_v2';
select throws_ok(
  $$select public.create_journal_draft_from_financial_event(
    (select id from public.financial_events event
     where event.source_type = 'accounts_payable'
       and event.source_id = (select payable_id::text from _credit_fact)
       and event.event_purpose = 'accounts_payable_created'
       and event.posting_version = 'v1'),
    current_date, 'Blocked after disable', '[]'::jsonb, null, null
  )$$,
  '23514', 'SUPERSEDED_BY_V2',
  'already V2-owned AP remains superseded after feature disable'
);
select is(
  (public.process_accounting_outbox_v2(
    (select outbox_id from _credit_fact), 'pgtap-disabled-replay', true
  )->>'reason'),
  'existing_exact_chain_reused',
  'exact durable V2 chain remains reusable while enrollment flag is disabled'
);
select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);
create temp table _post_disable_saved as
select pg_temp.save_inventory_purchase('PRV2-POST-DISABLE', 111) purchase_id;
select * from public.confirm_purchase_with_payable_v1(
  (select purchase_id from _post_disable_saved), 'credit', current_date + 30,
  0, null, null, null, 'b1200000-0000-4000-8000-000000000107'
);
select ok(
  (select accounting_recognition_version is null
   from public.accounts_payable
   where purchase_id = (select purchase_id from _post_disable_saved)),
  'new purchase while disabled remains baseline V1-owned'
);
select is(
  (select count(*)::integer from public.accounting_outbox_v2 box
   join public.accounts_payable payable on payable.id = box.source_id
   where payable.purchase_id = (select purchase_id from _post_disable_saved)
     and box.event_purpose = 'accounts_payable_created'
     and box.posting_version = 'v2'),
  0,
  'feature disable creates no new V2 recognition obligation'
);
update public.accounting_feature_flags
set state = 'enabled',
    cutover_at = now() - interval '1 minute',
    updated_by = 'b1010000-0000-4000-8000-000000000001'
where key = 'purchase_recognition_draft_v2';
select ok(
  not public.has_canonical_v2_accounting_chain_v1(
    'accounts_payable',
    (select id::text from public.accounts_payable
     where purchase_id = (select purchase_id from _post_disable_saved)),
    'accounts_payable_created'
  ),
  're-enable does not retroactively enroll a purchase confirmed while disabled'
);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (select entry.status from public.journal_entries entry
   join public.accounting_outbox_v2 box on box.journal_entry_id = entry.id
   where box.id = (select outbox_id from _credit_fact)),
  'borrador',
  'purchase recognition is draft-only'
);
select is(
  (select entry.entry_date from public.journal_entries entry
   join public.accounting_outbox_v2 box on box.journal_entry_id = entry.id
   where box.id = (select outbox_id from _credit_fact)),
  current_date,
  'purchase date is the canonical accounting date when no supplier invoice exists'
);
select is(
  (select debit from public.journal_entry_lines line
   join public.accounting_outbox_v2 box on box.journal_entry_id = line.journal_entry_id
   where box.id = (select outbox_id from _credit_fact)
     and line.account_id = 'b1100000-0000-4000-8000-000000000001'),
  1000.00::numeric,
  'inventory debit equals the full product subtotal'
);
select is(
  (select debit from public.journal_entry_lines line
   join public.accounting_outbox_v2 box on box.journal_entry_id = line.journal_entry_id
   where box.id = (select outbox_id from _credit_fact)
     and line.account_id = 'b1100000-0000-4000-8000-000000000003'),
  150.00::numeric,
  'recoverable tax is separated'
);
select is(
  (select debit from public.journal_entry_lines line
   join public.accounting_outbox_v2 box on box.journal_entry_id = line.journal_entry_id
   where box.id = (select outbox_id from _credit_fact)
     and line.account_id = 'b1100000-0000-4000-8000-000000000004'),
  100.00::numeric,
  'purchase freight is separated'
);
select is(
  (select credit from public.journal_entry_lines line
   join public.accounting_outbox_v2 box on box.journal_entry_id = line.journal_entry_id
   where box.id = (select outbox_id from _credit_fact)
     and line.account_id = 'b1100000-0000-4000-8000-000000000005'),
  50.00::numeric,
  'purchase discount is separated'
);
select is(
  (select credit from public.journal_entry_lines line
   join public.accounting_outbox_v2 box on box.journal_entry_id = line.journal_entry_id
   where box.id = (select outbox_id from _credit_fact)
     and line.account_id = 'b1100000-0000-4000-8000-000000000002'),
  1200.00::numeric,
  'AP credit equals the full obligation'
);
select is(
  (select round(sum(line.debit), 2) from public.journal_entry_lines line
   join public.accounting_outbox_v2 box on box.journal_entry_id = line.journal_entry_id
   where box.id = (select outbox_id from _credit_fact)),
  (select round(sum(line.credit), 2) from public.journal_entry_lines line
   join public.accounting_outbox_v2 box on box.journal_entry_id = line.journal_entry_id
   where box.id = (select outbox_id from _credit_fact)),
  'purchase recognition journal balances exactly'
);
select is(
  (select count(*)::integer from public.accounting_outbox_v2
   where source_type = 'supplier_payment'
     and metadata->>'purchase_id' = (select purchase_id::text from _credit_saved)),
  0,
  'credit purchase has no payment journal without a payment'
);

-- I/J: route and process retries reuse the one canonical fact/draft.
select is(
  public.route_purchase_recognition_accounting_v2(
    (select payable_id from _credit_fact),
    'b1010000-0000-4000-8000-000000000001'
  ),
  (select outbox_id from _credit_fact),
  'recognition routing retry reuses the outbox'
);
select lives_ok(
  $$select public.process_accounting_outbox_v2(
    (select outbox_id from _credit_fact), 'pgtap-credit-retry', true
  )$$,
  'recognition processing retry is safe'
);
select is(
  (select count(*)::integer from public.financial_events
   where source_type = 'accounts_payable'
     and source_id = (select payable_id::text from _credit_fact)
     and event_purpose = 'accounts_payable_created'
     and posting_version = 'v2'),
  1,
  'recognition retries retain one V2 event'
);
select is(
  (select count(*)::integer from public.journal_entries entry
   join public.financial_events event
     on entry.source_type = 'financial_event' and entry.source_id = event.id::text
   where event.source_type = 'accounts_payable'
     and event.source_id = (select payable_id::text from _credit_fact)
     and event.event_purpose = 'accounts_payable_created'
     and event.posting_version = 'v2'),
  1,
  'recognition retries retain one draft'
);

select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- Canonical supplier-document date through the specialized V2 worker.
select pg_temp.insert_purchase(
  'b1300000-0000-4000-8000-000000000020',
  'PRV2-INVOICE-DATE', current_date - 1, 300, 0, 0, 0, 'HNL'
);
insert into public.supplier_invoices(
  id, supplier_id, purchase_id, invoice_number, invoice_date, due_date,
  status, subtotal, tax_amount, discount_amount, total, currency, created_by
)
values (
  'b1600000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'b1300000-0000-4000-8000-000000000020',
  'PRV2-SUPPLIER-INVOICE', current_date - 2, current_date + 30,
  'received', 300, 0, 0, 300, 'HNL',
  'b1010000-0000-4000-8000-000000000001'
);
select * from public.confirm_purchase_with_payable_v1(
  'b1300000-0000-4000-8000-000000000020', 'credit', current_date + 30,
  0, null, null, null, 'b1200000-0000-4000-8000-000000000020'
);
create temp table _invoice_date_fact as
select payable.id payable_id, box.id outbox_id
from public.accounts_payable payable
join public.accounting_outbox_v2 box
  on box.source_type = 'accounts_payable'
 and box.source_id = payable.id
 and box.event_purpose = 'accounts_payable_created'
 and box.posting_version = 'v2'
where payable.purchase_id = 'b1300000-0000-4000-8000-000000000020';
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.process_accounting_outbox_v2(
    (select outbox_id from _invoice_date_fact), 'pgtap-invoice-date', false
  )$$,
  'specialized purchase worker processes a supplier-invoice purchase'
);
select is(
  (select accounting_date from public.accounting_outbox_v2
   where id = (select outbox_id from _invoice_date_fact)),
  current_date - 2,
  'supplier invoice date is the canonical outbox date'
);
select is(
  (select entry.entry_date
   from public.journal_entries entry
   join public.accounting_outbox_v2 box on box.journal_entry_id = entry.id
   where box.id = (select outbox_id from _invoice_date_fact)),
  current_date - 2,
  'specialized worker preserves supplier invoice date on the draft'
);

select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- C/H: cash purchase creates recognition plus a distinct full settlement.
select pg_temp.insert_purchase('b1300000-0000-4000-8000-000000000001', 'PRV2-CASH', current_date, 800, 0, 0, 0, 'HNL');
select lives_ok(
  $$select * from public.confirm_purchase_with_payable_v1(
    'b1300000-0000-4000-8000-000000000001', 'cash', null, 0,
    'cash', current_date, 'LOCAL', 'b1200000-0000-4000-8000-000000000002'
  )$$,
  'cash purchase confirmation creates AP and immediate settlement facts'
);
create temp table _cash_facts as
select
  payable.id as payable_id,
  purchase.initial_supplier_payment_id as payment_id,
  recognition.id as recognition_outbox_id,
  payment_box.id as payment_outbox_id
from public.purchases purchase
join public.accounts_payable payable on payable.purchase_id = purchase.id
join public.accounting_outbox_v2 recognition
  on recognition.source_type = 'accounts_payable'
 and recognition.source_id = payable.id
 and recognition.event_purpose = 'accounts_payable_created'
left join public.accounting_outbox_v2 payment_box
  on payment_box.source_type = 'supplier_payment'
 and payment_box.source_id = purchase.initial_supplier_payment_id
 and payment_box.event_purpose = 'supplier_payment'
where purchase.id = 'b1300000-0000-4000-8000-000000000001';
select ok((select payment_outbox_id is not null from _cash_facts), 'cash payment has one durable settlement obligation');

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select lives_ok(
  $$select public.process_accounting_outbox_v2(
    (select payment_outbox_id from _cash_facts), 'pgtap-payment-early', false
  )$$,
  'payment worker safely waits when recognition draft is not ready'
);
select is(
  (select last_error_code from public.accounting_outbox_v2 where id = (select payment_outbox_id from _cash_facts)),
  'PURCHASE_ACCOUNTING_DEPENDENCY_PENDING',
  'new-scope payment is gated on a valid purchase recognition draft'
);
select lives_ok(
  $$select public.process_accounting_outbox_v2(
    (select recognition_outbox_id from _cash_facts), 'pgtap-cash-recognition', false
  )$$,
  'cash purchase recognition draft is created first'
);
select lives_ok(
  $$select public.process_accounting_outbox_v2(
    (select payment_outbox_id from _cash_facts), 'pgtap-cash-payment', true
  )$$,
  'cash settlement draft is created after recognition'
);
select is(
  (select count(*)::integer from public.journal_entries entry
   join public.accounting_outbox_v2 box on box.journal_entry_id = entry.id
   where box.id in (
     (select recognition_outbox_id from _cash_facts),
     (select payment_outbox_id from _cash_facts)
   )),
  2,
  'cash purchase retains the two-stage accounting architecture'
);
select is(
  (select count(*)::integer from public.journal_entry_lines line
   join public.accounting_outbox_v2 box on box.journal_entry_id = line.journal_entry_id
   where box.id = (select recognition_outbox_id from _cash_facts)
     and (line.debit = 0 or line.credit = 0)),
  2,
  'zero tax/freight/discount create no zero-value lines'
);
select is(
  (select count(*)::integer from public.journal_entry_lines line
   join public.accounting_outbox_v2 box on box.journal_entry_id = line.journal_entry_id
   where box.id = (select payment_outbox_id from _cash_facts)
     and line.account_id = 'b1100000-0000-4000-8000-000000000001'),
  0,
  'inventory is never added to supplier payment'
);
select is(
  (select debit from public.journal_entry_lines line
   join public.accounting_outbox_v2 box on box.journal_entry_id = line.journal_entry_id
   where box.id = (select payment_outbox_id from _cash_facts)
     and line.account_id = 'b1100000-0000-4000-8000-000000000002'),
  800.00::numeric,
  'cash settlement debits AP only for the payment amount'
);
select is(
  (select credit from public.journal_entry_lines line
   join public.accounting_outbox_v2 box on box.journal_entry_id = line.journal_entry_id
   where box.id = (select payment_outbox_id from _cash_facts)
     and line.account_id = 'b1100000-0000-4000-8000-000000000006'),
  800.00::numeric,
  'cash settlement credits the configured cash account'
);

select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- D: partial payment recognizes 100% of inventory and settles only the payment.
select pg_temp.insert_purchase('b1300000-0000-4000-8000-000000000002', 'PRV2-PARTIAL', current_date, 500, 0, 0, 0, 'HNL');
select lives_ok(
  $$select * from public.confirm_purchase_with_payable_v1(
    'b1300000-0000-4000-8000-000000000002', 'partial', current_date + 30,
    200, 'bank_transfer', current_date, 'LOCAL',
    'b1200000-0000-4000-8000-000000000003'
  )$$,
  'partial purchase confirmation succeeds'
);
create temp table _partial_facts as
select
  payable.id as payable_id,
  purchase.initial_supplier_payment_id as payment_id,
  recognition.id as recognition_outbox_id,
  payment_box.id as payment_outbox_id
from public.purchases purchase
join public.accounts_payable payable on payable.purchase_id = purchase.id
join public.accounting_outbox_v2 recognition
  on recognition.source_type = 'accounts_payable'
 and recognition.source_id = payable.id
 and recognition.event_purpose = 'accounts_payable_created'
join public.accounting_outbox_v2 payment_box
  on payment_box.source_type = 'supplier_payment'
 and payment_box.source_id = purchase.initial_supplier_payment_id
 and payment_box.event_purpose = 'supplier_payment'
where purchase.id = 'b1300000-0000-4000-8000-000000000002';

select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.process_accounting_outbox_v2((select recognition_outbox_id from _partial_facts), 'pgtap-partial-recognition', false);
select public.process_accounting_outbox_v2((select payment_outbox_id from _partial_facts), 'pgtap-partial-payment', false);
select is(
  (select debit from public.journal_entry_lines line
   join public.accounting_outbox_v2 box on box.journal_entry_id = line.journal_entry_id
   where box.id = (select recognition_outbox_id from _partial_facts)
     and line.account_id = 'b1100000-0000-4000-8000-000000000001'),
  500.00::numeric,
  'partial payment does not proportionally reduce inventory recognition'
);
select is(
  (select debit from public.journal_entry_lines line
   join public.accounting_outbox_v2 box on box.journal_entry_id = line.journal_entry_id
   where box.id = (select payment_outbox_id from _partial_facts)
     and line.account_id = 'b1100000-0000-4000-8000-000000000002'),
  200.00::numeric,
  'partial payment settles only its own amount'
);

select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- L: unsupported currencies fail closed without a journal.
select pg_temp.insert_purchase('b1300000-0000-4000-8000-000000000003', 'PRV2-USD', current_date, 100, 0, 0, 0, 'USD');
select * from public.confirm_purchase_with_payable_v1(
  'b1300000-0000-4000-8000-000000000003', 'credit', current_date + 30,
  0, null, null, null, 'b1200000-0000-4000-8000-000000000004'
);
create temp table _usd_fact as
select payable.id payable_id, box.id outbox_id
from public.accounts_payable payable
join public.accounting_outbox_v2 box on box.source_id = payable.id
where payable.purchase_id = 'b1300000-0000-4000-8000-000000000003'
  and box.event_purpose = 'accounts_payable_created';
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.process_accounting_outbox_v2((select outbox_id from _usd_fact), 'pgtap-usd', false);
select is(
  (select last_error_code from public.accounting_outbox_v2 where id = (select outbox_id from _usd_fact)),
  'PURCHASE_ACCOUNTING_UNSUPPORTED_CURRENCY',
  'unsupported currency is fail-closed'
);
select is(
  (select journal_entry_id from public.accounting_outbox_v2 where id = (select outbox_id from _usd_fact)),
  null::uuid,
  'unsupported currency creates no wrong draft'
);

-- M: missing required mapping is configuration-required and draftless.
delete from public.accounting_mappings
where mapping_type = 'inventory' and source_key = 'purchase_inventory';
select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select pg_temp.insert_purchase('b1300000-0000-4000-8000-000000000004', 'PRV2-NOMAP', current_date, 100, 0, 0, 0, 'HNL');
select * from public.confirm_purchase_with_payable_v1(
  'b1300000-0000-4000-8000-000000000004', 'credit', current_date + 30,
  0, null, null, null, 'b1200000-0000-4000-8000-000000000005'
);
create temp table _nomap_fact as
select payable.id payable_id, box.id outbox_id
from public.accounts_payable payable
join public.accounting_outbox_v2 box on box.source_id = payable.id
where payable.purchase_id = 'b1300000-0000-4000-8000-000000000004'
  and box.event_purpose = 'accounts_payable_created';
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.process_accounting_outbox_v2((select outbox_id from _nomap_fact), 'pgtap-nomap', false);
select is(
  public.purchase_accounting_completeness_v2((select payable_id from _nomap_fact)),
  'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED',
  'missing account mapping is configuration-required'
);
select is(
  (select journal_entry_id from public.accounting_outbox_v2 where id = (select outbox_id from _nomap_fact)),
  null::uuid,
  'missing account mapping fabricates no account or draft'
);
select is(
  (select missing_key from public.accounting_outbox_v2 where id = (select outbox_id from _nomap_fact)),
  'inventory:purchase_inventory',
  'missing inventory mapping reports the sanitized actionable key'
);
select is(
  (select count(*)::integer from public.inventory_movements
   where reference_type = 'purchase'
     and reference_id = 'b1300000-0000-4000-8000-000000000004'),
  0,
  'accounting failure creates no inventory movement'
);
insert into public.accounting_mappings(
  mapping_type, source_key, account_id, priority, is_active,
  effective_from, created_by
)
values (
  'inventory', 'purchase_inventory', 'b1100000-0000-4000-8000-000000000001',
  1, true, current_date - 365, 'b1010000-0000-4000-8000-000000000001'
);

-- Missing AP mapping is independently fail-closed.
delete from public.accounting_mappings
where mapping_type = 'default_account' and source_key = 'accounts_payable';
select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select pg_temp.insert_purchase('b1300000-0000-4000-8000-000000000030', 'PRV2-NO-AP-MAP', current_date, 110, 0, 0, 0, 'HNL');
select * from public.confirm_purchase_with_payable_v1(
  'b1300000-0000-4000-8000-000000000030', 'credit', current_date + 30,
  0, null, null, null, 'b1200000-0000-4000-8000-000000000030'
);
create temp table _no_ap_map as
select payable.id payable_id, box.id outbox_id
from public.accounts_payable payable
join public.accounting_outbox_v2 box on box.source_id = payable.id
where payable.purchase_id = 'b1300000-0000-4000-8000-000000000030'
  and box.event_purpose = 'accounts_payable_created';
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.process_accounting_outbox_v2((select outbox_id from _no_ap_map), 'pgtap-no-ap-map', false);
select is(public.purchase_accounting_completeness_v2((select payable_id from _no_ap_map)), 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED', 'missing AP mapping is configuration-required');
select is((select journal_entry_id from public.accounting_outbox_v2 where id = (select outbox_id from _no_ap_map)), null::uuid, 'missing AP mapping creates no draft');
select is((select missing_key from public.accounting_outbox_v2 where id = (select outbox_id from _no_ap_map)), 'default_account:accounts_payable', 'missing AP mapping reports its sanitized key');
select is((select count(*)::integer from public.inventory_movements where reference_type = 'purchase' and reference_id = 'b1300000-0000-4000-8000-000000000030'), 0, 'missing AP mapping worker changes no inventory');
insert into public.accounting_mappings(mapping_type, source_key, account_id, priority, is_active, effective_from, created_by)
values ('default_account', 'accounts_payable', 'b1100000-0000-4000-8000-000000000002', 1, true, current_date - 365, 'b1010000-0000-4000-8000-000000000001');

-- Missing applicable tax mapping is independently fail-closed.
delete from public.accounting_mappings
where mapping_type = 'tax' and source_key = 'purchase_tax';
select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select pg_temp.insert_purchase('b1300000-0000-4000-8000-000000000031', 'PRV2-NO-TAX-MAP', current_date, 100, 15, 0, 0, 'HNL');
select * from public.confirm_purchase_with_payable_v1(
  'b1300000-0000-4000-8000-000000000031', 'credit', current_date + 30,
  0, null, null, null, 'b1200000-0000-4000-8000-000000000031'
);
create temp table _no_tax_map as
select payable.id payable_id, box.id outbox_id
from public.accounts_payable payable
join public.accounting_outbox_v2 box on box.source_id = payable.id
where payable.purchase_id = 'b1300000-0000-4000-8000-000000000031'
  and box.event_purpose = 'accounts_payable_created';
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.process_accounting_outbox_v2((select outbox_id from _no_tax_map), 'pgtap-no-tax-map', false);
select is(public.purchase_accounting_completeness_v2((select payable_id from _no_tax_map)), 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED', 'missing applicable tax mapping is configuration-required');
select is((select journal_entry_id from public.accounting_outbox_v2 where id = (select outbox_id from _no_tax_map)), null::uuid, 'missing tax mapping creates no draft');
select is((select missing_key from public.accounting_outbox_v2 where id = (select outbox_id from _no_tax_map)), 'tax:purchase_tax', 'missing tax mapping reports its sanitized key');
select is((select count(*)::integer from public.inventory_movements where reference_type = 'purchase' and reference_id = 'b1300000-0000-4000-8000-000000000031'), 0, 'missing tax mapping worker changes no inventory');
insert into public.accounting_mappings(mapping_type, source_key, account_id, priority, is_active, effective_from, created_by)
values ('tax', 'purchase_tax', 'b1100000-0000-4000-8000-000000000003', 1, true, current_date - 365, 'b1010000-0000-4000-8000-000000000001');

-- Missing applicable freight mapping is independently fail-closed.
delete from public.accounting_mappings
where mapping_type = 'shipping' and source_key = 'purchase_shipping';
select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select pg_temp.insert_purchase('b1300000-0000-4000-8000-000000000032', 'PRV2-NO-FREIGHT-MAP', current_date, 100, 0, 0, 20, 'HNL');
select * from public.confirm_purchase_with_payable_v1(
  'b1300000-0000-4000-8000-000000000032', 'credit', current_date + 30,
  0, null, null, null, 'b1200000-0000-4000-8000-000000000032'
);
create temp table _no_freight_map as
select payable.id payable_id, box.id outbox_id
from public.accounts_payable payable
join public.accounting_outbox_v2 box on box.source_id = payable.id
where payable.purchase_id = 'b1300000-0000-4000-8000-000000000032'
  and box.event_purpose = 'accounts_payable_created';
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.process_accounting_outbox_v2((select outbox_id from _no_freight_map), 'pgtap-no-freight-map', false);
select is(public.purchase_accounting_completeness_v2((select payable_id from _no_freight_map)), 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED', 'missing applicable freight mapping is configuration-required');
select is((select journal_entry_id from public.accounting_outbox_v2 where id = (select outbox_id from _no_freight_map)), null::uuid, 'missing freight mapping creates no draft');
select is((select missing_key from public.accounting_outbox_v2 where id = (select outbox_id from _no_freight_map)), 'shipping:purchase_shipping', 'missing freight mapping reports its sanitized key');
select is((select count(*)::integer from public.inventory_movements where reference_type = 'purchase' and reference_id = 'b1300000-0000-4000-8000-000000000032'), 0, 'missing freight mapping worker changes no inventory');
insert into public.accounting_mappings(mapping_type, source_key, account_id, priority, is_active, effective_from, created_by)
values ('shipping', 'purchase_shipping', 'b1100000-0000-4000-8000-000000000004', 1, true, current_date - 365, 'b1010000-0000-4000-8000-000000000001');

-- Missing applicable discount mapping is independently fail-closed.
delete from public.accounting_mappings
where mapping_type = 'discount' and source_key = 'purchase_discount';
select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select pg_temp.insert_purchase('b1300000-0000-4000-8000-000000000033', 'PRV2-NO-DISCOUNT-MAP', current_date, 100, 0, 10, 0, 'HNL');
select * from public.confirm_purchase_with_payable_v1(
  'b1300000-0000-4000-8000-000000000033', 'credit', current_date + 30,
  0, null, null, null, 'b1200000-0000-4000-8000-000000000033'
);
create temp table _no_discount_map as
select payable.id payable_id, box.id outbox_id
from public.accounts_payable payable
join public.accounting_outbox_v2 box on box.source_id = payable.id
where payable.purchase_id = 'b1300000-0000-4000-8000-000000000033'
  and box.event_purpose = 'accounts_payable_created';
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.process_accounting_outbox_v2((select outbox_id from _no_discount_map), 'pgtap-no-discount-map', false);
select is(public.purchase_accounting_completeness_v2((select payable_id from _no_discount_map)), 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED', 'missing applicable discount mapping is configuration-required');
select is((select journal_entry_id from public.accounting_outbox_v2 where id = (select outbox_id from _no_discount_map)), null::uuid, 'missing discount mapping creates no draft');
select is((select missing_key from public.accounting_outbox_v2 where id = (select outbox_id from _no_discount_map)), 'discount:purchase_discount', 'missing discount mapping reports its sanitized key');
select is((select count(*)::integer from public.inventory_movements where reference_type = 'purchase' and reference_id = 'b1300000-0000-4000-8000-000000000033'), 0, 'missing discount mapping worker changes no inventory');
insert into public.accounting_mappings(mapping_type, source_key, account_id, priority, is_active, effective_from, created_by)
values ('discount', 'purchase_discount', 'b1100000-0000-4000-8000-000000000005', 1, true, current_date - 365, 'b1010000-0000-4000-8000-000000000001');

-- N: canonical closed period blocks without substituting today's date.
insert into public.accounting_periods(
  id, name, start_date, end_date, status, period_type, fiscal_year, created_by
)
values (
  'b1400000-0000-4000-8000-000000000001', 'PRV2 CLOSED LOCAL',
  current_date - 10, current_date - 9, 'open', 'custom',
  extract(year from current_date)::integer,
  'b1010000-0000-4000-8000-000000000001'
);
update public.accounting_periods
set status = 'closed',
    closed_by = 'b1010000-0000-4000-8000-000000000001',
    closed_at = now()
where id = 'b1400000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select pg_temp.insert_purchase('b1300000-0000-4000-8000-000000000005', 'PRV2-CLOSED', current_date - 10, 100, 0, 0, 0, 'HNL');
select * from public.confirm_purchase_with_payable_v1(
  'b1300000-0000-4000-8000-000000000005', 'credit', current_date + 30,
  0, null, null, null, 'b1200000-0000-4000-8000-000000000006'
);
create temp table _closed_fact as
select payable.id payable_id, box.id outbox_id
from public.accounts_payable payable
join public.accounting_outbox_v2 box on box.source_id = payable.id
where payable.purchase_id = 'b1300000-0000-4000-8000-000000000005'
  and box.event_purpose = 'accounts_payable_created';
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.process_accounting_outbox_v2((select outbox_id from _closed_fact), 'pgtap-closed', false);
select is(
  public.purchase_accounting_completeness_v2((select payable_id from _closed_fact)),
  'PURCHASE_ACCOUNTING_PERIOD_BLOCKED',
  'closed canonical accounting period is blocked'
);
select is(
  (select accounting_date from public.accounting_outbox_v2 where id = (select outbox_id from _closed_fact)),
  current_date - 10,
  'closed-period failure preserves the purchase accounting date'
);

-- O: a line without product/account classification never becomes inventory.
select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select pg_temp.insert_purchase('b1300000-0000-4000-8000-000000000006', 'PRV2-UNKNOWN', current_date, 100, 0, 0, 0, 'HNL', null);
select * from public.confirm_purchase_with_payable_v1(
  'b1300000-0000-4000-8000-000000000006', 'credit', current_date + 30,
  0, null, null, null, 'b1200000-0000-4000-8000-000000000007'
);
create temp table _unknown_fact as
select payable.id payable_id, box.id outbox_id
from public.accounts_payable payable
join public.accounting_outbox_v2 box on box.source_id = payable.id
where payable.purchase_id = 'b1300000-0000-4000-8000-000000000006'
  and box.event_purpose = 'accounts_payable_created';
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.process_accounting_outbox_v2((select outbox_id from _unknown_fact), 'pgtap-unknown', false);
select is(
  public.purchase_accounting_completeness_v2((select payable_id from _unknown_fact)),
  'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED',
  'unknown non-inventory line fails closed for classification'
);
select is(
  (select journal_entry_id from public.accounting_outbox_v2 where id = (select outbox_id from _unknown_fact)),
  null::uuid,
  'unknown line is not silently posted to inventory'
);

-- Classifier precedence: an explicit generic failure is not incomplete, while
-- a valid completed draft wins over stale failure metadata.
update public.accounting_outbox_v2
set status = 'pending_data',
    last_error_code = 'PURCHASE_ACCOUNTING_FAILED',
    last_error_message = 'Fallo tecnico sanitizado de prueba local.'
where id = (select outbox_id from _unknown_fact);
select is(
  public.purchase_accounting_completeness_v2((select payable_id from _unknown_fact)),
  'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED',
  'fresh canonical classification failure takes precedence over stale generic metadata'
);
update public.accounting_outbox_v2
set status = 'pending_data',
    last_error_code = 'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED',
    last_error_message = 'Una o mas lineas no tienen clasificacion contable segura.'
where id = (select outbox_id from _unknown_fact);

update public.accounting_outbox_v2
set last_error_code = 'PURCHASE_ACCOUNTING_FAILED',
    last_error_message = 'Metadato obsoleto local.'
where id = (select outbox_id from _credit_fact);
select is(
  public.purchase_accounting_completeness_v2((select payable_id from _credit_fact)),
  'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT',
  'completed draft is not healthy after its mapping identity changes'
);
update public.accounting_outbox_v2
set last_error_code = null, last_error_message = null
where id = (select outbox_id from _credit_fact);

-- Canonical identity conflicts: the database unique key prevents a workaround
-- row and the transactional validator rejects incompatible routing metadata.
create or replace function pg_temp.insert_canonical_case(
  p_purchase_id uuid,
  p_payable_id uuid,
  p_outbox_id uuid,
  p_feature_key text,
  p_topic text,
  p_scenario text
)
returns void
language plpgsql
as $$
declare
  flag_cutover timestamptz;
begin
  perform pg_temp.insert_purchase(
    p_purchase_id,
    'PRV2-CONFLICT-' || right(p_purchase_id::text, 6),
    current_date, 125, 0, 0, 0, 'HNL'
  );
  insert into public.accounts_payable(
    id, supplier_id, purchase_id, total_amount, paid_amount, due_date,
    status, currency, notes, created_by
  ) values (
    p_payable_id, 'b1000000-0000-4000-8000-000000000001', p_purchase_id,
    125, 0, current_date + 30, 'pending', 'HNL',
    'LOCAL CANONICAL CONFLICT', 'b1010000-0000-4000-8000-000000000001'
  );
  select cutover_at into flag_cutover
  from public.accounting_feature_flags
  where key = 'purchase_recognition_draft_v2';
  insert into public.accounting_outbox_v2(
    id, feature_key, topic, source_type, source_id, event_purpose,
    posting_version, scenario, idempotency_key, occurred_at, cutover_at,
    accounting_date, accounting_date_source, status, next_attempt_at, actor_id
  ) values (
    p_outbox_id, p_feature_key, p_topic, 'accounts_payable', p_payable_id,
    'accounts_payable_created', 'v2', p_scenario,
    'accounts_payable:' || p_payable_id::text || ':accounts_payable_created:v2',
    now(), flag_cutover, current_date,
    'originating_supplier_document_date', 'queued', now(),
    'b1010000-0000-4000-8000-000000000001'
  );
end;
$$;

select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);

select pg_temp.insert_canonical_case(
  'b1300000-0000-4000-8000-000000000040',
  'b1500000-0000-4000-8000-000000000040',
  'b1700000-0000-4000-8000-000000000040',
  'sales_draft_v2', 'payables.purchase_recognition', 'purchase_inventory_v2'
);
select throws_ok(
  $$select * from public.confirm_purchase_with_payable_v1(
    'b1300000-0000-4000-8000-000000000040','credit',current_date + 30,
    0,null,null,null,'b1200000-0000-4000-8000-000000000040')$$,
  'PT409', 'PURCHASE_ACCOUNTING_CANONICAL_CONFLICT',
  'wrong canonical feature key fails closed'
);

select pg_temp.insert_canonical_case(
  'b1300000-0000-4000-8000-000000000041',
  'b1500000-0000-4000-8000-000000000041',
  'b1700000-0000-4000-8000-000000000041',
  'purchase_recognition_draft_v2', 'payables.wrong_pipeline', 'purchase_inventory_v2'
);
select throws_ok(
  $$select * from public.confirm_purchase_with_payable_v1(
    'b1300000-0000-4000-8000-000000000041','credit',current_date + 30,
    0,null,null,null,'b1200000-0000-4000-8000-000000000041')$$,
  'PT409', 'PURCHASE_ACCOUNTING_CANONICAL_CONFLICT',
  'wrong canonical topic fails closed'
);

select pg_temp.insert_canonical_case(
  'b1300000-0000-4000-8000-000000000042',
  'b1500000-0000-4000-8000-000000000042',
  'b1700000-0000-4000-8000-000000000042',
  'purchase_recognition_draft_v2', 'payables.purchase_recognition', 'wrong_purchase_scenario'
);
select throws_ok(
  $$select * from public.confirm_purchase_with_payable_v1(
    'b1300000-0000-4000-8000-000000000042','credit',current_date + 30,
    0,null,null,null,'b1200000-0000-4000-8000-000000000042')$$,
  'PT409', 'PURCHASE_ACCOUNTING_CANONICAL_CONFLICT',
  'wrong canonical scenario fails closed'
);

select pg_temp.insert_canonical_case(
  'b1300000-0000-4000-8000-000000000043',
  'b1500000-0000-4000-8000-000000000043',
  'b1700000-0000-4000-8000-000000000043',
  'sales_draft_v2', 'payables.wrong_pipeline', 'wrong_purchase_scenario'
);
select throws_ok(
  $$select * from public.confirm_purchase_with_payable_v1(
    'b1300000-0000-4000-8000-000000000043','credit',current_date + 30,
    0,null,null,null,'b1200000-0000-4000-8000-000000000043')$$,
  'PT409', 'PURCHASE_ACCOUNTING_CANONICAL_CONFLICT',
  'combined canonical routing conflicts fail closed'
);

select is(
  (select count(*)::integer from public.purchases
   where id in (
     'b1300000-0000-4000-8000-000000000040',
     'b1300000-0000-4000-8000-000000000041',
     'b1300000-0000-4000-8000-000000000042',
     'b1300000-0000-4000-8000-000000000043'
   ) and status = 'draft' and accounting_recognition_version is null),
  4,
  'canonical conflicts atomically roll purchase confirmation and scope back'
);
select is(
  (select count(*)::integer from public.accounts_payable
   where id in (
     'b1500000-0000-4000-8000-000000000040',
     'b1500000-0000-4000-8000-000000000041',
     'b1500000-0000-4000-8000-000000000042',
     'b1500000-0000-4000-8000-000000000043'
   ) and automation_source is null and accounting_recognition_version is null),
  4,
  'canonical conflicts atomically roll payable adoption and scope back'
);
select is(
  (select count(*)::integer from public.accounting_outbox_v2
   where id in (
     'b1700000-0000-4000-8000-000000000040',
     'b1700000-0000-4000-8000-000000000041',
     'b1700000-0000-4000-8000-000000000042',
     'b1700000-0000-4000-8000-000000000043'
   )),
  4,
  'canonical conflicts create no duplicate workaround outbox'
);
select is(
  (select count(*)::integer from public.financial_events
   where source_type = 'accounts_payable'
     and source_id in (
       'b1500000-0000-4000-8000-000000000040',
       'b1500000-0000-4000-8000-000000000041',
       'b1500000-0000-4000-8000-000000000042',
       'b1500000-0000-4000-8000-000000000043'
     )),
  0,
  'canonical conflict rollback persists no false-success financial event'
);

select pg_temp.insert_canonical_case(
  'b1300000-0000-4000-8000-000000000044',
  'b1500000-0000-4000-8000-000000000044',
  'b1700000-0000-4000-8000-000000000044',
  'purchase_recognition_draft_v2', 'payables.purchase_recognition', 'purchase_inventory_v2'
);
select lives_ok(
  $$select * from public.confirm_purchase_with_payable_v1(
    'b1300000-0000-4000-8000-000000000044','credit',current_date + 30,
    0,null,null,null,'b1200000-0000-4000-8000-000000000044')$$,
  'exact matching canonical obligation is safely reused'
);
select is(
  (select count(*)::integer from public.accounting_outbox_v2
   where source_type = 'accounts_payable'
     and source_id = 'b1500000-0000-4000-8000-000000000044'
     and event_purpose = 'accounts_payable_created'
     and posting_version = 'v2'),
  1,
  'matching canonical reuse retains one obligation'
);
select is(
  public.require_purchase_recognition_outbox_v2(
    'b1500000-0000-4000-8000-000000000044',
    'b1700000-0000-4000-8000-000000000044'
  ),
  'b1700000-0000-4000-8000-000000000044'::uuid,
  'transactional validator returns the exact canonical outbox'
);

create temporary table _canonical_worker_conflicts as
select conflict.id as outbox_id,
  public.process_accounting_outbox_v2(
    conflict.id,
    'purchase-recognition-conflict-test',
    true
  ) as result
from (values
  ('b1700000-0000-4000-8000-000000000040'::uuid),
  ('b1700000-0000-4000-8000-000000000041'::uuid),
  ('b1700000-0000-4000-8000-000000000042'::uuid),
  ('b1700000-0000-4000-8000-000000000043'::uuid)
) as conflict(id);

select is(
  (select count(*)::integer from _canonical_worker_conflicts
   where result->>'error_code' = 'PURCHASE_ACCOUNTING_CANONICAL_CONFLICT'
     and result->>'ok' = 'false'),
  4,
  'generic worker dispatch fails every conflicting canonical route closed'
);
select is(
  (select count(*)::integer from public.accounting_outbox_v2
   where id in (select outbox_id from _canonical_worker_conflicts)
     and status = 'failed'
     and last_error_code = 'PURCHASE_ACCOUNTING_CANONICAL_CONFLICT'),
  4,
  'specialized worker persists sanitized canonical conflict state'
);
select is(
  (select count(*)::integer from public.financial_events
   where source_type = 'accounts_payable'
     and source_id in (
       select box.source_id::text
       from public.accounting_outbox_v2 box
       where box.id in (select outbox_id from _canonical_worker_conflicts)
     )),
  0,
  'conflicting worker replay creates no purchase financial event'
);
select is(
  (select count(*)::integer from public.journal_entries entry
   where entry.source_type = 'financial_event'
     and entry.source_id in (
       select event.id::text
       from public.financial_events event
       where event.source_type = 'accounts_payable'
         and event.source_id in (
           select box.source_id::text
           from public.accounting_outbox_v2 box
           where box.id in (select outbox_id from _canonical_worker_conflicts)
         )
     )),
  0,
  'conflicting worker replay creates and publishes no journal'
);

-- A V1 draft that predates enrollment is preserved as evidence and makes V2
-- fail closed instead of producing a competing recognition.
update public.accounting_feature_flags
set state = 'disabled', cutover_at = null
where key = 'purchase_recognition_draft_v2';
select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select pg_temp.insert_purchase(
  'b1300000-0000-4000-8000-000000000060',
  'PRV2-LEGACY-CONFLICT', current_date, 125, 0, 0, 0, 'HNL'
);
select * from public.confirm_purchase_with_payable_v1(
  'b1300000-0000-4000-8000-000000000060', 'credit', current_date + 30,
  0, null, null, null, 'b1200000-0000-4000-8000-000000000060'
);
create temp table _legacy_conflict as
select payable.id payable_id, event.id legacy_event_id
from public.accounts_payable payable
join public.financial_events event
  on event.source_type = 'accounts_payable'
 and event.source_id = payable.id::text
 and event.event_purpose = 'accounts_payable_created'
 and event.posting_version = 'v1'
where payable.purchase_id = 'b1300000-0000-4000-8000-000000000060';
insert into public.journal_entries(
  id, entry_number, entry_date, description, status,
  source_type, source_id, created_by
) values (
  'b1800000-0000-4000-8000-000000000060',
  'PRV2-LEGACY-60', current_date, 'Synthetic competing V1 evidence', 'borrador',
  'financial_event', (select legacy_event_id::text from _legacy_conflict),
  'b1010000-0000-4000-8000-000000000001'
);
insert into public.journal_entry_lines(
  journal_entry_id, account_id, debit, credit, description, vendor_id
) values
  ('b1800000-0000-4000-8000-000000000060', 'b1100000-0000-4000-8000-000000000001', 125, 0, 'Legacy inventory', 'b1000000-0000-4000-8000-000000000001'),
  ('b1800000-0000-4000-8000-000000000060', 'b1100000-0000-4000-8000-000000000002', 0, 125, 'Legacy AP', 'b1000000-0000-4000-8000-000000000001');
update public.financial_events
set status = 'draft_created',
    journal_entry_id = 'b1800000-0000-4000-8000-000000000060'
where id = (select legacy_event_id from _legacy_conflict);
update public.accounting_feature_flags
set state = 'enabled',
    cutover_at = now() - interval '1 minute',
    updated_by = 'b1010000-0000-4000-8000-000000000001'
where key = 'purchase_recognition_draft_v2';
update public.purchases
set accounting_recognition_version = 'v2'
where id = 'b1300000-0000-4000-8000-000000000060';
update public.accounts_payable
set accounting_recognition_version = 'v2'
where id = (select payable_id from _legacy_conflict);
alter table _legacy_conflict add column outbox_id uuid;
update _legacy_conflict
set outbox_id = public.route_purchase_recognition_accounting_v2(
  payable_id, 'b1010000-0000-4000-8000-000000000001'
);
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select is(
  (public.process_accounting_outbox_v2(
    (select outbox_id from _legacy_conflict), 'pgtap-legacy-conflict', true
  )->>'error_code'),
  'PURCHASE_ACCOUNTING_LEGACY_CONFLICT',
  'V2 worker fails closed when a competing V1 draft predates enrollment'
);
select is(
  public.purchase_accounting_completeness_v2(
    (select payable_id from _legacy_conflict)
  ),
  'PURCHASE_ACCOUNTING_LEGACY_CONFLICT',
  'completeness exposes the deterministic legacy conflict state'
);
select is(
  (select count(*)::integer from public.financial_events event
   where event.source_type = 'accounts_payable'
     and event.source_id = (select payable_id::text from _legacy_conflict)
     and event.posting_version = 'v2'),
  0,
  'legacy conflict creates no V2 financial event workaround'
);

-- Fresh rich chain used for adversarial snapshot and journal equivalence tests.
select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select pg_temp.insert_purchase(
  'b1300000-0000-4000-8000-000000000061',
  'PRV2-INTEGRITY', current_date, 100, 15, 10, 20, 'HNL'
);
select * from public.confirm_purchase_with_payable_v1(
  'b1300000-0000-4000-8000-000000000061', 'credit', current_date + 30,
  0, null, null, null, 'b1200000-0000-4000-8000-000000000061'
);
create temp table _integrity_fact as
select payable.id payable_id, box.id outbox_id
from public.accounts_payable payable
join public.accounting_outbox_v2 box on box.source_id = payable.id
where payable.purchase_id = 'b1300000-0000-4000-8000-000000000061'
  and box.event_purpose = 'accounts_payable_created'
  and box.posting_version = 'v2';
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.process_accounting_outbox_v2(
  (select outbox_id from _integrity_fact), 'pgtap-integrity-create', false
);
alter table _integrity_fact add column event_id uuid;
alter table _integrity_fact add column entry_id uuid;
update _integrity_fact fact
set event_id = box.financial_event_id,
    entry_id = box.journal_entry_id
from public.accounting_outbox_v2 box
where box.id = fact.outbox_id;
create temp table _integrity_event_original as
select id, source_snapshot
from public.financial_events
where id = (select event_id from _integrity_fact);
create temp table _integrity_lines_original as
select * from public.journal_entry_lines
where journal_entry_id = (select entry_id from _integrity_fact);

create or replace function pg_temp.restore_integrity_event()
returns void language sql as $$
  update public.financial_events event
  set source_snapshot = original.source_snapshot
  from _integrity_event_original original
  where event.id = original.id;
  update public.accounting_outbox_v2
  set status = 'completed', last_error_code = null,
      last_error_message = null, missing_key = null,
      lease_until = null, locked_by = null
  where id = (select outbox_id from _integrity_fact);
$$;
create or replace function pg_temp.restore_integrity_lines()
returns void language plpgsql as $$
begin
  delete from public.journal_entry_lines
  where journal_entry_id = (select entry_id from _integrity_fact);
  insert into public.journal_entry_lines(
    id, journal_entry_id, account_id, debit, credit, description,
    customer_id, vendor_id, product_id, created_at
  )
  select id, journal_entry_id, account_id, debit, credit, description,
    customer_id, vendor_id, product_id, created_at
  from _integrity_lines_original;
  update public.accounting_outbox_v2
  set status = 'completed', last_error_code = null,
      last_error_message = null, missing_key = null,
      lease_until = null, locked_by = null
  where id = (select outbox_id from _integrity_fact);
end;
$$;

alter table public.financial_events
  disable trigger zz_financial_events_apply_canonical_accounting_date_v1;
update public.financial_events set source_snapshot = jsonb_set(source_snapshot, '{accounting_date}', to_jsonb((current_date - 1)::text)) where id = (select event_id from _integrity_fact);
alter table public.financial_events
  enable trigger zz_financial_events_apply_canonical_accounting_date_v1;
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT', 'wrong canonical date fails closed');
select pg_temp.restore_integrity_event();
update public.financial_events set source_snapshot = jsonb_set(source_snapshot, '{subtotal}', '100.01'::jsonb) where id = (select event_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT', 'wrong subtotal fails closed');
select pg_temp.restore_integrity_event();
update public.financial_events set source_snapshot = jsonb_set(source_snapshot, '{tax_amount}', '15.01'::jsonb) where id = (select event_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT', 'wrong tax snapshot fails closed');
select pg_temp.restore_integrity_event();
update public.financial_events set source_snapshot = jsonb_set(source_snapshot, '{shipping_amount}', '20.01'::jsonb) where id = (select event_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT', 'wrong freight snapshot fails closed');
select pg_temp.restore_integrity_event();
update public.financial_events set source_snapshot = jsonb_set(source_snapshot, '{discount_amount}', '10.01'::jsonb) where id = (select event_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT', 'wrong discount snapshot fails closed');
select pg_temp.restore_integrity_event();
update public.financial_events set source_snapshot = jsonb_set(source_snapshot, '{total_amount}', '125.01'::jsonb) where id = (select event_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT', 'wrong AP total snapshot fails closed');
select pg_temp.restore_integrity_event();
update public.financial_events set source_snapshot = jsonb_set(source_snapshot, '{currency}', '"USD"'::jsonb) where id = (select event_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT', 'wrong currency snapshot fails closed');
select pg_temp.restore_integrity_event();
update public.financial_events set source_snapshot = jsonb_set(source_snapshot, '{snapshot_version}', '"wrong_snapshot"'::jsonb) where id = (select event_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT', 'wrong snapshot version fails closed');
select pg_temp.restore_integrity_event();
update public.financial_events set source_snapshot = jsonb_set(source_snapshot, '{accounting_mapping_snapshot,inventory,mapping_id}', '"b1900000-0000-4000-8000-000000000099"'::jsonb) where id = (select event_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT', 'wrong account mapping identity fails closed');
select is(
  (public.process_accounting_outbox_v2((select outbox_id from _integrity_fact), 'pgtap-snapshot-conflict', true)->>'error_code'),
  'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT',
  'worker retry persists snapshot conflict instead of overwriting evidence'
);
select pg_temp.restore_integrity_event();

update public.journal_entry_lines set debit = debit + 0.01 where journal_entry_id = (select entry_id from _integrity_fact) and description like 'Inventario%';
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT', 'wrong inventory debit fails closed');
select pg_temp.restore_integrity_lines();
update public.journal_entry_lines set debit = debit + 0.01 where journal_entry_id = (select entry_id from _integrity_fact) and description = 'Impuesto recuperable de compra';
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT', 'wrong tax journal line fails closed');
select pg_temp.restore_integrity_lines();
update public.journal_entry_lines set debit = debit + 0.01 where journal_entry_id = (select entry_id from _integrity_fact) and description = 'Flete de compra';
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT', 'wrong freight journal line fails closed');
select pg_temp.restore_integrity_lines();
update public.journal_entry_lines set credit = credit + 0.01 where journal_entry_id = (select entry_id from _integrity_fact) and description = 'Descuento de compra';
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT', 'wrong discount journal line fails closed');
select pg_temp.restore_integrity_lines();
update public.journal_entry_lines set credit = credit + 0.01 where journal_entry_id = (select entry_id from _integrity_fact) and description like 'Cuenta por pagar%';
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT', 'wrong AP credit fails closed');
select pg_temp.restore_integrity_lines();
update public.journal_entry_lines set account_id = 'b1100000-0000-4000-8000-000000000002' where journal_entry_id = (select entry_id from _integrity_fact) and description like 'Inventario%';
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT', 'wrong journal account fails closed');
select pg_temp.restore_integrity_lines();
update public.journal_entry_lines set debit = 0, credit = 100 where journal_entry_id = (select entry_id from _integrity_fact) and description like 'Inventario%';
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT', 'wrong debit credit direction fails closed');
select pg_temp.restore_integrity_lines();
insert into public.journal_entry_lines(journal_entry_id, account_id, debit, credit, description, vendor_id) values ((select entry_id from _integrity_fact), 'b1100000-0000-4000-8000-000000000001', 0.01, 0, 'Unexpected extra line', 'b1000000-0000-4000-8000-000000000001');
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT', 'extra journal line fails closed');
select is(
  (public.process_accounting_outbox_v2((select outbox_id from _integrity_fact), 'pgtap-journal-conflict', true)->>'error_code'),
  'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT',
  'worker retry persists journal conflict instead of regenerating around it'
);
select pg_temp.restore_integrity_lines();
delete from public.journal_entry_lines where id = (select id from _integrity_lines_original order by description limit 1);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT', 'missing journal line fails closed');
select pg_temp.restore_integrity_lines();
update public.journal_entry_lines line
set created_at = now() + (case when line.debit > 0 then interval '2 hours' else interval '-2 hours' end)
where journal_entry_id = (select entry_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_DRAFTED', 'order-only journal line difference remains economically equivalent');
select pg_temp.restore_integrity_lines();
create temp table _integrity_before_retry as
select (select count(*) from public.financial_events event where event.source_type='accounts_payable' and event.source_id=(select payable_id::text from _integrity_fact) and event.posting_version='v2') event_count,
       (select count(*) from public.journal_entries entry where entry.id=(select entry_id from _integrity_fact)) entry_count;
select is(
  (public.process_accounting_outbox_v2((select outbox_id from _integrity_fact), 'pgtap-exact-retry', true)->>'reason'),
  'existing_exact_chain_reused',
  'exact existing V2 chain is idempotently reused'
);
select is(
  (select jsonb_build_array(event_count, entry_count) from _integrity_before_retry),
  (select jsonb_build_array(
    (select count(*) from public.financial_events event where event.source_type='accounts_payable' and event.source_id=(select payable_id::text from _integrity_fact) and event.posting_version='v2'),
    (select count(*) from public.journal_entries entry where entry.id=(select entry_id from _integrity_fact))
  )),
  'exact retry creates no second economic recognition chain'
);

-- P/Q/R: historical isolation, explicit completeness, and payment gate.
insert into public.purchases(
  id, supplier_id, purchase_number, purchase_date, status, confirmed_at,
  subtotal, tax_amount, discount_amount, shipping_amount, total, currency,
  notes, created_by
)
values (
  'b1300000-0000-4000-8000-000000000007',
  'b1000000-0000-4000-8000-000000000001',
  'PRV2-HISTORICAL', current_date - 30, 'confirmed', now() - interval '30 days',
  100, 0, 0, 0, 100, 'HNL', 'LOCAL SYNTHETIC HISTORICAL',
  'b1010000-0000-4000-8000-000000000001'
);
insert into public.accounts_payable(
  id, supplier_id, purchase_id, total_amount, paid_amount, due_date,
  status, currency, notes, created_by, automation_source
)
values (
  'b1500000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001',
  'b1300000-0000-4000-8000-000000000007',
  100, 0, current_date, 'pending', 'HNL', 'LOCAL SYNTHETIC HISTORICAL',
  'b1010000-0000-4000-8000-000000000001', 'purchase_confirmation_v1'
);
select is(
  public.route_purchase_recognition_accounting_v2(
    'b1500000-0000-4000-8000-000000000001',
    'b1010000-0000-4000-8000-000000000001'
  ),
  null::uuid,
  'unstamped historical AP is never implicitly routed'
);
select is(
  public.purchase_accounting_completeness_v2('b1500000-0000-4000-8000-000000000001'),
  'PURCHASE_ACCOUNTING_NOT_REQUIRED',
  'historical AP remains outside the prospective completeness gate'
);

insert into public.purchases(
  id, supplier_id, purchase_number, purchase_date, status, confirmed_at,
  subtotal, tax_amount, discount_amount, shipping_amount, total, currency,
  notes, created_by, accounting_recognition_version
)
values (
  'b1300000-0000-4000-8000-000000000008',
  'b1000000-0000-4000-8000-000000000001',
  'PRV2-INCOMPLETE', current_date, 'confirmed', now(),
  100, 0, 0, 0, 100, 'HNL', 'LOCAL SYNTHETIC INCOMPLETE',
  'b1010000-0000-4000-8000-000000000001', 'v2'
);
insert into public.accounts_payable(
  id, supplier_id, purchase_id, total_amount, paid_amount, due_date,
  status, currency, notes, created_by, automation_source,
  accounting_recognition_version
)
values (
  'b1500000-0000-4000-8000-000000000002',
  'b1000000-0000-4000-8000-000000000001',
  'b1300000-0000-4000-8000-000000000008',
  100, 0, current_date + 30, 'pending', 'HNL', 'LOCAL SYNTHETIC INCOMPLETE',
  'b1010000-0000-4000-8000-000000000001', 'purchase_confirmation_v1', 'v2'
);
select is(
  public.purchase_accounting_completeness_v2('b1500000-0000-4000-8000-000000000002'),
  'ACCOUNTING_INCOMPLETE',
  'new-scope AP without an obligation is deterministically incomplete'
);

select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);
create temp table _blocked_payment as
select * from public.register_supplier_payment_v2(
  'b1500000-0000-4000-8000-000000000002',
  25, 'cash', current_date, 'LOCAL SYNTHETIC', 'prv2-incomplete-payment'
);
select is(
  (select count(*)::integer from public.accounting_outbox_v2
   where source_type = 'supplier_payment'
     and source_id = (select payment_id from _blocked_payment)),
  0,
  'new-scope payment cannot route a misleading standalone settlement obligation'
);

-- Multi-invoice dependency: a new-scope application without a canonical
-- recognition obligation cannot route, while an all-historical allocation
-- retains the existing routing contract.
insert into public.supplier_payments(
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at, created_by, allocation_mode,
  currency, payment_account_id, idempotency_key
)
values (
  'b1800000-0000-4000-8000-000000000001', null,
  'b1000000-0000-4000-8000-000000000001', 20, 'cash', 'cash',
  'paid', now(), 'b1010000-0000-4000-8000-000000000001',
  'applications_v1', 'HNL', 'b1100000-0000-4000-8000-000000000006',
  'prv2-multi-missing-obligation'
);
insert into public.supplier_payment_applications(
  supplier_payment_id, accounts_payable_id, applied_amount, currency,
  balance_before, balance_after, status_before, status_after,
  recognition_origin, recognition_journal_entry_id, recognition_date
)
values
  (
    'b1800000-0000-4000-8000-000000000001',
    'b1500000-0000-4000-8000-000000000002', 10, 'HNL',
    100, 90, 'pending', 'partial', 'direct_event',
    (select journal_entry_id from public.accounting_outbox_v2 where id = (select outbox_id from _credit_fact)),
    current_date
  ),
  (
    'b1800000-0000-4000-8000-000000000001',
    'b1500000-0000-4000-8000-000000000001', 10, 'HNL',
    100, 90, 'pending', 'partial', 'direct_event',
    (select journal_entry_id from public.accounting_outbox_v2 where id = (select outbox_id from _credit_fact)),
    current_date
  );
select is(
  public.route_supplier_payment_accounting_v2(
    'b1800000-0000-4000-8000-000000000001',
    'b1010000-0000-4000-8000-000000000001'
  ),
  null::uuid,
  'multi-invoice payment with a missing new-scope obligation is not routed'
);
select is(
  (select count(*)::integer from public.accounting_outbox_v2
   where source_type = 'supplier_payment'
     and source_id = 'b1800000-0000-4000-8000-000000000001'),
  0,
  'missing new-scope multi dependency creates no standalone settlement outbox'
);

update public.purchases
set accounting_recognition_version = 'v2'
where id = 'b1300000-0000-4000-8000-000000000040';
update public.accounts_payable
set automation_source = 'purchase_confirmation_v1',
    accounting_recognition_version = 'v2'
where id = 'b1500000-0000-4000-8000-000000000040';
insert into public.supplier_payments(
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at, created_by, allocation_mode,
  currency, payment_account_id, idempotency_key
)
values (
  'b1800000-0000-4000-8000-000000000002', null,
  'b1000000-0000-4000-8000-000000000001', 20, 'cash', 'cash',
  'paid', now(), 'b1010000-0000-4000-8000-000000000001',
  'applications_v1', 'HNL', 'b1100000-0000-4000-8000-000000000006',
  'prv2-multi-conflicting-obligation'
);
insert into public.supplier_payment_applications(
  supplier_payment_id, accounts_payable_id, applied_amount, currency,
  balance_before, balance_after, status_before, status_after,
  recognition_origin, recognition_journal_entry_id, recognition_date
)
values
  (
    'b1800000-0000-4000-8000-000000000002',
    'b1500000-0000-4000-8000-000000000040', 10, 'HNL',
    125, 115, 'pending', 'partial', 'direct_event',
    (select journal_entry_id from public.accounting_outbox_v2 where id = (select outbox_id from _credit_fact)),
    current_date
  ),
  (
    'b1800000-0000-4000-8000-000000000002',
    'b1500000-0000-4000-8000-000000000001', 10, 'HNL',
    100, 90, 'pending', 'partial', 'direct_event',
    (select journal_entry_id from public.accounting_outbox_v2 where id = (select outbox_id from _credit_fact)),
    current_date
  );
select is(
  public.route_supplier_payment_accounting_v2(
    'b1800000-0000-4000-8000-000000000002',
    'b1010000-0000-4000-8000-000000000001'
  ),
  null::uuid,
  'multi-invoice payment with a conflicting new-scope obligation is not routed'
);

insert into public.supplier_payments(
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at, created_by, allocation_mode,
  currency, payment_account_id, idempotency_key
)
values (
  'b1800000-0000-4000-8000-000000000003', null,
  'b1000000-0000-4000-8000-000000000001', 10, 'cash', 'cash',
  'paid', now(), 'b1010000-0000-4000-8000-000000000001',
  'applications_v1', 'HNL', 'b1100000-0000-4000-8000-000000000006',
  'prv2-multi-historical-compatible'
);
insert into public.supplier_payment_applications(
  supplier_payment_id, accounts_payable_id, applied_amount, currency,
  balance_before, balance_after, status_before, status_after,
  recognition_origin, recognition_journal_entry_id, recognition_date
)
values (
  'b1800000-0000-4000-8000-000000000003',
  'b1500000-0000-4000-8000-000000000001', 10, 'HNL',
  100, 90, 'pending', 'partial', 'direct_event',
  (select journal_entry_id from public.accounting_outbox_v2 where id = (select outbox_id from _credit_fact)),
  current_date
);
select ok(
  public.route_supplier_payment_accounting_v2(
    'b1800000-0000-4000-8000-000000000003',
    'b1010000-0000-4000-8000-000000000001'
  ) is not null,
  'all-historical multi-invoice payment retains backward-compatible routing'
);

update public.accounting_feature_flags
set cutover_at = current_date - interval '1 day'
where key = 'supplier_payment_draft_v2';

create temp table _historical_payment as
select * from public.register_supplier_payment_v2(
  'b1500000-0000-4000-8000-000000000001',
  25, 'cash', current_date, 'LOCAL SYNTHETIC', 'prv2-historical-payment'
);
select is(
  (select count(*)::integer from public.accounting_outbox_v2
   where source_type = 'supplier_payment'
     and source_id = (select payment_id from _historical_payment)),
  1,
  'historical out-of-scope AP retains backward-compatible payment routing'
);

-- Final integrity gate: real exact-chain state, canonical-date, replay and
-- payment dependency matrices.  All mutations are local and rolled back.
insert into public.supplier_payments(
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at, created_by, allocation_mode,
  currency, payment_account_id, idempotency_key
)
values (
  'b1800000-0000-4000-8000-000000000010',
  (select payable_id from _integrity_fact),
  'b1000000-0000-4000-8000-000000000001', 1, 'cash', 'cash',
  'paid', now(), 'b1010000-0000-4000-8000-000000000001',
  'legacy_single', 'HNL', 'b1100000-0000-4000-8000-000000000006',
  'prv2-integrity-dependency'
);

create temp table _integrity_outbox_original as
select status, last_error_code, last_error_message, missing_key, cancelled_at,
  lease_until, locked_by, accounting_date, accounting_date_source,
  financial_event_id, journal_entry_id
from public.accounting_outbox_v2
where id = (select outbox_id from _integrity_fact);
create temp table _integrity_event_state_original as
select status, accounting_date, source_snapshot, created_at
from public.financial_events
where id = (select event_id from _integrity_fact);
create temp table _integrity_entry_state_original as
select entry_date, created_at
from public.journal_entries
where id = (select entry_id from _integrity_fact);

create or replace function pg_temp.restore_integrity_gate()
returns void language plpgsql as $$
begin
  update public.accounting_outbox_v2 box
  set status = original.status,
      last_error_code = original.last_error_code,
      last_error_message = original.last_error_message,
      missing_key = original.missing_key,
      cancelled_at = original.cancelled_at,
      lease_until = original.lease_until,
      locked_by = original.locked_by,
      accounting_date = original.accounting_date,
      accounting_date_source = original.accounting_date_source,
      financial_event_id = original.financial_event_id,
      journal_entry_id = original.journal_entry_id
  from _integrity_outbox_original original
  where box.id = (select outbox_id from _integrity_fact);
  update public.financial_events event
  set status = original.status,
      accounting_date = original.accounting_date,
      source_snapshot = original.source_snapshot,
      created_at = original.created_at
  from _integrity_event_state_original original
  where event.id = (select event_id from _integrity_fact);
  update public.journal_entries entry
  set entry_date = original.entry_date,
      created_at = original.created_at
  from _integrity_entry_state_original original
  where entry.id = (select entry_id from _integrity_fact);
end;
$$;

select is(
  public.purchase_recognition_validity_v2((select payable_id from _integrity_fact)),
  'PURCHASE_ACCOUNTING_DRAFTED',
  'exact completed chain is healthy through the canonical validity gate'
);
select is(
  public.supplier_payment_purchase_dependency_v2('b1800000-0000-4000-8000-000000000010'),
  'PURCHASE_ACCOUNTING_DRAFTED',
  'payment dependency accepts an exact healthy recognition chain'
);

update public.accounting_outbox_v2
set status = 'queued', last_error_code = null, last_error_message = null,
    cancelled_at = null, lease_until = null, locked_by = null
where id = (select outbox_id from _integrity_fact);
select is(
  public.purchase_recognition_validity_v2((select payable_id from _integrity_fact)),
  'PURCHASE_ACCOUNTING_RETRYABLE',
  'exact chain in an eligible recovery state is retryable rather than healthy'
);
select is(
  public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)),
  'PURCHASE_ACCOUNTING_PENDING',
  'retryable exact chain remains pending for completeness'
);
select is(
  public.supplier_payment_purchase_dependency_v2('b1800000-0000-4000-8000-000000000010'),
  'PURCHASE_ACCOUNTING_DEPENDENCY_PENDING',
  'payment dependency rejects retryable recognition until worker reconciliation'
);
select is(
  (public.process_accounting_outbox_v2(
    (select outbox_id from _integrity_fact), 'pgtap-retryable-exact', true
  )->>'reason'),
  'existing_exact_chain_reused',
  'explicit worker retry safely reconciles an eligible exact chain'
);
select pg_temp.restore_integrity_gate();

update public.accounting_outbox_v2
set status = 'failed', last_error_code = 'PURCHASE_ACCOUNTING_FAILED',
    last_error_message = 'Fallo generico local.', lease_until = null,
    locked_by = null
where id = (select outbox_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_FAILED', 'exact journal plus failed outbox is not healthy');
select is(public.supplier_payment_purchase_dependency_v2('b1800000-0000-4000-8000-000000000010'), 'PURCHASE_ACCOUNTING_DEPENDENCY_PENDING', 'failed exact recognition blocks payment accounting dependency');
select is(
  (public.process_accounting_outbox_v2(
    (select outbox_id from _integrity_fact), 'pgtap-failed-exact', true
  )->>'reason'),
  'failed_chain_requires_reconciliation',
  'failed exact chain is not idempotently reused as success'
);
select pg_temp.restore_integrity_gate();

update public.accounting_outbox_v2
set status = 'cancelled', last_error_code = null, cancelled_at = now(),
    lease_until = null, locked_by = null
where id = (select outbox_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_FAILED', 'exact journal plus cancelled outbox is not healthy');
select is(public.supplier_payment_purchase_dependency_v2('b1800000-0000-4000-8000-000000000010'), 'PURCHASE_ACCOUNTING_DEPENDENCY_PENDING', 'cancelled exact recognition blocks payment accounting dependency');
select is(
  (public.process_accounting_outbox_v2(
    (select outbox_id from _integrity_fact), 'pgtap-cancelled-exact', true
  )->>'error_code'),
  'PURCHASE_ACCOUNTING_FAILED',
  'cancelled exact chain is not reused by replay'
);
select pg_temp.restore_integrity_gate();

update public.accounting_outbox_v2
set last_error_code = 'PURCHASE_ACCOUNTING_FAILED',
    last_error_message = 'Metadato de fallo explicito local.'
where id = (select outbox_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_FAILED', 'generic failure code overrides an otherwise exact completed chain');
select pg_temp.restore_integrity_gate();

update public.financial_events
set status = 'failed'
where id = (select event_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_FAILED', 'failed financial event cannot be hidden by an exact journal');
alter table public.financial_events
  disable trigger zz_financial_events_apply_canonical_accounting_date_v1;
update public.financial_events
set source_snapshot = jsonb_set(source_snapshot, '{subtotal}', '100.01'::jsonb)
where id = (select event_id from _integrity_fact);
alter table public.financial_events
  enable trigger zz_financial_events_apply_canonical_accounting_date_v1;
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT', 'snapshot conflict takes precedence over simultaneous failed event state');
select pg_temp.restore_integrity_event();
update public.journal_entry_lines
set debit = debit + 0.01
where journal_entry_id = (select entry_id from _integrity_fact)
  and description like 'Inventario%';
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT', 'journal conflict takes precedence over simultaneous failed event state');
select pg_temp.restore_integrity_lines();
select pg_temp.restore_integrity_gate();

update public.accounting_outbox_v2
set status = 'pending_mapping',
    last_error_code = 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED',
    last_error_message = 'Configuracion local.', lease_until = null,
    locked_by = null
where id = (select outbox_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_CONFIGURATION_REQUIRED', 'configuration block takes deterministic precedence over an exact journal');
select pg_temp.restore_integrity_gate();

update public.accounting_outbox_v2
set status = 'pending_data',
    last_error_code = 'PURCHASE_ACCOUNTING_PERIOD_BLOCKED',
    last_error_message = 'Periodo local.', lease_until = null,
    locked_by = null
where id = (select outbox_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_PERIOD_BLOCKED', 'period block takes deterministic precedence over an exact journal');
select pg_temp.restore_integrity_gate();

update public.accounting_outbox_v2
set status = 'pending_data',
    last_error_code = 'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED',
    last_error_message = 'Clasificacion local.', lease_until = null,
    locked_by = null
where id = (select outbox_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_CLASSIFICATION_REQUIRED', 'classification block takes deterministic precedence over an exact journal');
select pg_temp.restore_integrity_gate();

update public.accounting_outbox_v2
set status = 'shadow_validated', last_error_code = null,
    last_error_message = null, lease_until = null, locked_by = null
where id = (select outbox_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_FAILED', 'unsupported operational state fails closed instead of masquerading as a missing obligation');
select pg_temp.restore_integrity_gate();

-- Canonical date is recalculated from date-only trusted business columns.
select is(
  (select data_type from information_schema.columns
   where table_schema = 'public' and table_name = 'purchases'
     and column_name = 'purchase_date'),
  'date',
  'purchase canonical date is stored as a date-only value'
);
select is(
  (select data_type from information_schema.columns
   where table_schema = 'public' and table_name = 'supplier_invoices'
     and column_name = 'invoice_date'),
  'date',
  'supplier invoice canonical date is stored as a date-only value'
);

update public.accounting_outbox_v2
set accounting_date = accounting_date + 1
where id = (select outbox_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT', 'outbox date differing from trusted purchase date fails closed');
select is(public.supplier_payment_purchase_dependency_v2('b1800000-0000-4000-8000-000000000010'), 'PURCHASE_ACCOUNTING_DEPENDENCY_PENDING', 'outbox canonical-date conflict blocks payment dependency');
select pg_temp.restore_integrity_gate();

update public.financial_events
set accounting_date = accounting_date + 1
where id = (select event_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT', 'financial event accounting date mismatch fails closed');
select pg_temp.restore_integrity_gate();

update public.journal_entries
set entry_date = entry_date + 1
where id = (select entry_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_JOURNAL_CONFLICT', 'journal accounting date mismatch fails closed');
select pg_temp.restore_integrity_gate();

update public.financial_events
set source_snapshot = source_snapshot || jsonb_build_object(
      'generation_timestamp', now() + interval '3 hours'
    ),
    created_at = created_at + interval '3 hours'
where id = (select event_id from _integrity_fact);
update public.journal_entries
set created_at = created_at - interval '2 hours'
where id = (select entry_id from _integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_DRAFTED', 'volatile generation timestamps do not create a false accounting conflict');
select pg_temp.restore_integrity_gate();

set local timezone = 'UTC';
select is(public.purchase_accounting_completeness_v2((select payable_id from _integrity_fact)), 'PURCHASE_ACCOUNTING_DRAFTED', 'date-only canonical comparison is invariant across session timezone');
set local timezone = 'America/Tegucigalpa';

-- Supplier invoice date remains authoritative over the purchase fallback. A
-- fresh fact uses the currently active mapping identities in this long test.
select set_config('request.jwt.claim.sub', 'b1010000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claims', '{"sub":"b1010000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select pg_temp.insert_purchase(
  'b1300000-0000-4000-8000-000000000071',
  'PRV2-INVOICE-INTEGRITY', current_date - 1, 300, 0, 0, 0, 'HNL'
);
insert into public.supplier_invoices(
  id, supplier_id, purchase_id, invoice_number, invoice_date, due_date,
  status, subtotal, tax_amount, discount_amount, total, currency, created_by
)
values (
  'b1600000-0000-4000-8000-000000000011',
  'b1000000-0000-4000-8000-000000000001',
  'b1300000-0000-4000-8000-000000000071',
  'PRV2-INVOICE-INTEGRITY', current_date - 2, current_date + 30,
  'received', 300, 0, 0, 300, 'HNL',
  'b1010000-0000-4000-8000-000000000001'
);
select * from public.confirm_purchase_with_payable_v1(
  'b1300000-0000-4000-8000-000000000071', 'credit', current_date + 30,
  0, null, null, null, 'b1200000-0000-4000-8000-000000000071'
);
create temp table _invoice_integrity_fact as
select payable.id payable_id, box.id outbox_id
from public.accounts_payable payable
join public.accounting_outbox_v2 box
  on box.source_type = 'accounts_payable'
 and box.source_id = payable.id
 and box.event_purpose = 'accounts_payable_created'
 and box.posting_version = 'v2'
where payable.purchase_id = 'b1300000-0000-4000-8000-000000000071';
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public.process_accounting_outbox_v2(
  (select outbox_id from _invoice_integrity_fact),
  'pgtap-invoice-integrity', false
);
select is(public.purchase_accounting_completeness_v2((select payable_id from _invoice_integrity_fact)), 'PURCHASE_ACCOUNTING_DRAFTED', 'supplier invoice date matching the complete chain is healthy');
update public.accounting_outbox_v2
set accounting_date = current_date - 1
where id = (select outbox_id from _invoice_integrity_fact);
select is(public.purchase_accounting_completeness_v2((select payable_id from _invoice_integrity_fact)), 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT', 'purchase-date outbox value is rejected when supplier invoice date is canonical');
update public.accounting_outbox_v2
set accounting_date = current_date - 2
where id = (select outbox_id from _invoice_integrity_fact);
update public.supplier_invoices
set invoice_date = current_date - 3
where id = 'b1600000-0000-4000-8000-000000000011';
select is(public.purchase_accounting_completeness_v2((select payable_id from _invoice_integrity_fact)), 'PURCHASE_ACCOUNTING_SNAPSHOT_CONFLICT', 'trusted supplier invoice date change after draft fails closed for reconciliation');
update public.supplier_invoices
set invoice_date = current_date - 2
where id = 'b1600000-0000-4000-8000-000000000011';
select is(public.purchase_accounting_completeness_v2((select payable_id from _invoice_integrity_fact)), 'PURCHASE_ACCOUNTING_DRAFTED', 'restored supplier invoice date restores exact semantic validity');

-- Multi-invoice settlement may be routed while all V2 components are valid,
-- but processing is blocked if one component later becomes invalid.
insert into public.supplier_payments(
  id, accounts_payable_id, supplier_id, amount, payment_method,
  payment_method_v2, status, paid_at, created_by, allocation_mode,
  currency, payment_account_id, idempotency_key
)
values (
  'b1800000-0000-4000-8000-000000000011', null,
  'b1000000-0000-4000-8000-000000000001', 20, 'cash', 'cash',
  'paid', now(), 'b1010000-0000-4000-8000-000000000001',
  'applications_v1', 'HNL', 'b1100000-0000-4000-8000-000000000006',
  'prv2-integrity-multi'
);
insert into public.supplier_payment_applications(
  supplier_payment_id, accounts_payable_id, applied_amount, currency,
  balance_before, balance_after, status_before, status_after,
  recognition_origin, recognition_journal_entry_id, recognition_date
)
values
  ('b1800000-0000-4000-8000-000000000011',
   (select payable_id from _integrity_fact), 10, 'HNL', 125, 115,
   'pending', 'partial', 'direct_event', (select entry_id from _integrity_fact),
   current_date),
  ('b1800000-0000-4000-8000-000000000011',
   'b1500000-0000-4000-8000-000000000001', 10, 'HNL', 75, 65,
   'pending', 'partial', 'direct_event', (select entry_id from _integrity_fact),
   current_date);
create temp table _integrity_multi_outbox as
select public.route_supplier_payment_accounting_v2(
  'b1800000-0000-4000-8000-000000000011',
  'b1010000-0000-4000-8000-000000000001'
) outbox_id;
select ok((select outbox_id from _integrity_multi_outbox) is not null, 'healthy V2 plus historical V1 multi-invoice payment is routed compatibly');
update public.accounting_outbox_v2
set status = 'failed', last_error_code = 'PURCHASE_ACCOUNTING_FAILED',
    last_error_message = 'Fallo local de un componente.'
where id = (select outbox_id from _integrity_fact);
select is(public.supplier_payment_purchase_dependency_v2('b1800000-0000-4000-8000-000000000011'), 'PURCHASE_ACCOUNTING_DEPENDENCY_PENDING', 'one failed V2 component makes the multi-invoice dependency fail closed');
select is(
  (public.process_accounting_outbox_v2(
    (select outbox_id from _integrity_multi_outbox),
    'pgtap-multi-invalid-component', true
  )->>'error_code'),
  'PURCHASE_ACCOUNTING_DEPENDENCY_PENDING',
  'multi-invoice settlement draft processing is blocked by one invalid V2 component'
);
select pg_temp.restore_integrity_gate();

update public.accounting_outbox_v2
set accounting_date = accounting_date + 1
where id = (select outbox_id from _integrity_fact);
select is(public.supplier_payment_purchase_dependency_v2('b1800000-0000-4000-8000-000000000011'), 'PURCHASE_ACCOUNTING_DEPENDENCY_PENDING', 'one date-conflicted V2 component makes the multi-invoice dependency fail closed');
select pg_temp.restore_integrity_gate();

select is(
  (select count(*)::integer from public.journal_entries where status = 'publicada'),
  0,
  'no accounting journal was automatically published'
);
select is(
  (select value->>'mode' from public.accounting_automation_settings where key = 'automation_mode'),
  'disabled',
  'accounting automation mode remains disabled after all scenarios'
);

select * from finish();
rollback;
