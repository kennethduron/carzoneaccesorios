\set ON_ERROR_STOP on
begin;
select plan(39);

select ok(to_regprocedure('public.get_accounting_tax_report_summary_v1(date,date)') is not null, 'tax report summary RPC exists');
select ok(to_regprocedure('public.get_accounting_tax_report_documents_v1(text,date,date,text,integer,integer)') is not null, 'tax report documents RPC exists');
select ok((select prosecdef from pg_proc where oid='public.get_accounting_tax_report_summary_v1(date,date)'::regprocedure), 'summary uses SECURITY DEFINER');
select ok((select prosecdef from pg_proc where oid='public.get_accounting_tax_report_documents_v1(text,date,date,text,integer,integer)'::regprocedure), 'documents use SECURITY DEFINER');
select is((select provolatile::text from pg_proc where oid='public.get_accounting_tax_report_summary_v1(date,date)'::regprocedure), 's', 'summary is STABLE');
select is((select provolatile::text from pg_proc where oid='public.get_accounting_tax_report_documents_v1(text,date,date,text,integer,integer)'::regprocedure), 's', 'documents are STABLE');
select ok((select array_to_string(proconfig, ',') like '%search_path=public%' from pg_proc where oid='public.get_accounting_tax_report_summary_v1(date,date)'::regprocedure), 'summary search_path is fixed');
select ok(not has_function_privilege('anon', 'public.get_accounting_tax_report_summary_v1(date,date)', 'execute'), 'anon cannot execute summary');
select ok(has_function_privilege('authenticated', 'public.get_accounting_tax_report_summary_v1(date,date)', 'execute'), 'authenticated receives guarded execute');
select throws_ok($$select * from public.get_accounting_tax_report_summary_v1('2026-01-01','2026-01-31')$$, '42501', 'TAX_REPORT_PERMISSION_DENIED', 'anonymous report access is denied');
insert into public.roles(name, description, permissions)
values
 ('technical_owner','ACCOUNTING-TAX-REPORT-LOCAL-ONLY','["tax:read"]'::jsonb),
 ('business_owner','ACCOUNTING-TAX-REPORT-LOCAL-ONLY','["tax:read"]'::jsonb),
 ('admin','ACCOUNTING-TAX-REPORT-LOCAL-ONLY','["tax:read"]'::jsonb),
 ('contadora','ACCOUNTING-TAX-REPORT-LOCAL-ONLY','["tax:read"]'::jsonb),
 ('vendedor','ACCOUNTING-TAX-REPORT-LOCAL-ONLY','[]'::jsonb),
 ('bodega','ACCOUNTING-TAX-REPORT-LOCAL-ONLY','[]'::jsonb),
 ('soporte','ACCOUNTING-TAX-REPORT-LOCAL-ONLY','[]'::jsonb),
 ('cliente','ACCOUNTING-TAX-REPORT-LOCAL-ONLY','[]'::jsonb)
on conflict(name) do update set permissions=excluded.permissions;
select is(
  (select count(*)::integer from public.roles where name in ('technical_owner','business_owner','admin','contadora') and permissions ? 'tax:read'),
  4,
  'all four fiscal roles retain tax report access'
);
select is(
  (select count(*)::integer from public.roles where name in ('vendedor','bodega','soporte','cliente') and permissions ? 'tax:read'),
  0,
  'operational and customer roles do not receive tax report access'
);

insert into public.roles(name, description, permissions)
values ('admin', 'ACCOUNTING-TAX-REPORT-LOCAL-ONLY', '["tax:read"]'::jsonb)
on conflict(name) do update set permissions=excluded.permissions;

insert into auth.users(id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values ('ea100000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','accounting-tax-report@example.test','',now(),'{}','{}',now(),now());
insert into public.users(id, role_id, full_name, email, active)
values ('ea100000-0000-4000-8000-000000000001',(select id from public.roles where name='admin'),'Tax Report Fixture','accounting-tax-report@example.test',true)
on conflict(id) do update set role_id=excluded.role_id, active=true;
select set_config('request.jwt.claim.sub','ea100000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',jsonb_build_object('sub','ea100000-0000-4000-8000-000000000001','role','authenticated')::text,true);

update public.users set role_id=(select id from public.roles where name='vendedor') where id='ea100000-0000-4000-8000-000000000001';
select throws_ok(
  $$select * from public.get_accounting_tax_report_summary_v1('2026-01-01','2026-01-31')$$,
  '42501',
  'TAX_REPORT_PERMISSION_DENIED',
  'authenticated user without fiscal permission is denied by the RPC'
);
update public.users set role_id=(select id from public.roles where name='admin') where id='ea100000-0000-4000-8000-000000000001';

insert into public.suppliers(id,name,is_active) values ('ea200000-0000-4000-8000-000000000001','ACCOUNTING-TAX-REPORT-LOCAL-ONLY',true);

insert into public.orders(id,order_number,customer_name,phone,delivery_address,payment_method,price_mode,subtotal,tax,shipping_total,total,status,requested_invoice_date)
values
 ('ea300000-0000-4000-8000-000000000001','TAX-REPORT-SALE-POS','Cliente fixture','99990001','Local','cash','retail',56860.88,8529.12,0,65390,'delivered','2026-01-15'),
 ('ea300000-0000-4000-8000-000000000002','TAX-REPORT-SALE-NEG','Cliente fixture','99990002','Local','cash','retail',26666.67,4000,0,30666.67,'delivered','2026-02-01'),
 ('ea300000-0000-4000-8000-000000000003','TAX-REPORT-SALE-ZERO','Cliente fixture','99990003','Local','cash','retail',26666.67,4000,0,30666.67,'delivered','2026-03-31'),
 ('ea300000-0000-4000-8000-000000000004','TAX-REPORT-SALE-DRAFT','Cliente fixture','99990004','Local','cash','retail',100,15,0,115,'pending','2026-01-20');

insert into public.invoices(id,order_id,invoice_number,status,price_mode,subtotal,tax,total,invoice_date,customer_name)
values
 ('ea400000-0000-4000-8000-000000000001','ea300000-0000-4000-8000-000000000001','TAX-SALE-POS','emitida','retail',56860.88,8529.12,65390,'2026-01-15','Cliente fixture'),
 ('ea400000-0000-4000-8000-000000000002','ea300000-0000-4000-8000-000000000002','TAX-SALE-NEG','emitida','retail',26666.67,4000,30666.67,'2026-02-01','Cliente fixture'),
 ('ea400000-0000-4000-8000-000000000003','ea300000-0000-4000-8000-000000000003','TAX-SALE-ZERO','emitida','retail',26666.67,4000,30666.67,'2026-03-31','Cliente fixture'),
 ('ea400000-0000-4000-8000-000000000004','ea300000-0000-4000-8000-000000000004','TAX-SALE-DRAFT','draft','retail',100,15,115,'2026-01-20','Cliente fixture');

insert into public.supplier_invoices(id,supplier_id,invoice_number,invoice_date,status,subtotal,tax_amount,total,currency)
values
 ('ea500000-0000-4000-8000-000000000001','ea200000-0000-4000-8000-000000000001','TAX-PURCHASE-POS','2026-01-15','received',180919.99,4509.52,185429.51,'HNL'),
 ('ea500000-0000-4000-8000-000000000002','ea200000-0000-4000-8000-000000000001','TAX-PURCHASE-NEG','2026-02-01','received',40000,6000,46000,'HNL'),
 ('ea500000-0000-4000-8000-000000000003','ea200000-0000-4000-8000-000000000001','TAX-PURCHASE-ZERO','2026-03-31','received',26666.67,4000,30666.67,'HNL'),
 ('ea500000-0000-4000-8000-000000000004','ea200000-0000-4000-8000-000000000001','TAX-PURCHASE-CANCELLED','2026-01-20','cancelled',100,15,115,'HNL'),
 ('ea500000-0000-4000-8000-000000000005','ea200000-0000-4000-8000-000000000001','TAX-PURCHASE-USD','2026-01-20','received',100,15,115,'USD');

select results_eq(
 $$select sales_tax,purchase_tax,tax_difference,amount_to_pay from public.get_accounting_tax_report_summary_v1('2026-01-01','2026-01-31')$$,
 $$values (8529.12::numeric,4509.52::numeric,4019.60::numeric,4019.60::numeric)$$,
 'positive period uses persisted taxes and calculates amount payable'
);
select results_eq(
 $$select tax_difference,amount_to_pay from public.get_accounting_tax_report_summary_v1('2026-02-01','2026-02-28')$$,
 $$values ((-2000)::numeric,0::numeric)$$,
 'negative difference floors amount payable at zero'
);
select results_eq(
 $$select tax_difference,amount_to_pay from public.get_accounting_tax_report_summary_v1('2026-03-01','2026-03-31')$$,
 $$values (0::numeric,0::numeric)$$,
 'zero difference produces zero payable'
);
select is((select sales_invoice_count from public.get_accounting_tax_report_summary_v1('2026-01-01','2026-01-31')),1::bigint,'draft sale is excluded');
select is((select purchase_invoice_count from public.get_accounting_tax_report_summary_v1('2026-01-01','2026-01-31')),1::bigint,'cancelled and foreign-currency purchases are excluded');
select is((select excluded_currency_count from public.get_accounting_tax_report_summary_v1('2026-01-01','2026-01-31')),1::bigint,'foreign currency exclusion is disclosed');
select is((select sales_pending_accounting_count from public.get_accounting_tax_report_summary_v1('2026-01-01','2026-01-31')),1::bigint,'document without journal remains included and pending');
select is((select count(*) from public.get_accounting_tax_report_documents_v1('sale','2026-01-15','2026-01-15',null,20,0)),1::bigint,'date boundaries are inclusive');
select is((select count(*) from public.get_accounting_tax_report_documents_v1('sale','2026-01-01','2026-01-31','cliente',20,0)),1::bigint,'sale search filters server-side');
select is((select count(*) from public.get_accounting_tax_report_documents_v1('purchase','2026-01-01','2026-01-31','POS',20,0)),1::bigint,'purchase search filters server-side');
select throws_ok($$select * from public.get_accounting_tax_report_summary_v1('2026-02-01','2026-01-01')$$,'22023','TAX_REPORT_DATE_RANGE_INVALID','invalid date range is rejected');
select throws_ok($$select * from public.get_accounting_tax_report_documents_v1('other','2026-01-01','2026-01-31',null,20,0)$$,'22023','TAX_REPORT_QUERY_INVALID','unknown document type is rejected');
select throws_ok($$select * from public.get_accounting_tax_report_documents_v1('sale','2026-01-01','2026-01-31',null,21,0)$$,'22023','TAX_REPORT_QUERY_INVALID','unsupported page size is rejected');
select is((select total_count from public.get_accounting_tax_report_documents_v1('sale','2026-01-01','2026-01-31',null,20,0) limit 1),1::bigint,'pagination returns global filtered count');
select ok(pg_get_function_result('public.get_accounting_tax_report_documents_v1(text,date,date,text,integer,integer)'::regprocedure) !~* '(email|phone|address|rtn|cai|notes)', 'document contract exposes no unnecessary PII');

insert into public.purchases(id,supplier_id,purchase_number,purchase_date,status,subtotal,tax_amount,total,currency,created_by)
values ('ea600000-0000-4000-8000-000000000001','ea200000-0000-4000-8000-000000000001','TAX-PURCHASE-LINKED','2026-01-15','received',180919.99,4509.52,185429.51,'HNL','ea100000-0000-4000-8000-000000000001');
update public.supplier_invoices set purchase_id='ea600000-0000-4000-8000-000000000001' where id='ea500000-0000-4000-8000-000000000001';
insert into public.accounts_payable(id,supplier_id,purchase_id,supplier_invoice_id,total_amount,status,currency,created_by)
values ('ea700000-0000-4000-8000-000000000001','ea200000-0000-4000-8000-000000000001','ea600000-0000-4000-8000-000000000001','ea500000-0000-4000-8000-000000000001',185429.51,'pending','HNL','ea100000-0000-4000-8000-000000000001');
select results_eq(
  $$select purchase_invoice_count,purchase_tax from public.get_accounting_tax_report_summary_v1('2026-01-01','2026-01-31')$$,
  $$values (1::bigint,4509.52::numeric)$$,
  'purchase, payable and supplier invoice linkage does not double count tax'
);

insert into public.journal_entries(id,entry_number,entry_date,description,status,source_type,source_id,created_by,posted_by,posted_at)
values
 ('ea800000-0000-4000-8000-000000000001','TAX-JE-SALE-001','2026-01-15','Tax report accounted sale fixture','publicada','order','ea300000-0000-4000-8000-000000000001','ea100000-0000-4000-8000-000000000001','ea100000-0000-4000-8000-000000000001',now()),
 ('ea800000-0000-4000-8000-000000000002','TAX-JE-PURCHASE-001','2026-01-15','Tax report accounted purchase fixture','publicada','accounts_payable','ea700000-0000-4000-8000-000000000001','ea100000-0000-4000-8000-000000000001','ea100000-0000-4000-8000-000000000001',now());
insert into public.financial_events(id,source_type,source_id,event_purpose,posting_version,status,journal_entry_id,created_by)
values
 ('ea900000-0000-4000-8000-000000000001','order','ea300000-0000-4000-8000-000000000001','sale_recognized','v2','posted','ea800000-0000-4000-8000-000000000001','ea100000-0000-4000-8000-000000000001'),
 ('ea900000-0000-4000-8000-000000000002','accounts_payable','ea700000-0000-4000-8000-000000000001','accounts_payable_created','v2','posted','ea800000-0000-4000-8000-000000000002','ea100000-0000-4000-8000-000000000001');
select results_eq(
  $$select sales_accounted_count,sales_pending_accounting_count,purchase_accounted_count,purchase_pending_accounting_count from public.get_accounting_tax_report_summary_v1('2026-01-01','2026-01-31')$$,
  $$values (1::bigint,0::bigint,1::bigint,0::bigint)$$,
  'posted events and journals are reported as accounted without changing tax'
);
select is(
  (select journal_entry_id from public.get_accounting_tax_report_documents_v1('sale','2026-01-01','2026-01-31',null,20,0) where document_id='ea400000-0000-4000-8000-000000000001'),
  'ea800000-0000-4000-8000-000000000001'::uuid,
  'accounted sale exposes its journal entry for traceability'
);
select is(
  (select accounting_status from public.get_accounting_tax_report_documents_v1('purchase','2026-01-01','2026-01-31',null,20,0) where document_id='ea500000-0000-4000-8000-000000000001'),
  'accounted',
  'accounted supplier invoice exposes its compact accounting state'
);

insert into public.orders(id,order_number,customer_name,phone,delivery_address,payment_method,price_mode,subtotal,tax,shipping_total,total,status,requested_invoice_date)
values ('eaa00000-0000-4000-8000-000000000001','TAX-REPORT-SALE-REVERSED','Cliente fixture','99990005','Local','cash','retail',0,0,0,0,'delivered','2026-01-16');
insert into public.invoices(id,order_id,invoice_number,status,price_mode,subtotal,tax,total,invoice_date,customer_name)
values ('eab00000-0000-4000-8000-000000000001','eaa00000-0000-4000-8000-000000000001','TAX-SALE-REVERSED','emitida','retail',0,0,0,'2026-01-16','Cliente fixture');
insert into public.journal_entries(id,entry_number,entry_date,description,status,source_type,source_id,created_by)
values ('eac00000-0000-4000-8000-000000000001','TAX-JE-REVERSED-001','2026-01-16','Tax report reversed sale fixture','reversada','order','eaa00000-0000-4000-8000-000000000001','ea100000-0000-4000-8000-000000000001');
insert into public.financial_events(id,source_type,source_id,event_purpose,posting_version,status,journal_entry_id,created_by)
values ('ead00000-0000-4000-8000-000000000001','order','eaa00000-0000-4000-8000-000000000001','sale_recognized','v2','reversed','eac00000-0000-4000-8000-000000000001','ea100000-0000-4000-8000-000000000001');
select results_eq(
  $$select sales_tax,sales_reversed_accounting_count from public.get_accounting_tax_report_summary_v1('2026-01-01','2026-01-31')$$,
  $$values (8529.12::numeric,1::bigint)$$,
  'reversed accounting is disclosed without duplicating or recalculating persisted tax'
);
select is(
  (select accounting_status from public.get_accounting_tax_report_documents_v1('sale','2026-01-01','2026-01-31','REVERSED',20,0) limit 1),
  'reversed',
  'reversed document state is exposed commercially'
);

insert into public.supplier_invoices(id,supplier_id,invoice_number,invoice_date,status,subtotal,tax_amount,total,currency)
select gen_random_uuid(),'ea200000-0000-4000-8000-000000000001','TAX-PAGE-' || lpad(value::text,3,'0'),'2026-01-17','received',0,0,0,'HNL'
from generate_series(1,100) value;
select is(
  (select total_count from public.get_accounting_tax_report_documents_v1('purchase','2026-01-01','2026-01-31',null,20,0) limit 1),
  101::bigint,
  'document pagination reports the full 100+ result count'
);
select is(
  (select count(*) from public.get_accounting_tax_report_documents_v1('purchase','2026-01-01','2026-01-31',null,20,0)),
  20::bigint,
  'first purchase page is limited to 20 documents'
);
select is(
  (select count(*) from public.get_accounting_tax_report_documents_v1('purchase','2026-01-01','2026-01-31',null,20,100)),
  1::bigint,
  'last purchase page returns the remaining document'
);
select is(
  (select count(*) from public.get_accounting_tax_report_documents_v1('purchase','2026-01-01','2026-01-31',null,50,0)),
  50::bigint,
  'page size 50 is supported server-side'
);
select results_eq(
  $$select purchase_tax,tax_difference,amount_to_pay from public.get_accounting_tax_report_summary_v1('2026-01-01','2026-01-31')$$,
  $$values (4509.52::numeric,4019.60::numeric,4019.60::numeric)$$,
  'pagination and search fixtures do not change the global fiscal summary'
);

select * from finish();
rollback;
\echo 'Accounting tax report read model: OK'
