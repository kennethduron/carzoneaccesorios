\set ON_ERROR_STOP on
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(52);

select ok(to_regclass('public.sales_commission_rules') is not null, 'versioned commission rules table exists');
select ok(to_regclass('public.sales_commission_entries') is not null, 'commission entries table exists');
select ok(to_regclass('public.sales_commission_events') is not null, 'append-only commission events table exists');
select ok((select relrowsecurity from pg_class where oid='public.sales_commission_rules'::regclass), 'rules use RLS');
select ok((select relrowsecurity from pg_class where oid='public.sales_commission_entries'::regclass), 'entries use RLS');
select ok((select relrowsecurity from pg_class where oid='public.sales_commission_events'::regclass), 'events use RLS');
select ok(not has_table_privilege('authenticated','public.sales_commission_entries','insert'), 'authenticated cannot insert ledger rows directly');
select ok(not has_table_privilege('authenticated','public.sales_commission_entries','update'), 'authenticated cannot update ledger rows directly');
select ok(not has_table_privilege('authenticated','public.sales_commission_events','delete'), 'authenticated cannot delete events');
select ok(not has_function_privilege('anon','public.create_sales_commission_rule_v1(uuid,uuid,text,numeric,date,text)','execute'), 'anonymous rule mutation is denied');
select ok(not has_function_privilege('anon','public.adjust_sales_commission_v1(uuid,uuid,numeric,text)','execute'), 'anonymous adjustment is denied');
select ok(to_regclass('public.sales_commission_entries_active_order_idx') is not null, 'one-active-entry index exists');
select ok(to_regclass('public.orders_source_seller_created_idx') is not null, 'seller workspace order index exists');

insert into public.roles(name,description,permissions) values
('admin','Phase 3 local test','["commissions:read_all","commissions:rules:manage","commissions:adjust"]'),
('vendedor','Phase 3 local test','["sales:seller_dashboard:read_own","commissions:read_own"]'),
('contadora','Phase 3 local test','[]'),
('bodega','Phase 3 local test','[]'),
('soporte','Phase 3 local test','[]'),
('cliente','Phase 3 local test','[]')
on conflict(name) do update set permissions=excluded.permissions;

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('c3100000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase3-admin@example.test','',now(),'{}','{}',now(),now()),
('c3100000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase3-seller-a@example.test','',now(),'{}','{}',now(),now()),
('c3100000-0000-4000-8000-000000000003','00000000-0000-0000-8000-000000000000','authenticated','authenticated','phase3-seller-b@example.test','',now(),'{}','{}',now(),now()),
('c3100000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase3-seller-no-rule@example.test','',now(),'{}','{}',now(),now()),
('c3100000-0000-4000-8000-000000000005','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase3-contadora@example.test','',now(),'{}','{}',now(),now()),
('c3100000-0000-4000-8000-000000000006','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase3-bodega@example.test','',now(),'{}','{}',now(),now()),
('c3100000-0000-4000-8000-000000000007','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase3-soporte@example.test','',now(),'{}','{}',now(),now()),
('c3100000-0000-4000-8000-000000000008','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase3-cliente@example.test','',now(),'{}','{}',now(),now());

insert into public.users(id,role_id,full_name,email,active) values
('c3100000-0000-4000-8000-000000000001',(select id from public.roles where name='admin'),'Phase 3 Admin','phase3-admin@example.test',true),
('c3100000-0000-4000-8000-000000000002',(select id from public.roles where name='vendedor'),'Seller A','phase3-seller-a@example.test',true),
('c3100000-0000-4000-8000-000000000003',(select id from public.roles where name='vendedor'),'Seller B','phase3-seller-b@example.test',true),
('c3100000-0000-4000-8000-000000000004',(select id from public.roles where name='vendedor'),'Seller No Rule','phase3-seller-no-rule@example.test',true),
('c3100000-0000-4000-8000-000000000005',(select id from public.roles where name='contadora'),'Phase 3 Contadora','phase3-contadora@example.test',true),
('c3100000-0000-4000-8000-000000000006',(select id from public.roles where name='bodega'),'Phase 3 Bodega','phase3-bodega@example.test',true),
('c3100000-0000-4000-8000-000000000007',(select id from public.roles where name='soporte'),'Phase 3 Soporte','phase3-soporte@example.test',true),
('c3100000-0000-4000-8000-000000000008',(select id from public.roles where name='cliente'),'Phase 3 Cliente','phase3-cliente@example.test',true)
on conflict(id) do update set role_id=excluded.role_id,active=true;

select set_config('request.jwt.claim.sub','c3100000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims','{"sub":"c3100000-0000-4000-8000-000000000001","role":"authenticated"}',true);

select lives_ok($$select public.create_sales_commission_rule_v1('c3200000-0000-4000-8000-000000000001','c3100000-0000-4000-8000-000000000002','PERCENTAGE',5,(now() at time zone 'America/Tegucigalpa')::date,'Regla inicial de cinco por ciento.')$$, 'admin creates current percentage rule');
select is((select version from public.sales_commission_rules where seller_user_id='c3100000-0000-4000-8000-000000000002'),1,'first rule is version one');
select is((public.create_sales_commission_rule_v1('c3200000-0000-4000-8000-000000000001','c3100000-0000-4000-8000-000000000002','PERCENTAGE',5,(now() at time zone 'America/Tegucigalpa')::date,'Regla inicial de cinco por ciento.')->>'idempotentReplay')::boolean,true,'rule retry is idempotent');
select throws_ok($$select public.create_sales_commission_rule_v1('c3200000-0000-4000-8000-000000000002','c3100000-0000-4000-8000-000000000002','PERCENTAGE',7,((now() at time zone 'America/Tegucigalpa')::date-1),'Cambio retroactivo no permitido.')$$,'22023','COMMISSION_RULE_EFFECTIVE_DATE_INVALID','past rule is rejected');
select lives_ok($$select public.create_sales_commission_rule_v1('c3200000-0000-4000-8000-000000000003','c3100000-0000-4000-8000-000000000002','PERCENTAGE',7,((now() at time zone 'America/Tegucigalpa')::date+2),'Nueva regla futura de siete por ciento.')$$,'future 7 percent rule is scheduled');
select is((select count(*)::integer from public.sales_commission_rules where seller_user_id='c3100000-0000-4000-8000-000000000002'),2,'5 to 7 percent versions coexist');
select ok((select effective_to=lead(effective_from) over(order by version) from public.sales_commission_rules where seller_user_id='c3100000-0000-4000-8000-000000000002' order by version limit 1),'prior rule closes exactly at future boundary');
select throws_ok($$select public.create_sales_commission_rule_v1('c3200000-0000-4000-8000-000000000004','c3100000-0000-4000-8000-000000000002','PERCENTAGE',8,((now() at time zone 'America/Tegucigalpa')::date+3),'Segunda regla futura prohibida.')$$,'PT409','COMMISSION_RULE_FUTURE_ALREADY_EXISTS','second future rule is rejected');
select lives_ok($$select public.create_sales_commission_rule_v1('c3200000-0000-4000-8000-000000000005','c3100000-0000-4000-8000-000000000003','FIXED_AMOUNT',250,(now() at time zone 'America/Tegucigalpa')::date,'Regla fija de prueba para ventas.')$$,'fixed amount rule is supported');

insert into public.orders(id,order_number,customer_name,phone,customer_phone,delivery_address,payment_method,price_mode,subtotal,tax,shipping_total,shipping_fee,cash_on_delivery_fee,small_order_fee,total,status,source,channel,created_by,seller_id,seller_display_name_snapshot,confirmed_at) values
('c3300000-0000-4000-8000-000000000001','PH3-PERCENT','Cliente Porcentaje','99990001','99990001','Local','cash','retail',10000,1500,300,300,50,100,11950,'confirmed','manual','other','c3100000-0000-4000-8000-000000000001','c3100000-0000-4000-8000-000000000002','Seller A',now()),
('c3300000-0000-4000-8000-000000000002','PH3-FIXED','Cliente Fijo','99990002','99990002','Local','cash','retail',10000,1500,0,0,0,0,11500,'confirmed','manual','other','c3100000-0000-4000-8000-000000000001','c3100000-0000-4000-8000-000000000003','Seller B',now()),
('c3300000-0000-4000-8000-000000000003','PH3-NORULE','Cliente Sin Regla','99990003','99990003','Local','cash','retail',1000,150,0,0,0,0,1150,'confirmed','manual','other','c3100000-0000-4000-8000-000000000001','c3100000-0000-4000-8000-000000000004','Seller No Rule',now()),
('c3300000-0000-4000-8000-000000000004','PH3-WEB','Cliente Web','99990004','99990004','Local','cash','retail',1000,150,0,0,0,0,1150,'confirmed','web','website',null,null,null,now());

insert into public.order_items(order_id,sku,product_name,quantity,applied_price_mode,unit_price,line_total,retail_price_snapshot,wholesale_price_snapshot,tax_category_snapshot,tax_rate_snapshot,taxable_base_snapshot,tax_amount_snapshot,exempt_amount_snapshot,price_override_reason,price_overridden_by,tracks_inventory_snapshot) values
('c3300000-0000-4000-8000-000000000001','PH3-SPECIAL','Precio especial',1,'retail',10000,10000,10500,9500,'standard',0.15,10000,1500,0,'Precio especial autorizado','c3100000-0000-4000-8000-000000000001',false),
('c3300000-0000-4000-8000-000000000002','PH3-FIXED','Producto fijo',1,'retail',10000,10000,10000,9000,'standard',0.15,10000,1500,0,null,null,false),
('c3300000-0000-4000-8000-000000000003','PH3-NORULE','Producto sin regla',1,'retail',1000,1000,1000,900,'standard',0.15,1000,150,0,null,null,false),
('c3300000-0000-4000-8000-000000000004','PH3-WEB','Producto web',1,'retail',1000,1000,1000,900,'standard',0.15,1000,150,0,null,null,false);

select lives_ok($$select public.create_commission_for_confirmed_order_v1('c3300000-0000-4000-8000-000000000001')$$,'percentage commission accrues');
select is((select eligible_base_amount from public.sales_commission_entries where order_id='c3300000-0000-4000-8000-000000000001'),10000.00::numeric,'eligible base excludes ISV and every added charge');
select is((select potential_amount from public.sales_commission_entries where order_id='c3300000-0000-4000-8000-000000000001'),500.00::numeric,'5 percent potential uses special final merchandise price');
select lives_ok($$select public.create_commission_for_confirmed_order_v1('c3300000-0000-4000-8000-000000000001')$$,'commission creation replay succeeds');
select is((select count(*)::integer from public.sales_commission_entries where order_id='c3300000-0000-4000-8000-000000000001'),1,'order has exactly one active commission after retry');

insert into public.payments(id,order_id,method,status,amount,payment_method,payment_status,paid_at) values('c3400000-0000-4000-8000-000000000001','c3300000-0000-4000-8000-000000000001','cash','approved',5975,'cash','approved',now());
select is((select earned_amount from public.sales_commission_entries where order_id='c3300000-0000-4000-8000-000000000001'),250.00::numeric,'half collection earns half percentage commission');
select is((select status from public.sales_commission_entries where order_id='c3300000-0000-4000-8000-000000000001'),'PARTIALLY_EARNED','partial collection has explicit status');
insert into public.payments(id,order_id,method,status,amount,payment_method,payment_status,paid_at) values('c3400000-0000-4000-8000-000000000002','c3300000-0000-4000-8000-000000000001','cash','approved',5975,'cash','approved',now());
select is((select earned_amount from public.sales_commission_entries where order_id='c3300000-0000-4000-8000-000000000001'),500.00::numeric,'full collection earns full percentage commission');
select is((select status from public.sales_commission_entries where order_id='c3300000-0000-4000-8000-000000000001'),'EARNED','full collection has earned status');
update public.payments set status='refunded',payment_status='refunded' where id='c3400000-0000-4000-8000-000000000002';
select is((select earned_amount from public.sales_commission_entries where order_id='c3300000-0000-4000-8000-000000000001'),250.00::numeric,'payment reversal reduces earned commission deterministically');

select lives_ok($$select public.create_commission_for_confirmed_order_v1('c3300000-0000-4000-8000-000000000002')$$,'fixed commission accrues');
select is((select potential_amount from public.sales_commission_entries where order_id='c3300000-0000-4000-8000-000000000002'),250.00::numeric,'fixed rule creates fixed potential');
insert into public.payments(id,order_id,method,status,amount,payment_method,payment_status,paid_at) values('c3400000-0000-4000-8000-000000000003','c3300000-0000-4000-8000-000000000002','cash','approved',5750,'cash','approved',now());
select is((select earned_amount from public.sales_commission_entries where order_id='c3300000-0000-4000-8000-000000000002'),125.00::numeric,'fixed commission also earns proportionally');
select is((public.adjust_sales_commission_v1('c3500000-0000-4000-8000-000000000001',(select id from public.sales_commission_entries where order_id='c3300000-0000-4000-8000-000000000002'),25,'Ajuste auditado por diferencia documentada.')->>'earnedAmount')::numeric,150.00::numeric,'manual adjustment changes earned total within bounds');
select is((public.adjust_sales_commission_v1('c3500000-0000-4000-8000-000000000001',(select id from public.sales_commission_entries where order_id='c3300000-0000-4000-8000-000000000002'),25,'Ajuste auditado por diferencia documentada.')->>'idempotentReplay')::boolean,true,'manual adjustment retry is idempotent');
select set_config('app.commission_internal','off',true);
select throws_ok($$update public.sales_commission_events set reason='tampered' where commission_entry_id=(select id from public.sales_commission_entries where order_id='c3300000-0000-4000-8000-000000000002')$$,'42501','COMMISSION_LEDGER_IMMUTABLE','event history is append-only');
select throws_ok($$update public.sales_commission_rules set rule_value=99 where request_key='c3200000-0000-4000-8000-000000000001'$$,'42501','COMMISSION_LEDGER_IMMUTABLE','historical rule economics are immutable');

select is(public.create_commission_for_confirmed_order_v1('c3300000-0000-4000-8000-000000000003'),null::uuid,'seller without a rule gets no commission');
select is(public.create_commission_for_confirmed_order_v1('c3300000-0000-4000-8000-000000000004'),null::uuid,'web order without seller gets no commission');
update public.orders set status='cancelled',commercial_reversal_reason='Cancelación local de prueba.' where id='c3300000-0000-4000-8000-000000000001';
select is((select status from public.sales_commission_entries where order_id='c3300000-0000-4000-8000-000000000001'),'REVERSED','cancellation after earning reverses the commission');
select is((select reversed_amount from public.sales_commission_entries where order_id='c3300000-0000-4000-8000-000000000001'),250.00::numeric,'reversed amount preserves the previously earned value');

select set_config('request.jwt.claim.sub','c3100000-0000-4000-8000-000000000005',true);
select set_config('request.jwt.claims','{"sub":"c3100000-0000-4000-8000-000000000005","role":"authenticated"}',true);
select throws_ok($$select public.create_sales_commission_rule_v1('c3200000-0000-4000-8000-000000000006','c3100000-0000-4000-8000-000000000003','PERCENTAGE',9,(now() at time zone 'America/Tegucigalpa')::date,'Intento no autorizado de contadora.')$$,'42501','COMMISSION_ACCESS_DENIED','contadora cannot manage rules');
select throws_ok($$select public.adjust_sales_commission_v1('c3500000-0000-4000-8000-000000000002',(select id from public.sales_commission_entries limit 1),1,'Intento no autorizado de ajuste.')$$,'42501','COMMISSION_ACCESS_DENIED','contadora cannot adjust commissions');

set local role authenticated;
select set_config('request.jwt.claim.sub','c3100000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"c3100000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select is((select count(*)::integer from public.sales_commission_entries),1,'seller RLS exposes only own commission rows');
select is((select count(*)::integer from public.sales_commission_entries where seller_id='c3100000-0000-4000-8000-000000000003'),0,'seller RLS hides another seller');
select throws_ok($$select public.adjust_sales_commission_v1('c3500000-0000-4000-8000-000000000003',(select id from public.sales_commission_entries limit 1),1,'Intento no autorizado de vendedor.')$$,'42501','COMMISSION_ACCESS_DENIED','seller cannot adjust own commission');
select set_config('request.jwt.claim.sub','c3100000-0000-4000-8000-000000000005',true);
select set_config('request.jwt.claims','{"sub":"c3100000-0000-4000-8000-000000000005","role":"authenticated"}',true);
select ok(not public.commission_permission_allowed('commissions:read_all'),'contadora has no commission authority');
select set_config('request.jwt.claim.sub','c3100000-0000-4000-8000-000000000006',true);
select set_config('request.jwt.claims','{"sub":"c3100000-0000-4000-8000-000000000006","role":"authenticated"}',true);
select ok(not public.commission_permission_allowed('commissions:read_all'),'bodega has no commission authority');
select set_config('request.jwt.claim.sub','c3100000-0000-4000-8000-000000000007',true);
select set_config('request.jwt.claims','{"sub":"c3100000-0000-4000-8000-000000000007","role":"authenticated"}',true);
select ok(not public.commission_permission_allowed('commissions:read_all'),'soporte has no commission authority');
select set_config('request.jwt.claim.sub','c3100000-0000-4000-8000-000000000008',true);
select set_config('request.jwt.claims','{"sub":"c3100000-0000-4000-8000-000000000008","role":"authenticated"}',true);
select ok(not public.commission_permission_allowed('commissions:read_all'),'cliente has no commission authority');
reset role;

select * from finish();
rollback;
\echo 'Sales commercial Phase 3 commissions: OK'
