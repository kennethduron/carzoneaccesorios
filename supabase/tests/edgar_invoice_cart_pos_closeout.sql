\set ON_ERROR_STOP on
begin;
select no_plan();

select has_column('public', 'orders', 'fiscal_customer_city', 'orders stores the prospective fiscal city snapshot');
select has_column('public', 'orders', 'fiscal_customer_business_name', 'orders stores the prospective fiscal business snapshot');
select has_column('public', 'orders', 'delivered_at', 'orders stores the server delivery timestamp');
select has_column('public', 'orders', 'delivered_by', 'orders stores the delivery actor');
select has_column('public', 'invoices', 'customer_city', 'invoices store the immutable customer city snapshot');
select has_column('public', 'invoices', 'customer_business_name', 'invoices store the immutable customer business snapshot');

select has_column('public', 'pos_sale_draft_items', 'line_position', 'POS draft lines store a stable user position');
select col_not_null('public', 'pos_sale_draft_items', 'line_position', 'POS line position is mandatory');
select ok(exists(select 1 from pg_constraint where conrelid='public.pos_sale_draft_items'::regclass and conname='pos_sale_draft_items_line_position_positive'), 'POS line position must be positive');
select ok(exists(select 1 from pg_constraint where conrelid='public.pos_sale_draft_items'::regclass and conname='pos_sale_draft_items_draft_line_position_key'), 'POS line position is unique within a draft');
select ok((select condeferrable from pg_constraint where conname='pos_sale_draft_items_draft_line_position_key'), 'line position uniqueness is deferrable for safe reordering');

select ok(to_regprocedure('public.assign_pos_draft_line_position_v1()') is not null, 'line position assignment trigger function exists');
select ok(to_regprocedure('public.build_pos_sale_draft_payload_pre_charges_v1(uuid)') is not null, 'ordered POS payload builder exists');
select ok(pg_get_functiondef('public.build_pos_sale_draft_payload_pre_charges_v1(uuid)'::regprocedure) like '%order by line.line_position%', 'POS payload is emitted in user order');
select ok(pg_get_functiondef('public.save_pos_sale_draft_v1(uuid,uuid,bigint,uuid,integer,jsonb,text,text,text,text,numeric,numeric,numeric)'::regprocedure) like '%with ordinality%', 'POS save derives order from input ordinality');
select ok(pg_get_functiondef('public.save_pos_sale_draft_v1(uuid,uuid,bigint,uuid,integer,jsonb,text,text,text,text,numeric,numeric,numeric)'::regprocedure) like '%save_pos_sale_draft_pre_line_position_v1%', 'POS save delegates economic validation to the certified implementation');
select ok(not has_function_privilege('authenticated','public.save_pos_sale_draft_pre_line_position_v1(uuid,uuid,bigint,uuid,integer,jsonb,text,text,text,text,numeric,numeric,numeric)','execute'), 'certified pre-wrapper save stays internal');

select ok((select permissions ? 'customers:merge' from public.roles where name='technical_owner'), 'technical owner can merge customers');
select ok((select permissions ? 'customers:merge' from public.roles where name='business_owner'), 'business owner can merge customers');
select ok(coalesce((select permissions ? 'customers:merge' from public.roles where name='admin'),true), 'admin can merge customers when the deployment has that role');
select ok(not coalesce((select permissions ? 'customers:merge' from public.roles where name='vendedor'),false), 'seller cannot merge customers');
select is((select enabled from public.customer_feature_flags where key='customer_merge_execution_v1'), false, 'customer merge execution remains OFF after installation');

select ok(to_regprocedure('public.pos_immediate_delivery_enabled_v1()') is not null, 'POS immediate delivery flag reader exists');
select ok(to_regprocedure('public.set_pos_immediate_delivery_v1(boolean,text)') is not null, 'POS immediate delivery flag setter exists');
select is((select enabled from public.pos_feature_flags where key='pos_immediate_delivery_v1'), false, 'POS immediate delivery installs OFF');
select ok(not has_table_privilege('authenticated','public.pos_feature_flags','update'), 'authenticated users cannot edit POS flags directly');
select ok((select prosecdef from pg_proc where oid='public.set_pos_immediate_delivery_v1(boolean,text)'::regprocedure), 'POS delivery setter is SECURITY DEFINER');
select ok((select array_to_string(proconfig, ',') like '%search_path=public, pg_temp%' from pg_proc where oid='public.set_pos_immediate_delivery_v1(boolean,text)'::regprocedure), 'POS delivery setter fixes its search path');

select ok(to_regprocedure('public.apply_pos_order_closeout_v1()') is not null, 'atomic POS closeout trigger function exists');
select ok(pg_get_functiondef('public.apply_pos_order_closeout_v1()'::regprocedure) like '%new.source::text <> ''pos''%', 'closeout is scoped to POS orders');
select ok(pg_get_functiondef('public.apply_pos_order_closeout_v1()'::regprocedure) like '%new.status := ''entregado''%', 'enabled closeout creates the order delivered');
select ok(pg_get_functiondef('public.apply_pos_order_closeout_v1()'::regprocedure) like '%new.delivered_by := new.created_by%', 'delivery actor comes from the atomic confirmation actor');
select ok(pg_get_functiondef('public.apply_pos_order_closeout_v1()'::regprocedure) like '%customer_record.contact_name%', 'fiscal name snapshots the customer contact name');
select ok(pg_get_functiondef('public.apply_pos_order_closeout_v1()'::regprocedure) like '%customer_record.business_name%', 'fiscal business snapshots independently');
select ok(pg_get_functiondef('public.apply_pos_order_closeout_v1()'::regprocedure) like '%customer_record.city%', 'fiscal city snapshots independently');

select ok(to_regprocedure('public.apply_order_customer_snapshot_to_invoice_v1()') is not null, 'invoice snapshot trigger function exists');
select ok(pg_get_functiondef('public.apply_order_customer_snapshot_to_invoice_v1()'::regprocedure) not like '%customers%', 'invoice snapshot never reads the live customer');
select ok(pg_get_functiondef('public.apply_order_customer_snapshot_to_invoice_v1()'::regprocedure) like '%fiscal_customer_city%', 'invoice copies city only from the order snapshot');
select ok(pg_get_functiondef('public.apply_order_customer_snapshot_to_invoice_v1()'::regprocedure) like '%fiscal_customer_business_name%', 'invoice copies business only from the order snapshot');

select ok(to_regprocedure('public.audit_pos_immediate_delivery_v1()') is not null, 'immediate delivery audit trigger exists');
select ok(pg_get_functiondef('public.audit_pos_immediate_delivery_v1()'::regprocedure) like '%economic_effects_added%', 'delivery audit explicitly records no extra economics');
select is((select count(*) from pg_trigger where tgrelid='public.orders'::regclass and tgname='orders_apply_pos_closeout_before_insert' and not tgisinternal), 1::bigint, 'POS closeout has one BEFORE INSERT trigger');
select is((select count(*) from pg_trigger where tgrelid='public.invoices'::regclass and tgname='invoices_apply_order_customer_snapshot_before_insert' and not tgisinternal), 1::bigint, 'invoice snapshots have one BEFORE INSERT trigger');
select is((select count(*) from pg_trigger where tgrelid='public.orders'::regclass and tgname='orders_audit_pos_immediate_delivery_after_insert' and not tgisinternal), 1::bigint, 'immediate delivery has one audit trigger');

select * from finish();
rollback;
\echo 'Edgar invoice/cart/POS closeout: OK'
