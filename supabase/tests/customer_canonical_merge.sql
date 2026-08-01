\set ON_ERROR_STOP on
begin;
select plan(37);

create temporary table customer_merge_test_state(key text primary key,value jsonb not null);

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('ca100000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','merge-owner@example.test','',now(),'{}','{}',now(),now()),
('ca100000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','portal-a@example.test','',now(),'{}','{}',now(),now()),
('ca100000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','portal-b@example.test','',now(),'{}','{}',now(),now()),
('ca100000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','merge-seller@example.test','',now(),'{}','{}',now(),now());

insert into public.users(id,role_id,full_name,email,active) values
('ca100000-0000-4000-8000-000000000001',(select id from public.roles where name='technical_owner'),'Merge Owner','merge-owner@example.test',true),
('ca100000-0000-4000-8000-000000000002',(select id from public.roles where name='cliente'),'Portal A','portal-a@example.test',true),
('ca100000-0000-4000-8000-000000000003',(select id from public.roles where name='cliente'),'Portal B','portal-b@example.test',true),
('ca100000-0000-4000-8000-000000000004',(select id from public.roles where name='vendedor'),'Merge Seller','merge-seller@example.test',true)
on conflict (id) do update set role_id=excluded.role_id,full_name=excluded.full_name,email=excluded.email,active=true;

select is(public.normalize_customer_email_v1(' Test @Example.COM '),'test@example.com','email normalization removes accidental spaces and lowercases');
select is(public.normalize_customer_phone_hn_v1('(504) 9911-2211'),'+50499112211','Honduras phone normalization accepts 504 format');
select is(public.normalize_customer_phone_hn_v1('99112211'),'+50499112211','Honduras local and country formats are equivalent');
select is(public.normalize_customer_tax_id_hn_v1('0801-1999-123456'),'08011999123456','RTN normalization keeps exactly fourteen digits');

select ok((select permissions ? 'customers:merge' from public.roles where name='technical_owner'),'technical owner receives customers:merge');
select ok((select permissions ? 'customers:merge' from public.roles where name='business_owner'),'business owner receives customers:merge');
select ok(not coalesce((select permissions ? 'customers:merge' from public.roles where name='admin'),false),'admin does not receive customers:merge implicitly');
select ok(not coalesce((select permissions ? 'customers:merge' from public.roles where name='vendedor'),false),'seller does not receive customers:merge');

update public.customer_feature_flags set enabled=true,enabled_at=now(),reason='Enabled only inside rolled-back canonical merge tests.' where key in ('customer_merge_execution_v1','customer_duplicate_prevention_v1');
select set_config('request.jwt.claims','{"sub":"ca100000-0000-4000-8000-000000000001","role":"authenticated"}',true);

insert into public.customers(id,user_id,business_name,company_name,contact_name,email,phone,tax_id,address,city,status,active,commercial_version,is_wholesale,wholesale_status,wholesale_customer_type,wholesale_approved_at) values
('ca200000-0000-4000-8000-000000000001','ca100000-0000-4000-8000-000000000002','Taller Canonico','Taller Canonico','Ana López',null,null,'08011999123456',null,'Tegucigalpa','active',true,0,false,'none','new',null),
('ca200000-0000-4000-8000-000000000002',null,'Taller Canonico','Taller Canonico','Ana Lopez','ana@example.test','99-11-22-11','0801-1999-123456','Barrio Centro','Tegucigalpa','active',true,0,true,'approved','existing',now());

insert into public.crm_notes(id,customer_id,note_type,note) values ('ca300000-0000-4000-8000-000000000001','ca200000-0000-4000-8000-000000000002','nota','Nota secundaria');
insert into public.crm_followups(id,customer_id,title,status) values ('ca300000-0000-4000-8000-000000000002','ca200000-0000-4000-8000-000000000002','Seguimiento secundario','pending');
insert into public.accounts_receivable(id,customer_id,order_id,invoice_id,historical_invoice_number,original_amount,balance_due,due_date,status) values ('ca300000-0000-4000-8000-000000000003','ca200000-0000-4000-8000-000000000002',null,null,'TEST-001',1000,1000,current_date+30,'open');
insert into public.accounts_receivable_payments(id,receivable_id,customer_id,order_id,amount,payment_method,reference) values ('ca300000-0000-4000-8000-000000000004','ca300000-0000-4000-8000-000000000003','ca200000-0000-4000-8000-000000000002',null,250,'cash','TEST');

insert into customer_merge_test_state select 'preview',public.preview_customer_merge_v1('ca200000-0000-4000-8000-000000000001','ca200000-0000-4000-8000-000000000002');
select ok((select (value->>'allowed')::boolean from customer_merge_test_state where key='preview'),'complementary preview is allowed');
select is((select value->>'confidence' from customer_merge_test_state where key='preview'),'strong','same RTN yields strong confidence');
select matches((select value->>'previewHash' from customer_merge_test_state where key='preview'),'^[0-9a-f]{64}$','preview returns a sha256 hash');
select is((select (value->'counts'->>'receivables')::integer from customer_merge_test_state where key='preview'),1,'preview counts historical receivables');
select is((select value->'financialTotals'->>'receivableOpenBalance' from customer_merge_test_state where key='preview'),'1000.00','preview derives open receivable balance');

insert into customer_merge_test_state
select 'details', public.get_customer_merge_history_details_v1(
  'ca200000-0000-4000-8000-000000000001',
  'ca200000-0000-4000-8000-000000000002',
  (select value->>'previewHash' from customer_merge_test_state where key='preview'),
  0,
  0
);
select is((select value->>'previewHash' from customer_merge_test_state where key='details'),(select value->>'previewHash' from customer_merge_test_state where key='preview'),'details remain tied to the canonical preview hash');
select ok((select value->'items' @> '[{"category":"crm_note","action":"move_to_primary"}]'::jsonb from customer_merge_test_state where key='details'),'details mark the CRM note for server-authoritative reassignment');
select ok((select value->'items' @> '[{"category":"crm_followup","action":"move_to_primary"}]'::jsonb from customer_merge_test_state where key='details'),'details mark the followup for server-authoritative reassignment');
select ok((select value->'items' @> '[{"category":"receivable","action":"move_to_primary"}]'::jsonb from customer_merge_test_state where key='details'),'details identify the concrete receivable action');
select is((select (value->'summary'->'receivables'->>'count')::integer from customer_merge_test_state where key='details'),1,'details return the receivable integrity summary');
select ok((select value->'assurances' @> '[{"code":"invoice"}]'::jsonb from customer_merge_test_state where key='details'),'details return immutable business assurances');
select throws_ok(
  $$select public.get_customer_merge_history_details_v1('ca200000-0000-4000-8000-000000000001','ca200000-0000-4000-8000-000000000002',repeat('0',64),0,0)$$,
  '40001',
  'CUSTOMER_MERGE_PREVIEW_STALE',
  'details reject a stale preview hash'
);

insert into customer_merge_test_state
select 'merge',public.merge_customers_v1(
  'customer-merge-fixture-a-v1','ca200000-0000-4000-8000-000000000001','ca200000-0000-4000-8000-000000000002',0,0,
  (select value->>'previewHash' from customer_merge_test_state where key='preview'),'{}','{}','{}','Canonical complementary fixture merge','crm'
);
select ok((select (value->>'ok')::boolean from customer_merge_test_state where key='merge'),'merge completes atomically');
select is(public.resolve_customer_root_v1('ca200000-0000-4000-8000-000000000002'),'ca200000-0000-4000-8000-000000000001'::uuid,'secondary resolves to primary');
select is((select status from public.customers where id='ca200000-0000-4000-8000-000000000002'),'merged','secondary remains physically archived as merged');
select is((select is_wholesale from public.customers where id='ca200000-0000-4000-8000-000000000001'),true,'approved wholesale state transfers to the canonical customer');
select ok((select not is_wholesale and wholesale_status='none' from public.customers where id='ca200000-0000-4000-8000-000000000002'),'merged alias has no active wholesale state');
select is((select email from public.customers where id='ca200000-0000-4000-8000-000000000001'),'ana@example.test','missing email is completed from secondary');
select is((select phone from public.customers where id='ca200000-0000-4000-8000-000000000001'),'99-11-22-11','missing phone is completed without concatenation');
select is((select original_customer_id from public.crm_notes where id='ca300000-0000-4000-8000-000000000001'),'ca200000-0000-4000-8000-000000000002'::uuid,'CRM note preserves original customer provenance');
select is((select customer_id from public.accounts_receivable where id='ca300000-0000-4000-8000-000000000003'),'ca200000-0000-4000-8000-000000000001'::uuid,'receivable is reassigned without recreation');
select ok((select count(*)>=5 from public.customer_identity_values where customer_id='ca200000-0000-4000-8000-000000000001'),'identity alternatives are stored structurally');
select is((public.merge_customers_v1('customer-merge-fixture-a-v1','ca200000-0000-4000-8000-000000000001','ca200000-0000-4000-8000-000000000002',0,0,(select value->>'previewHash' from customer_merge_test_state where key='preview'),'{}','{}','{}','Canonical complementary fixture merge','crm')->>'idempotentReplay')::boolean,true,'same request replays stable result');

select throws_ok($$update public.customers set merge_reason='Unauthorized direct change' where id='ca200000-0000-4000-8000-000000000002'$$,'42501','CUSTOMER_MERGE_FIELDS_RPC_ONLY','direct merge-field updates are blocked');
select throws_ok($$insert into public.crm_notes(customer_id,note_type,note) values ('ca200000-0000-4000-8000-000000000002','nota','Forbidden alias write')$$,'23514','CUSTOMER_ALIAS_READ_ONLY','new operational writes cannot target aliases');

insert into public.customers(id,user_id,contact_name,email,phone,tax_id,status,active,commercial_version) values
('ca200000-0000-4000-8000-000000000003',null,'Fiscal Conflict','fiscal@example.test','99887766','08011999123456','active',true,0),
('ca200000-0000-4000-8000-000000000004',null,'Fiscal Conflict','fiscal@example.test','99887766','05011999123456','active',true,0),
('ca200000-0000-4000-8000-000000000005','ca100000-0000-4000-8000-000000000001','Portal Conflict','22334455',null,null,'active',true,0),
('ca200000-0000-4000-8000-000000000006','ca100000-0000-4000-8000-000000000004','Portal Conflict','22334455',null,null,'active',true,0);
select ok(public.preview_customer_merge_v1('ca200000-0000-4000-8000-000000000003','ca200000-0000-4000-8000-000000000004')->'warnings' ? 'CUSTOMER_MERGE_TAX_ID_CONFLICT','different RTNs produce a fiscal warning');
select ok(public.preview_customer_merge_v1('ca200000-0000-4000-8000-000000000005','ca200000-0000-4000-8000-000000000006')->'blockers' ? 'CUSTOMER_MERGE_TWO_PORTAL_ACCOUNTS','two portal accounts block merge');

select set_config('request.jwt.claims','{"sub":"ca100000-0000-4000-8000-000000000004","role":"authenticated"}',true);
select throws_ok($$select public.preview_customer_merge_v1('ca200000-0000-4000-8000-000000000003','ca200000-0000-4000-8000-000000000004')$$,'42501','CUSTOMER_MERGE_PREVIEW_FORBIDDEN','seller cannot invoke preview directly');
select throws_ok($$select public.get_customer_merge_history_details_v1('ca200000-0000-4000-8000-000000000003','ca200000-0000-4000-8000-000000000004',repeat('0',64),0,0)$$,'42501','CUSTOMER_MERGE_DETAILS_FORBIDDEN','seller cannot invoke merge details');

select * from finish();
rollback;
