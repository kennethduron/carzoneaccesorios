\set ON_ERROR_STOP on
begin;
select plan(43);

select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claim.role','service_role',true);
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select throws_ok(
  $$select public.create_inventory_adjustment_v1('ad400000-0000-4000-8000-000000000001',current_date,null,null,'[]')$$,
  '42501','INVENTORY_ADJUSTMENT_FORBIDDEN','service role cannot invent an actor for a mutation'
);

insert into public.roles(name,description,permissions) values
('admin','Inventory validation','["inventory:adjust_read","inventory:adjust_create","inventory:adjust_confirm","inventory:adjust_reverse","inventory:cost_read"]'),
('bodega','Inventory validation','["inventory:adjust_read","inventory:adjust_create","inventory:adjust_confirm"]'),
('contadora','Inventory validation','["inventory:adjust_read","inventory:adjust_create","inventory:adjust_confirm","inventory:cost_read"]'),
('vendedor','Inventory validation','[]')
on conflict(name) do update set permissions=excluded.permissions;

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) values
('ad410000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','inventory-admin@example.test','',now(),'{}','{}',now(),now()),
('ad410000-0000-4000-8000-000000000002','00000000-0000-0000-0000-000000000000','authenticated','authenticated','inventory-bodega@example.test','',now(),'{}','{}',now(),now()),
('ad410000-0000-4000-8000-000000000003','00000000-0000-0000-0000-000000000000','authenticated','authenticated','inventory-contadora@example.test','',now(),'{}','{}',now(),now()),
('ad410000-0000-4000-8000-000000000004','00000000-0000-0000-0000-000000000000','authenticated','authenticated','inventory-vendedor@example.test','',now(),'{}','{}',now(),now());
insert into public.users(id,role_id,full_name,email,active) values
('ad410000-0000-4000-8000-000000000001',(select id from public.roles where name='admin'),'Inventory Admin','inventory-admin@example.test',true),
('ad410000-0000-4000-8000-000000000002',(select id from public.roles where name='bodega'),'Inventory Bodega','inventory-bodega@example.test',true),
('ad410000-0000-4000-8000-000000000003',(select id from public.roles where name='contadora'),'Inventory Contadora','inventory-contadora@example.test',true),
('ad410000-0000-4000-8000-000000000004',(select id from public.roles where name='vendedor'),'Inventory Vendedor','inventory-vendedor@example.test',true)
on conflict(id) do update set role_id=excluded.role_id,active=true;

select set_config('request.jwt.claim.sub','ad410000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims','{"sub":"ad410000-0000-4000-8000-000000000001","role":"authenticated"}',true);

insert into public.products(category_id,sku,slug,name,brand,stock,reserved_stock,retail_price,wholesale_price,cost_price)
select (select id from public.categories where slug='exterior'),
  'INV-ADJ-VALID-'||lpad(g::text,3,'0'),'inv-adj-valid-'||lpad(g::text,3,'0'),
  'INVENTORY-ADJUSTMENT-VALIDATION-LOCAL-ONLY '||g,'Fixture',10,
  case when g=10 then 10 else 0 end,200,180,100
from generate_series(1,10) g;

select throws_ok($$select public.create_inventory_adjustment_v1('ad420000-0000-4000-8000-000000000001',current_date,null,null,
  jsonb_build_array(jsonb_build_object('product_id',(select id from public.products where sku='INV-ADJ-VALID-001'),'direction','increase','quantity',0,'reason_code','physical_count_surplus')))$$,
  '22023','INVENTORY_ADJUSTMENT_INVALID_LINES','zero quantity is rejected');
select throws_ok($$select public.create_inventory_adjustment_v1('ad420000-0000-4000-8000-000000000002',current_date,null,null,
  jsonb_build_array(jsonb_build_object('product_id',(select id from public.products where sku='INV-ADJ-VALID-001'),'direction','increase','quantity',1.5,'reason_code','physical_count_surplus')))$$,
  '22023','INVENTORY_ADJUSTMENT_INVALID_LINES','fractional quantity is rejected');
select throws_ok($$select public.create_inventory_adjustment_v1('ad420000-0000-4000-8000-000000000003',current_date,null,null,
  jsonb_build_array(jsonb_build_object('product_id',(select id from public.products where sku='INV-ADJ-VALID-001'),'direction','increase','quantity',1000001,'reason_code','physical_count_surplus')))$$,
  '22023','INVENTORY_ADJUSTMENT_INVALID_LINES','overflow quantity is rejected');
select throws_ok($$select public.create_inventory_adjustment_v1('ad420000-0000-4000-8000-000000000004',current_date,null,null,
  jsonb_build_array(
    jsonb_build_object('product_id',(select id from public.products where sku='INV-ADJ-VALID-001'),'direction','increase','quantity',1,'reason_code','physical_count_surplus'),
    jsonb_build_object('product_id',(select id from public.products where sku='INV-ADJ-VALID-001'),'direction','increase','quantity',1,'reason_code','physical_count_surplus')))$$,
  '23505','INVENTORY_ADJUSTMENT_DUPLICATE_PRODUCT','duplicate product is rejected');
select is((select count(*)::integer from public.inventory_adjustments),0,'invalid drafts leave no document');

select lives_ok($$select public.create_inventory_adjustment_v1('ad430000-0000-4000-8000-000000000001',current_date,'TEN-LINES',null,
  (select jsonb_agg(jsonb_build_object('product_id',id,'direction','increase','quantity',1,'reason_code','physical_count_surplus') order by id)
   from public.products where sku like 'INV-ADJ-VALID-%'))$$,'ten-line draft succeeds');
select is((select count(*)::integer from public.inventory_adjustment_lines where adjustment_id=(select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000001')),10,'ten unique lines are stored');
select lives_ok($$select public.confirm_inventory_adjustment_v1((select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000001'),1,'ad430000-0000-4000-8000-000000000001')$$,'ten-line confirmation succeeds');
select is((select count(*)::integer from public.inventory_movements where reference_id=(select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000001')),10,'ten movements are inserted');
select is((select sum(stock)::integer from public.products where sku like 'INV-ADJ-VALID-%'),110,'all ten product stocks change once');
select lives_ok($$select public.confirm_inventory_adjustment_v1((select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000001'),1,'ad430000-0000-4000-8000-000000000001')$$,'idempotent retry one succeeds');
select lives_ok($$select public.confirm_inventory_adjustment_v1((select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000001'),1,'ad430000-0000-4000-8000-000000000001')$$,'idempotent retry two succeeds');
select lives_ok($$select public.confirm_inventory_adjustment_v1((select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000001'),1,'ad430000-0000-4000-8000-000000000001')$$,'idempotent retry three succeeds');
select lives_ok($$select public.confirm_inventory_adjustment_v1((select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000001'),1,'ad430000-0000-4000-8000-000000000001')$$,'idempotent retry four succeeds');
select lives_ok($$select public.confirm_inventory_adjustment_v1((select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000001'),1,'ad430000-0000-4000-8000-000000000001')$$,'idempotent retry five succeeds');
select is((select count(*)::integer from public.inventory_movements where reference_id=(select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000001')),10,'five retries create no duplicate movements');

select lives_ok($$select public.create_inventory_adjustment_v1('ad430000-0000-4000-8000-000000000002',current_date,'ATOMIC-FAIL',null,
  (select jsonb_agg(jsonb_build_object('product_id',id,'direction',case when sku='INV-ADJ-VALID-010' then 'decrease' else 'increase' end,
    'quantity',case when sku='INV-ADJ-VALID-010' then 2 else 1 end,
    'reason_code',case when sku='INV-ADJ-VALID-010' then 'physical_count_shortage' else 'physical_count_surplus' end) order by id)
   from public.products where sku like 'INV-ADJ-VALID-%'))$$,'atomic-failure draft succeeds');
select throws_ok($$select public.confirm_inventory_adjustment_v1((select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000002'),1,'ad430000-0000-4000-8000-000000000002')$$,
  '23514','INVENTORY_ADJUSTMENT_RESERVED_STOCK_CONFLICT','one invalid line rolls back the whole confirmation');
select is((select status from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000002'),'draft','failed document remains a draft');
select is((select sum(stock)::integer from public.products where sku like 'INV-ADJ-VALID-%'),110,'atomic failure changes no stock');
select is((select count(*)::integer from public.inventory_movements where reference_id=(select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000002')),0,'atomic failure inserts no movements');
select is((select count(*)::integer from public.audit_logs where action='inventory.adjustment.confirmed' and record_id=(select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000002')),0,'atomic failure inserts no confirmation audit');

select set_config('request.jwt.claim.sub','ad410000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"ad410000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select ok(not ((public.search_inventory_adjustment_products_v1('INV-ADJ-VALID-001',1)->0) ? 'cost_price'),'bodega product search masks cost');
select ok(not (public.get_inventory_adjustment_v1((select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000001')) ? 'total_cost'),'bodega document masks total cost');
select throws_ok($$select public.create_inventory_adjustment_v1('ad440000-0000-4000-8000-000000000001',current_date,null,null,
  jsonb_build_array(jsonb_build_object('product_id',(select id from public.products where sku='INV-ADJ-VALID-001'),'direction','increase','quantity',1,'reason_code','physical_count_surplus','unit_cost',123)))$$,
  '42501','INVENTORY_ADJUSTMENT_COST_FORBIDDEN','bodega cannot submit cost');
select throws_ok($$select public.reverse_inventory_adjustment_v1((select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000001'),'ad440000-0000-4000-8000-000000000002')$$,
  '42501','INVENTORY_ADJUSTMENT_REVERSE_FORBIDDEN','bodega cannot reverse');

select set_config('request.jwt.claim.sub','ad410000-0000-4000-8000-000000000003',true);
select set_config('request.jwt.claims','{"sub":"ad410000-0000-4000-8000-000000000003","role":"authenticated"}',true);
select ok((public.search_inventory_adjustment_products_v1('INV-ADJ-VALID-001',1)->0) ? 'cost_price','contadora sees cost');
select lives_ok($$select public.create_inventory_adjustment_v1('ad450000-0000-4000-8000-000000000001',current_date,'COST-SNAPSHOT',null,
  jsonb_build_array(jsonb_build_object('product_id',(select id from public.products where sku='INV-ADJ-VALID-001'),'direction','increase','quantity',1,'reason_code','physical_count_surplus','unit_cost',123)))$$,'contadora can create with authorized cost');
select lives_ok($$select public.confirm_inventory_adjustment_v1((select id from public.inventory_adjustments where request_key='ad450000-0000-4000-8000-000000000001'),1,'ad450000-0000-4000-8000-000000000001')$$,'contadora can confirm');
select is((select unit_cost_snapshot from public.inventory_adjustment_lines where adjustment_id=(select id from public.inventory_adjustments where request_key='ad450000-0000-4000-8000-000000000001')),123.00::numeric,'authorized cost is snapshotted');
select is((select cost_price from public.products where sku='INV-ADJ-VALID-001'),100.00::numeric,'adjustment never changes master cost');
select throws_ok($$select public.reverse_inventory_adjustment_v1((select id from public.inventory_adjustments where request_key='ad450000-0000-4000-8000-000000000001'),'ad450000-0000-4000-8000-000000000002')$$,
  '42501','INVENTORY_ADJUSTMENT_REVERSE_FORBIDDEN','contadora cannot reverse');

select set_config('request.jwt.claim.sub','ad410000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"ad410000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select lives_ok($$select public.create_inventory_adjustment_v1('ad460000-0000-4000-8000-000000000001',current_date,'PRIVATE-IDEMPOTENCY',null,
  jsonb_build_array(jsonb_build_object('product_id',(select id from public.products where sku='INV-ADJ-VALID-002'),'direction','increase','quantity',1,'reason_code','physical_count_surplus')))$$,'admin creates an idempotent draft');
select set_config('request.jwt.claim.sub','ad410000-0000-4000-8000-000000000002',true);
select set_config('request.jwt.claims','{"sub":"ad410000-0000-4000-8000-000000000002","role":"authenticated"}',true);
select throws_ok($$select public.create_inventory_adjustment_v1('ad460000-0000-4000-8000-000000000001',current_date,'PRIVATE-IDEMPOTENCY',null,
  jsonb_build_array(jsonb_build_object('product_id',(select id from public.products where sku='INV-ADJ-VALID-002'),'direction','increase','quantity',1,'reason_code','physical_count_surplus')))$$,
  '42501','INVENTORY_ADJUSTMENT_IDEMPOTENCY_FORBIDDEN','another actor cannot probe an idempotency key');

select set_config('request.jwt.claim.sub','ad410000-0000-4000-8000-000000000004',true);
select set_config('request.jwt.claims','{"sub":"ad410000-0000-4000-8000-000000000004","role":"authenticated"}',true);
select throws_ok($$select public.list_inventory_adjustments_v1()$$,'42501','INVENTORY_ADJUSTMENT_FORBIDDEN','vendedor cannot read adjustment history');

select set_config('request.jwt.claim.sub','ad410000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claims','{"sub":"ad410000-0000-4000-8000-000000000001","role":"authenticated"}',true);
select throws_ok($$update public.inventory_adjustments set reference='tampered' where request_key='ad430000-0000-4000-8000-000000000001'$$,
  '42501','INVENTORY_ADJUSTMENT_IMMUTABLE','confirmed header is immutable');
select throws_ok($$delete from public.inventory_adjustment_lines where adjustment_id=(select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000001')$$,
  '42501','INVENTORY_ADJUSTMENT_IMMUTABLE','confirmed lines cannot be deleted');
select throws_ok($$update public.inventory_movements set notes='tampered' where reference_id=(select id from public.inventory_adjustments where request_key='ad430000-0000-4000-8000-000000000001')$$,
  '42501','INVENTORY_ADJUSTMENT_MOVEMENT_IMMUTABLE','confirmed movements cannot be updated');
select is((select count(*)::integer from public.financial_events where source_type like 'inventory_adjustment%'),0,'pending mapping creates no financial events');
select is((select count(*)::integer from public.accounting_outbox_v2 where source_type like 'inventory_adjustment%'),0,'pending mapping creates no accounting outbox rows');
select is((select count(*)::integer from public.journal_entries),0,'pending mapping creates no journal entries');
select is((select count(*)::integer from public.inventory_adjustments where request_key='ad460000-0000-4000-8000-000000000001'),1,'idempotency key still identifies exactly one draft');

select * from finish();
rollback;
