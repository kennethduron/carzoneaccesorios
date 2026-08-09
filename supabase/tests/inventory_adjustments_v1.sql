\set ON_ERROR_STOP on
begin;
select plan(43);

select has_table('public','inventory_adjustments','adjustment header exists');
select has_table('public','inventory_adjustment_lines','adjustment lines exist');
select has_column('public','inventory_adjustments','adjustment_number','database number exists');
select has_column('public','inventory_adjustments','accounting_status','accounting state exists');
select has_column('public','inventory_adjustment_lines','reserved_before','reservation snapshot exists');
select has_column('public','inventory_adjustment_lines','unit_cost_snapshot','cost snapshot exists');
select ok(to_regclass('public.inventory_adjustments_reversal_once_idx') is not null,'only one full reversal is indexed');
select ok(exists(select 1 from pg_constraint where conname='products_stock_not_below_reserved_stock'),'global stock/reservation constraint exists');
select ok(to_regprocedure('public.confirm_inventory_adjustment_v1(uuid,integer,uuid)') is not null,'confirm RPC exists');
select ok(to_regprocedure('public.reverse_inventory_adjustment_v1(uuid,uuid)') is not null,'reverse RPC exists');
select ok((select prosecdef from pg_proc where oid='public.confirm_inventory_adjustment_v1(uuid,integer,uuid)'::regprocedure),'confirm is security definer');
select ok(not has_function_privilege('anon','public.confirm_inventory_adjustment_v1(uuid,integer,uuid)','execute'),'anon cannot confirm');
select ok(has_function_privilege('authenticated','public.confirm_inventory_adjustment_v1(uuid,integer,uuid)','execute'),'authenticated has guarded execute');
select ok(not has_table_privilege('authenticated','public.inventory_adjustments','insert'),'authenticated cannot insert documents directly');
select ok(not has_table_privilege('authenticated','public.inventory_adjustment_lines','update'),'authenticated cannot update lines directly');
select ok(not has_table_privilege('authenticated','public.inventory_movements','truncate'),'authenticated cannot truncate movements');
select ok(not has_table_privilege('anon','public.inventory_movements','truncate'),'anon cannot truncate movements');

insert into public.roles(name,description,permissions) values
('admin','Local inventory adjustment role','["inventory:adjust_read","inventory:adjust_create","inventory:adjust_confirm","inventory:adjust_reverse","inventory:cost_read"]'),
('bodega','Local inventory adjustment role','["inventory:adjust_read","inventory:adjust_create","inventory:adjust_confirm"]'),
('contadora','Local inventory adjustment role','["inventory:adjust_read","inventory:adjust_create","inventory:adjust_confirm","inventory:cost_read"]')
on conflict(name) do update set permissions=excluded.permissions;
select ok((select permissions ?& array['inventory:adjust_read','inventory:adjust_create','inventory:adjust_confirm'] from public.roles where name='contadora'),'accountant can read create and confirm');
select ok(not (select permissions ? 'inventory:adjust_reverse' from public.roles where name='contadora'),'accountant cannot reverse');
select ok((select permissions ? 'inventory:adjust_reverse' from public.roles where name='admin'),'admin can reverse');
select ok(not (select permissions ? 'inventory:cost_read' from public.roles where name='bodega'),'warehouse role does not receive cost');

insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ('ad100000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','inventory-adjustment@example.test','',now(),'{}','{}',now(),now());
insert into public.users(id,role_id,full_name,email,active)
values ('ad100000-0000-4000-8000-000000000001',(select id from public.roles where name='admin'),'INVENTORY-ADJUSTMENT-IMPLEMENTATION-LOCAL-ONLY','inventory-adjustment@example.test',true)
on conflict(id) do update set role_id=excluded.role_id,active=true;
select set_config('request.jwt.claim.sub','ad100000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims','{"sub":"ad100000-0000-4000-8000-000000000001","role":"authenticated"}',true);

insert into public.products(category_id,sku,slug,name,brand,stock,reserved_stock,retail_price,wholesale_price,cost_price)
values
((select id from public.categories where slug='exterior'),'INV-ADJ-LOCAL-001','inv-adj-local-001','INVENTORY-ADJUSTMENT-IMPLEMENTATION-LOCAL-ONLY A','Fixture',10,4,200,180,100),
((select id from public.categories where slug='exterior'),'INV-ADJ-LOCAL-002','inv-adj-local-002','INVENTORY-ADJUSTMENT-IMPLEMENTATION-LOCAL-ONLY B','Fixture',8,0,200,180,80);

select throws_ok(
  $$update public.products set stock=3 where sku='INV-ADJ-LOCAL-001'$$,'23514',null,
  'database rejects stock below reservations'
);

select lives_ok($$select public.create_inventory_adjustment_v1(
  'ad200000-0000-4000-8000-000000000001',
  (now() at time zone 'America/Tegucigalpa')::date,'COUNT-001','INVENTORY-ADJUSTMENT-IMPLEMENTATION-LOCAL-ONLY',
  jsonb_build_array(
    jsonb_build_object('product_id',(select id from public.products where sku='INV-ADJ-LOCAL-001'),'direction','decrease','quantity',6,'reason_code','physical_count_shortage'),
    jsonb_build_object('product_id',(select id from public.products where sku='INV-ADJ-LOCAL-002'),'direction','increase','quantity',5,'reason_code','physical_count_surplus','unit_cost',90)
  ))$$,'multi-product draft is created');

select is((select count(*)::integer from public.inventory_adjustments),1,'one draft exists');
select is((select count(*)::integer from public.inventory_adjustment_lines),2,'two unique lines exist');
select is((select stock from public.products where sku='INV-ADJ-LOCAL-001'),10,'draft does not change stock');
select is((select count(*)::integer from public.inventory_movements where reference_type='inventory_adjustment'),0,'draft creates no movements');
select lives_ok($$select public.confirm_inventory_adjustment_v1(
  (select id from public.inventory_adjustments where request_key='ad200000-0000-4000-8000-000000000001'),1,'ad200000-0000-4000-8000-000000000001')$$,'multi-product confirmation succeeds');
select is((select stock from public.products where sku='INV-ADJ-LOCAL-001'),4,'decrease stops exactly at reserved stock');
select is((select stock from public.products where sku='INV-ADJ-LOCAL-002'),13,'increase is applied');
select is((select count(*)::integer from public.inventory_movements where reference_type='inventory_adjustment'),2,'one movement per line exists');
select is((select count(*)::integer from public.audit_logs where action='inventory.adjustment.confirmed'),1,'one transactional confirmation audit exists');
select is((select accounting_status from public.inventory_adjustments where reversal_of_id is null),'pending_mapping','unsafe accounting mapping remains pending');
select is((select count(*)::integer from public.journal_entries),0,'no accounting entry is invented');
select lives_ok($$select public.confirm_inventory_adjustment_v1(
  (select id from public.inventory_adjustments where reversal_of_id is null),1,'ad200000-0000-4000-8000-000000000001')$$,'timeout retry is idempotent');
select is((select count(*)::integer from public.inventory_movements where reference_type='inventory_adjustment'),2,'retry adds no movement');
select throws_ok($$update public.inventory_adjustment_lines set quantity=1 where adjustment_id=(select id from public.inventory_adjustments where reversal_of_id is null)$$,'42501','INVENTORY_ADJUSTMENT_IMMUTABLE','confirmed lines are immutable');
select throws_ok($$delete from public.inventory_movements where reference_type='inventory_adjustment'$$,'42501','INVENTORY_ADJUSTMENT_MOVEMENT_IMMUTABLE','adjustment movements are append-only');
select lives_ok($$select public.reverse_inventory_adjustment_v1((select id from public.inventory_adjustments where reversal_of_id is null),'ad300000-0000-4000-8000-000000000001')$$,'complete reversal succeeds');
select is((select stock from public.products where sku='INV-ADJ-LOCAL-001'),10,'reversal restores decreased product');
select is((select stock from public.products where sku='INV-ADJ-LOCAL-002'),8,'reversal restores increased product');
select is((select count(*)::integer from public.inventory_adjustments),2,'reversal creates a second document');
select is((select count(*)::integer from public.inventory_movements where reference_type='inventory_adjustment'),4,'reversal creates opposite movements');

select * from finish();
rollback;
