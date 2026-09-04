\set ON_ERROR_STOP on
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(24);

insert into public.roles(name,description,permissions) values
('admin','Phase 4 report math','["commissions:read_all","commissions:rules:manage","commissions:adjust","commissions:policies:manage","commercial:reports:read","commercial:reports:generate"]'),
('vendedor','Phase 4 report math','["commissions:read_own"]')
on conflict(name) do update set permissions=excluded.permissions;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('e4100000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase4-math-admin@example.test','',now(),'{}','{}',now(),now()),
('e4100000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase4-math-a@example.test','',now(),'{}','{}',now(),now()),
('e4100000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','phase4-math-b@example.test','',now(),'{}','{}',now(),now());
insert into public.users(id,role_id,full_name,email,active) values
('e4100000-0000-4000-8000-000000000001',(select id from public.roles where name='admin'),'Math Admin','phase4-math-admin@example.test',true),
('e4100000-0000-4000-8000-000000000002',(select id from public.roles where name='vendedor'),'Seller Math A','phase4-math-a@example.test',true),
('e4100000-0000-4000-8000-000000000003',(select id from public.roles where name='vendedor'),'Seller Math B','phase4-math-b@example.test',true)
on conflict(id) do update set role_id=excluded.role_id,full_name=excluded.full_name,active=true;
select set_config('request.jwt.claim.sub','e4100000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims','{"sub":"e4100000-0000-4000-8000-000000000001","role":"authenticated"}',true);

select public.create_sales_commission_rule_v1('e4200000-0000-4000-8000-000000000001','e4100000-0000-4000-8000-000000000002','PERCENTAGE',5,(now() at time zone 'America/Tegucigalpa')::date,'Regla porcentual para reconciliación.');
select public.create_sales_commission_rule_v1('e4200000-0000-4000-8000-000000000002','e4100000-0000-4000-8000-000000000003','FIXED_AMOUNT',250,(now() at time zone 'America/Tegucigalpa')::date,'Regla fija para reconciliación.');

insert into public.orders(id,order_number,customer_name,phone,customer_phone,delivery_address,payment_method,price_mode,subtotal,tax,shipping_total,shipping_fee,cash_on_delivery_fee,small_order_fee,total,status,source,channel,created_by,seller_id,seller_display_name_snapshot,confirmed_at) values
('e4300000-0000-4000-8000-000000000001','PH4-A','Cliente Uno','99991001','99991001','Local','cash','retail',1000,150,0,0,0,0,1150,'confirmed','manual','other','e4100000-0000-4000-8000-000000000001','e4100000-0000-4000-8000-000000000002','Seller Math A',now()),
('e4300000-0000-4000-8000-000000000002','PH4-B','Cliente Dos','99991002','99991002','Local','card','wholesale',2000,300,0,0,0,0,2300,'confirmed','manual','other','e4100000-0000-4000-8000-000000000001','e4100000-0000-4000-8000-000000000003','Seller Math B',now()),
('e4300000-0000-4000-8000-000000000003','PH4-WEB','Cliente Web','99991003','99991003','Local','bank_transfer','retail',500,75,0,0,0,0,575,'confirmed','web','website',null,null,null,now()),
('e4300000-0000-4000-8000-000000000004','PH4-CANCEL','Cliente Cancelado','99991004','99991004','Local','cash','retail',500,0,0,0,0,0,500,'cancelled','manual','other','e4100000-0000-4000-8000-000000000001','e4100000-0000-4000-8000-000000000002','Seller Math A',now()),
('e4300000-0000-4000-8000-000000000005','PH4-PREV','Cliente Anterior','99991005','99991005','Local','cash','retail',100,0,0,0,0,0,100,'confirmed','web','website',null,null,null,now()-interval '1 day');
insert into public.order_items(order_id,sku,product_name,quantity,applied_price_mode,unit_price,line_total,retail_price_snapshot,wholesale_price_snapshot,tax_category_snapshot,tax_rate_snapshot,taxable_base_snapshot,tax_amount_snapshot,exempt_amount_snapshot,tracks_inventory_snapshot) values
('e4300000-0000-4000-8000-000000000001','PH4-A','Producto A',1,'retail',1000,1000,1000,900,'standard',0.15,1000,150,0,false),
('e4300000-0000-4000-8000-000000000002','PH4-B','Producto B',1,'wholesale',2000,2000,2200,2000,'standard',0.15,2000,300,0,false);
select public.create_commission_for_confirmed_order_v1('e4300000-0000-4000-8000-000000000001');
select public.create_commission_for_confirmed_order_v1('e4300000-0000-4000-8000-000000000002');
insert into public.payments(id,order_id,method,status,amount,payment_method,payment_status,paid_at) values
('e4400000-0000-4000-8000-000000000001','e4300000-0000-4000-8000-000000000001','cash','approved',575,'cash','approved',now()),
('e4400000-0000-4000-8000-000000000002','e4300000-0000-4000-8000-000000000002','card','approved',2300,'card','approved',now());
select public.create_sales_commission_rule_v1('e4200000-0000-4000-8000-000000000003','e4100000-0000-4000-8000-000000000002','PERCENTAGE',7,((now() at time zone 'America/Tegucigalpa')::date+2),'Regla futura que no recalcula historia.');

create temp table phase4_report_state(key text primary key,value jsonb);
insert into phase4_report_state values
('global',public.get_commercial_dashboard_v1(jsonb_build_object('from',(now() at time zone 'America/Tegucigalpa')::date,'to',(now() at time zone 'America/Tegucigalpa')::date,'sellerId',null,'channel','all','customerType','all','paymentMethod','all','saleStatus','all','specialPrice','all','comparePrevious',true),20,0)),
('seller',public.get_commercial_dashboard_v1(jsonb_build_object('from',(now() at time zone 'America/Tegucigalpa')::date,'to',(now() at time zone 'America/Tegucigalpa')::date,'sellerId','e4100000-0000-4000-8000-000000000002','channel','all','customerType','all','paymentMethod','all','saleStatus','all','specialPrice','all','comparePrevious',false),20,0));

select is(((select value from phase4_report_state where key='global')->'kpis'->>'sales')::integer,3,'global valid sale count reconciles');
select is(((select value from phase4_report_state where key='global')->'kpis'->>'sold')::numeric,4025::numeric,'global sold amount reconciles');
select is(((select value from phase4_report_state where key='global')->'kpis'->>'collected')::numeric,2875::numeric,'canonical approved payments drive collected');
select is(((select value from phase4_report_state where key='global')->'kpis'->>'outstanding')::numeric,1150::numeric,'outstanding amount reconciles');
select is(((select value from phase4_report_state where key='global')->'kpis'->>'sold')::numeric,(((select value from phase4_report_state where key='global')->'kpis'->>'collected')::numeric+((select value from phase4_report_state where key='global')->'kpis'->>'outstanding')::numeric),'sold equals collected plus pending');
select is((select sum((item->>'amount')::numeric) from phase4_report_state s cross join jsonb_array_elements(s.value->'paymentMethods') item where s.key='global'),4025::numeric,'payment method distribution reconciles to sales');
select is((select sum((item->>'amount')::numeric) from phase4_report_state s cross join jsonb_array_elements(s.value->'customerTypes') item where s.key='global'),4025::numeric,'customer type distribution reconciles to sales');
select is((select sum((item->>'amount')::numeric) from phase4_report_state s cross join jsonb_array_elements(s.value->'channels') item where s.key='global'),4025::numeric,'channel distribution reconciles to sales');
select is(((select value from phase4_report_state where key='global')->'kpis'->>'cancelled')::integer,1,'cancelled sale count is separate');
select is(((select value from phase4_report_state where key='global')->'kpis'->>'cancelledAmount')::numeric,500::numeric,'cancelled amount is explicit');
select is(((select value from phase4_report_state where key='global')->>'totalSales')::integer,4,'paginated total includes matching cancelled row');
select is(((select value from phase4_report_state where key='global')->'previous'->>'sales')::integer,1,'previous-period comparison uses equal prior interval');
select is(((select value from phase4_report_state where key='global')->'previous'->>'sold')::numeric,100::numeric,'previous-period amount remains separate');
select is(((select value from phase4_report_state where key='seller')->'kpis'->>'sales')::integer,1,'seller scope includes only own valid sale');
select is(((select value from phase4_report_state where key='seller')->'kpis'->>'sold')::numeric,1150::numeric,'seller scope excludes other seller and web sale');
select is(jsonb_array_length((select value from phase4_report_state where key='seller')->'sellers'),1,'seller summary cannot leak another seller');
select is(((select value from phase4_report_state where key='seller')->'commissions'->>'potential')::numeric,50::numeric,'commission potential comes from Phase 3 ledger');
select is(((select value from phase4_report_state where key='seller')->'commissions'->>'earned')::numeric,25::numeric,'earned commission follows collected ratio');
select is(((select value from phase4_report_state where key='seller')->'commissions'->>'remaining')::numeric,25::numeric,'remaining commission reconciles');
select is(((select value from phase4_report_state where key='seller')->'sellerDetail'->'ruleHistory'->0->>'value')::numeric,7::numeric,'seller rule history exposes newest future version');
select is((select (sale->>'potential')::numeric from phase4_report_state s cross join jsonb_array_elements(s.value->'sales') sale where s.key='seller' and sale->>'orderNumber'='PH4-A'),50::numeric,'historical sale keeps confirmed five-percent snapshot');
select is(((select value from phase4_report_state where key='seller')->'sellerDetail'->>'attributionCorrections')::integer,0,'seller corrections are bounded to the period');
select is((select count(*)::integer from public.commercial_report_generations),0,'dashboard reads create no report or accounting side effects');
select is((select count(*)::integer from public.orders where id::text like 'e430%'),5,'dashboard reads do not mutate canonical orders');

select * from finish();
rollback;
\echo 'Sales commercial Phase 4 report math: OK'
