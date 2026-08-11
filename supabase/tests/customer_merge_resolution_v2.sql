\set ON_ERROR_STOP on
begin;
select plan(43);

create temporary table customer_merge_v2_state(key text primary key, value jsonb not null);

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('cc100000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','merge-v2-owner@example.test','',now(),'{}','{}',now(),now()),
('cc100000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','credit-portal@example.test','',now(),'{}','{}',now(),now()),
('cc100000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','pending-portal@example.test','',now(),'{}','{}',now(),now()),
('cc100000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','unexpected-pending-auth@example.test','',now(),'{}','{}',now(),now());

insert into public.users(id,role_id,full_name,email,active) values
('cc100000-0000-4000-8000-000000000001',(select id from public.roles where name='technical_owner'),'Merge V2 Owner','merge-v2-owner@example.test',true),
('cc100000-0000-4000-8000-000000000002',(select id from public.roles where name='cliente'),'Credit Portal','credit-portal@example.test',true),
('cc100000-0000-4000-8000-000000000003',(select id from public.roles where name='cliente'),'Pending Portal','pending-portal@example.test',true),
('cc100000-0000-4000-8000-000000000004',(select id from public.roles where name='cliente'),'Unexpected Pending Auth','unexpected-pending-auth@example.test',true)
on conflict (id) do update set role_id=excluded.role_id,full_name=excluded.full_name,email=excluded.email,active=true;

update public.customer_feature_flags set enabled=true,enabled_at=now(),reason='Enabled only inside rolled-back customer merge V2 tests.' where key='customer_merge_execution_v1';
update public.pos_feature_flags set enabled=true,enabled_at=now(),reason='Enabled only inside rolled-back customer merge V2 tests.' where key='pos_credit_overdue_override_v1';
select set_config('request.jwt.claims','{"sub":"cc100000-0000-4000-8000-000000000001","role":"authenticated"}',true);

-- Over-limit fixture: the debt is real and remains immutable; only future credit configuration changes.
insert into public.customers(id,user_id,business_name,contact_name,email,phone,status,active,commercial_version) values
('cc200000-0000-4000-8000-000000000001','cc100000-0000-4000-8000-000000000002','Polar Fixture','Polar Fixture','credit-portal@example.test','99001122','active',true,0),
('cc200000-0000-4000-8000-000000000002',null,'Polar Fixture','Polar Fixture','credit-portal@example.test','99001122','active',true,0);
insert into public.customer_credit_accounts(id,customer_id,is_credit_enabled,credit_limit,terms_days,status,notes,activated_at)
values ('cc300000-0000-4000-8000-000000000001','cc200000-0000-4000-8000-000000000001',true,100,25,'active','Preserve this credit note',now());
insert into public.accounts_receivable(id,customer_id,order_id,invoice_id,historical_invoice_number,original_amount,balance_due,due_date,status) values
('cc300000-0000-4000-8000-000000000002','cc200000-0000-4000-8000-000000000001',null,null,'V2-P-001',80,80,current_date+30,'open'),
('cc300000-0000-4000-8000-000000000003','cc200000-0000-4000-8000-000000000002',null,null,'V2-P-002',100,100,current_date-10,'overdue');

insert into customer_merge_v2_state select 'credit_preview',public.preview_customer_merge_v1('cc200000-0000-4000-8000-000000000001','cc200000-0000-4000-8000-000000000002');
select ok((select value->'warnings' ? 'CUSTOMER_MERGE_CREDIT_EXPOSURE_EXCEEDS_LIMIT' from customer_merge_v2_state where key='credit_preview'),'preview warns about consolidated credit exposure');
select ok((select value->'requiredDecisions' ? 'creditOverLimitResolution' from customer_merge_v2_state where key='credit_preview'),'preview requires the over-limit decision');
select is((select (value->'creditExposure'->>'targetOpenBalance')::numeric from customer_merge_v2_state where key='credit_preview'),80::numeric,'preview snapshots target open balance');
select is((select (value->'creditExposure'->>'sourceOpenBalance')::numeric from customer_merge_v2_state where key='credit_preview'),100::numeric,'preview snapshots source open balance');
select is((select (value->'creditExposure'->>'consolidatedOpenBalance')::numeric from customer_merge_v2_state where key='credit_preview'),180::numeric,'preview snapshots consolidated balance');
select is((select (value->'creditExposure'->>'overexposure')::numeric from customer_merge_v2_state where key='credit_preview'),80::numeric,'preview snapshots overexposure');
select isnt((select value->>'previewHash' from customer_merge_v2_state where key='credit_preview'),(select public.preview_customer_merge_v1_base_resolution_v2('cc200000-0000-4000-8000-000000000001','cc200000-0000-4000-8000-000000000002')->>'previewHash'),'V2 resolution contract participates in preview hash');

select throws_ok(format(
  'select public.merge_customers_v1(%L,%L,%L,%s,%s,%L,%L::jsonb,%L::jsonb,%L::jsonb,%L,%L)',
  'customer-merge-v2-credit-no-decision','cc200000-0000-4000-8000-000000000001','cc200000-0000-4000-8000-000000000002',
  (select value->>'primaryCommercialVersion' from customer_merge_v2_state where key='credit_preview'),
  (select value->>'secondaryCommercialVersion' from customer_merge_v2_state where key='credit_preview'),
  (select value->>'previewHash' from customer_merge_v2_state where key='credit_preview'),'{}','{}','{}','V2 explicit credit decision is required','crm'
),'22023','CUSTOMER_MERGE_CREDIT_OVER_LIMIT_DECISION_REQUIRED','executor rejects missing over-limit decision');

insert into customer_merge_v2_state
select 'credit_merge',public.merge_customers_v1(
  'customer-merge-v2-credit-success','cc200000-0000-4000-8000-000000000001','cc200000-0000-4000-8000-000000000002',
  (select (value->>'primaryCommercialVersion')::integer from customer_merge_v2_state where key='credit_preview'),
  (select (value->>'secondaryCommercialVersion')::integer from customer_merge_v2_state where key='credit_preview'),
  (select value->>'previewHash' from customer_merge_v2_state where key='credit_preview'),'{}',
  '{"overLimitResolution":"DISABLE_AND_ZERO_LIMIT"}','{}','V2 authorized credit resolution fixture','crm'
);
select ok((select (value->>'ok')::boolean from customer_merge_v2_state where key='credit_merge'),'over-limit merge succeeds with explicit decision');
select is((select id from public.customer_credit_accounts where customer_id='cc200000-0000-4000-8000-000000000001'),'cc300000-0000-4000-8000-000000000001'::uuid,'canonical credit account ID is preserved');
select ok((select not is_credit_enabled and status='suspended' from public.customer_credit_accounts where id='cc300000-0000-4000-8000-000000000001'),'canonical credit becomes disabled and suspended');
select is((select credit_limit from public.customer_credit_accounts where id='cc300000-0000-4000-8000-000000000001'),0::numeric,'canonical credit limit becomes zero');
select is((select terms_days from public.customer_credit_accounts where id='cc300000-0000-4000-8000-000000000001'),25,'credit terms are preserved');
select is((select notes from public.customer_credit_accounts where id='cc300000-0000-4000-8000-000000000001'),'Preserve this credit note','credit notes are preserved');
select is((select count(*) from public.accounts_receivable where id in ('cc300000-0000-4000-8000-000000000002','cc300000-0000-4000-8000-000000000003')),2::bigint,'all receivable IDs are preserved');
select ok((select count(*)=2 from public.accounts_receivable where customer_id='cc200000-0000-4000-8000-000000000001' and ((id='cc300000-0000-4000-8000-000000000002' and original_amount=80 and balance_due=80 and due_date=current_date+30 and status='open') or (id='cc300000-0000-4000-8000-000000000003' and original_amount=100 and balance_due=100 and due_date=current_date-10 and status='overdue'))),'receivable amounts, balances, dates and statuses survive merge');
select ok((public.merge_customers_v1('customer-merge-v2-credit-success','cc200000-0000-4000-8000-000000000001','cc200000-0000-4000-8000-000000000002',(select (value->>'primaryCommercialVersion')::integer from customer_merge_v2_state where key='credit_preview'),(select (value->>'secondaryCommercialVersion')::integer from customer_merge_v2_state where key='credit_preview'),(select value->>'previewHash' from customer_merge_v2_state where key='credit_preview'),'{}','{"overLimitResolution":"DISABLE_AND_ZERO_LIMIT"}','{}','V2 authorized credit resolution fixture','crm')->>'idempotentReplay')::boolean,'identical resolution request replays idempotently');
select throws_ok(format('select public.merge_customers_v1(%L,%L,%L,%s,%s,%L,%L::jsonb,%L::jsonb,%L::jsonb,%L,%L)','customer-merge-v2-credit-success','cc200000-0000-4000-8000-000000000001','cc200000-0000-4000-8000-000000000002',(select value->>'primaryCommercialVersion' from customer_merge_v2_state where key='credit_preview'),(select value->>'secondaryCommercialVersion' from customer_merge_v2_state where key='credit_preview'),(select value->>'previewHash' from customer_merge_v2_state where key='credit_preview'),'{}','{"overLimitResolution":"DISABLE_AND_ZERO_LIMIT","selectedSource":"primary"}','{}','V2 authorized credit resolution fixture','crm'),'23505','CUSTOMER_MERGE_REQUEST_KEY_PAYLOAD_MISMATCH','decision changes are part of idempotency fingerprint');

select lives_ok($$select * from public.register_credit_receivable_payment('cc300000-0000-4000-8000-000000000003',30,'cash','V2-PAY',now(),'Payment while future credit is disabled',null,null,'customer-merge-v2-payment')$$,'payments remain operational while future credit is disabled');
select is((select balance_due from public.accounts_receivable where id='cc300000-0000-4000-8000-000000000003'),70::numeric,'payment updates the preserved receivable normally');
select lives_ok($$select * from public.set_customer_commercial_credit_authorized('cc200000-0000-4000-8000-000000000001',true,500,25,'active','Reactivated after V2 fixture')$$,'owner can later reactivate with a positive limit');
select ok((select id='cc300000-0000-4000-8000-000000000001' and is_credit_enabled and credit_limit=500 and terms_days=25 and status='active' from public.customer_credit_accounts where customer_id='cc200000-0000-4000-8000-000000000001'),'reactivation preserves account ID and terms');
select ok((select has_effective_overdue from public._get_customer_commercial_credit_state_v2('cc200000-0000-4000-8000-000000000001')),'reactivation does not erase effective overdue debt');
select ok((select feature_enabled and override_allowed from public.get_pos_credit_overdue_override_capability_v1()),'authorized overdue override capability remains intact');

-- Safe pending secondary fixture: only CRM history is allowed on the inactive source.
insert into public.customers(id,user_id,business_name,contact_name,email,phone,status,active,commercial_version) values
('cc200000-0000-4000-8000-000000000003','cc100000-0000-4000-8000-000000000003','Rapalo Fixture','Rapalo Fixture','pending-portal@example.test','22334455','active',true,0),
('cc200000-0000-4000-8000-000000000004',null,'Rapalo Fixture','Rapalo Fixture','pending-portal@example.test','22334455','active',true,0);
insert into public.crm_notes(id,customer_id,note_type,note) values ('cc300000-0000-4000-8000-000000000004','cc200000-0000-4000-8000-000000000004','nota','Pending CRM note');
insert into public.crm_followups(id,customer_id,title,status) values ('cc300000-0000-4000-8000-000000000005','cc200000-0000-4000-8000-000000000004','Pending CRM followup','pending');
update public.customers set status='pending_account',active=false where id='cc200000-0000-4000-8000-000000000004';
insert into customer_merge_v2_state select 'pending_preview',public.preview_customer_merge_v1('cc200000-0000-4000-8000-000000000003','cc200000-0000-4000-8000-000000000004');
select ok((select (value->>'allowed')::boolean from customer_merge_v2_state where key='pending_preview'),'strict pending secondary preview is eligible');
select ok((select value->'requiredDecisions' ? 'pendingSecondaryResolution' from customer_merge_v2_state where key='pending_preview'),'pending preview requires explicit archive decision');
select is((select (value->'pendingSecondary'->'economy'->>'blockingCount')::integer from customer_merge_v2_state where key='pending_preview'),0,'CRM-only pending secondary has zero blocking economy');
select throws_ok(format('select public.merge_customers_v1(%L,%L,%L,%s,%s,%L,%L::jsonb,%L::jsonb,%L::jsonb,%L,%L)','customer-merge-v2-pending-no-decision','cc200000-0000-4000-8000-000000000003','cc200000-0000-4000-8000-000000000004',(select value->>'primaryCommercialVersion' from customer_merge_v2_state where key='pending_preview'),(select value->>'secondaryCommercialVersion' from customer_merge_v2_state where key='pending_preview'),(select value->>'previewHash' from customer_merge_v2_state where key='pending_preview'),'{}','{}','{}','V2 pending decision is required','crm'),'22023','CUSTOMER_MERGE_PENDING_SECONDARY_DECISION_REQUIRED','executor rejects missing pending resolution');
insert into customer_merge_v2_state select 'pending_merge',public.merge_customers_v1('customer-merge-v2-pending-success','cc200000-0000-4000-8000-000000000003','cc200000-0000-4000-8000-000000000004',(select (value->>'primaryCommercialVersion')::integer from customer_merge_v2_state where key='pending_preview'),(select (value->>'secondaryCommercialVersion')::integer from customer_merge_v2_state where key='pending_preview'),(select value->>'previewHash' from customer_merge_v2_state where key='pending_preview'),'{}','{}','{"pendingSecondaryResolution":"ARCHIVE_PENDING_SECONDARY_AS_MERGED"}','V2 authorized pending secondary fixture','crm');
select ok((select (value->>'ok')::boolean from customer_merge_v2_state where key='pending_merge'),'pending secondary merge succeeds with explicit resolution');
select ok((select status='merged' and not active and merged_into_customer_id='cc200000-0000-4000-8000-000000000003' from public.customers where id='cc200000-0000-4000-8000-000000000004'),'pending secondary becomes an archived canonical alias');
select ok((select user_id='cc100000-0000-4000-8000-000000000003' and email='pending-portal@example.test' from public.customers where id='cc200000-0000-4000-8000-000000000003'),'principal portal identity is preserved');
select is((select customer_id from public.crm_notes where id='cc300000-0000-4000-8000-000000000004'),'cc200000-0000-4000-8000-000000000003'::uuid,'pending CRM note moves with provenance');
select is((select customer_id from public.crm_followups where id='cc300000-0000-4000-8000-000000000005'),'cc200000-0000-4000-8000-000000000003'::uuid,'pending CRM followup moves with provenance');
select ok((select commercial_decision @> '{"pendingSecondaryResolution":"ARCHIVE_PENDING_SECONDARY_AS_MERGED"}'::jsonb from public.customer_merge_operations where request_key='customer-merge-v2-pending-success'),'pending decision is stored in immutable merge ledger');

-- Negative pending fixtures. Every exception remains narrowly scoped.
insert into public.customers(id,user_id,contact_name,email,phone,status,active,commercial_version) values
('cc200000-0000-4000-8000-000000000010','cc100000-0000-4000-8000-000000000004','Pending Auth','unexpected-pending-auth@example.test','33110010','active',true,0),
('cc200000-0000-4000-8000-000000000011',null,'Pending Order',null,'33110011','active',true,0),
('cc200000-0000-4000-8000-000000000012',null,'Pending Invoice',null,'33110012','active',true,0),
('cc200000-0000-4000-8000-000000000013',null,'Pending Receivable',null,'33110013','active',true,0),
('cc200000-0000-4000-8000-000000000014',null,'Pending Credit',null,'33110014','active',true,0),
('cc200000-0000-4000-8000-000000000015',null,'Pending Draft',null,'33110015','active',true,0);
insert into public.orders(id,order_number,customer_id,customer_name,phone,delivery_address,payment_method,subtotal,tax,total,status,requested_invoice_date) values
('cc300000-0000-4000-8000-000000000010','V2-ORDER-10','cc200000-0000-4000-8000-000000000011','Pending Order','33110011','Test','cash',10,0,10,'pending',current_date),
('cc300000-0000-4000-8000-000000000011','V2-ORDER-11','cc200000-0000-4000-8000-000000000012','Pending Invoice','33110012','Test','cash',10,0,10,'pending',current_date);
insert into public.invoices(id,order_id,customer_id,invoice_number,status,price_mode,subtotal,tax,total,invoice_date) values ('cc300000-0000-4000-8000-000000000012','cc300000-0000-4000-8000-000000000011','cc200000-0000-4000-8000-000000000012','V2-INVOICE-12','draft','retail',10,0,10,current_date);
insert into public.accounts_receivable(id,customer_id,order_id,invoice_id,historical_invoice_number,original_amount,balance_due,due_date,status) values ('cc300000-0000-4000-8000-000000000013','cc200000-0000-4000-8000-000000000013',null,null,'V2-AR-13',10,10,current_date+10,'open');
insert into public.customer_credit_accounts(id,customer_id,is_credit_enabled,credit_limit,terms_days,status) values ('cc300000-0000-4000-8000-000000000014','cc200000-0000-4000-8000-000000000014',false,0,30,'suspended');
insert into public.pos_sale_drafts(id,owner_user_id,customer_id,customer_commercial_version,pricing_mode_snapshot,status,last_saved_by) values ('cc300000-0000-4000-8000-000000000015','cc100000-0000-4000-8000-000000000001','cc200000-0000-4000-8000-000000000015',0,'retail','active','cc100000-0000-4000-8000-000000000001');
update public.customers set status='pending_account',active=false where id in (
  'cc200000-0000-4000-8000-000000000010','cc200000-0000-4000-8000-000000000011','cc200000-0000-4000-8000-000000000012',
  'cc200000-0000-4000-8000-000000000013','cc200000-0000-4000-8000-000000000014','cc200000-0000-4000-8000-000000000015'
);
select ok(public.preview_customer_merge_v1('cc200000-0000-4000-8000-000000000003','cc200000-0000-4000-8000-000000000010')->'blockers' ? 'CUSTOMER_MERGE_PENDING_SECONDARY_HAS_AUTH','pending secondary with Auth is rejected');
select ok(public.preview_customer_merge_v1('cc200000-0000-4000-8000-000000000003','cc200000-0000-4000-8000-000000000011')->'blockers' ? 'CUSTOMER_MERGE_PENDING_SECONDARY_HAS_ECONOMY','pending secondary with order is rejected');
select ok((public.preview_customer_merge_v1('cc200000-0000-4000-8000-000000000003','cc200000-0000-4000-8000-000000000012')->'pendingSecondary'->'economy'->>'invoices')::integer=1,'pending secondary with invoice is rejected and counted');
select ok((public.preview_customer_merge_v1('cc200000-0000-4000-8000-000000000003','cc200000-0000-4000-8000-000000000013')->'pendingSecondary'->'economy'->>'receivables')::integer=1,'pending secondary with receivable is rejected and counted');
select ok((public.preview_customer_merge_v1('cc200000-0000-4000-8000-000000000003','cc200000-0000-4000-8000-000000000014')->'pendingSecondary'->'economy'->>'creditAccounts')::integer=1,'pending secondary with credit account is rejected and counted');
select ok((public.preview_customer_merge_v1('cc200000-0000-4000-8000-000000000003','cc200000-0000-4000-8000-000000000015')->'pendingSecondary'->'economy'->>'activePosDrafts')::integer=1,'pending secondary with active POS draft is rejected and counted');
select ok((public.customer_merge_secondary_economy_v2('cc200000-0000-4000-8000-000000000004')->>'blockingCount')::integer=0,'CRM notes and followups are explicitly non-economic');
select is(public.resolve_customer_root_v1('cc200000-0000-4000-8000-000000000004'),'cc200000-0000-4000-8000-000000000003'::uuid,'portal-facing canonical resolver keeps the principal root');

select set_config('request.jwt.claims','{"sub":"cc100000-0000-4000-8000-000000000003","role":"authenticated"}',true);
set local role authenticated;
select is(public.resolve_portal_commercial_context_v1()->>'customerId','cc200000-0000-4000-8000-000000000003','portal RLS resolver still returns the principal customer');
reset role;

select * from finish();
rollback;
