\set ON_ERROR_STOP on
begin;
select plan(25);

select ok(to_regclass('public.products_sku_upper_btrim_uidx') is not null, 'normalized SKU unique index exists');
select ok((select indisunique from pg_index where indexrelid='public.products_sku_upper_btrim_uidx'::regclass), 'normalized SKU index is unique');
select ok(pg_get_indexdef('public.products_sku_upper_btrim_uidx'::regclass) ~* 'upper\(btrim\(sku\)\)', 'normalized SKU index protects case plus exterior trim');
select ok(to_regprocedure('public.create_product_import_preflight(text,integer,text,jsonb)') is not null, 'product import preflight RPC exists');
select ok(to_regprocedure('public.import_product_batch_row_v3_atomic(uuid,integer,jsonb,jsonb,integer,text)') is not null, 'staged atomic row import RPC exists');
select ok((select prosecdef from pg_proc where oid='public.create_product_import_preflight(text,integer,text,jsonb)'::regprocedure), 'preflight RPC uses SECURITY DEFINER');
select ok((select prosecdef from pg_proc where oid='public.import_product_batch_row_v3_atomic(uuid,integer,jsonb,jsonb,integer,text)'::regprocedure), 'row import RPC uses SECURITY DEFINER');
select ok(not has_function_privilege('anon','public.create_product_import_preflight(text,integer,text,jsonb)','execute'), 'anon cannot execute product import preflight');
select ok(has_function_privilege('authenticated','public.create_product_import_preflight(text,integer,text,jsonb)','execute'), 'authenticated receives guarded preflight execute');
select ok(not has_function_privilege('anon','public.import_product_batch_row_v3_atomic(uuid,integer,jsonb,jsonb,integer,text)','execute'), 'anon cannot execute staged row import');
select ok(has_function_privilege('authenticated','public.import_product_batch_row_v3_atomic(uuid,integer,jsonb,jsonb,integer,text)','execute'), 'authenticated receives guarded staged row execute');
select lives_ok(
  $$insert into public.import_batches(module,status,total_rows,metadata) values ('products','uploaded',0,'{"fixture":"PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY"}'::jsonb)$$,
  'shared import foundation accepts the products module'
);

select lives_ok(
  $$insert into public.products(category_id,sku,slug,name,brand,retail_price,wholesale_price) values ((select id from public.categories where active=true limit 1),'PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY-ABC-1','product-catalog-implementation-local-only-abc-1','PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY','Fixture',100,80)$$,
  'canonical SKU can be inserted'
);
select throws_ok(
  $$insert into public.products(category_id,sku,slug,name,brand,retail_price,wholesale_price) values ((select id from public.categories where active=true limit 1),'product-catalog-implementation-local-only-abc-1','product-catalog-implementation-local-only-lower','PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY','Fixture',100,80)$$,
  '23505',
  'duplicate key value violates unique constraint "products_sku_upper_btrim_uidx"',
  'lowercase collision is rejected in PostgreSQL'
);
select throws_ok(
  $$insert into public.products(category_id,sku,slug,name,brand,retail_price,wholesale_price) values ((select id from public.categories where active=true limit 1),'PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY-ABC-1 ','product-catalog-implementation-local-only-trim','PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY','Fixture',100,80)$$,
  '23505',
  'duplicate key value violates unique constraint "products_sku_upper_btrim_uidx"',
  'exterior-space collision is rejected in PostgreSQL'
);
select lives_ok(
  $$insert into public.products(category_id,sku,slug,name,brand,retail_price,wholesale_price) values ((select id from public.categories where active=true limit 1),'PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY-ABC1','product-catalog-implementation-local-only-no-hyphen','PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY','Fixture',100,80)$$,
  'SKU without a hyphen remains distinct'
);
select is(
  (select count(*)::integer from public.products where sku like 'PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY%'),
  2,
  'only the canonical and hyphen-distinct fixtures exist'
);
select is(
  (select count(*)::integer from public.products group by upper(btrim(sku)) having count(*) > 1 limit 1),
  null::integer,
  'no normalized SKU collision exists after the guard tests'
);

insert into public.roles(name,description,permissions)
values ('product_catalog_tester','PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY','["products:read","products:import"]'::jsonb)
on conflict(name) do update set permissions=excluded.permissions;
insert into auth.users(id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
values ('a1100000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000','authenticated','authenticated','product-catalog-test@example.test','',now(),'{}','{}',now(),now());
insert into public.users(id,role_id,full_name,email,active)
values ('a1100000-0000-4000-8000-000000000001',(select id from public.roles where name='product_catalog_tester'),'PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY','product-catalog-test@example.test',true)
on conflict(id) do update set role_id=excluded.role_id, full_name=excluded.full_name, active=true;
select set_config('request.jwt.claim.sub','a1100000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',jsonb_build_object('sub','a1100000-0000-4000-8000-000000000001','role','authenticated')::text,true);

select lives_ok(
  $$select public.create_product_import_preflight(
    'PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY-5000.xlsx',
    10485760,
    repeat('a',64),
    (select jsonb_agg(jsonb_build_object('row_number',value+1,'sku','PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY-PREFLIGHT-'||lpad(value::text,5,'0'))) from generate_series(1,5000) value)
  )$$,
  'exactly 5,000 staged rows are accepted by the server'
);
select is(
  (select total_rows from public.import_batches where module='products' and created_by='a1100000-0000-4000-8000-000000000001' order by created_at desc limit 1),
  5000,
  'server preflight records the exact 5,000-row count'
);
select is(
  (select count(*)::integer from public.import_rows where batch_id=(select id from public.import_batches where module='products' and created_by='a1100000-0000-4000-8000-000000000001' order by created_at desc limit 1)),
  5000,
  'server preflight stages all rows under one UUID batch'
);
select throws_ok(
  $$select public.create_product_import_preflight(
    'PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY-5001.xlsx',
    10485760,
    repeat('b',64),
    (select jsonb_agg(jsonb_build_object('row_number',value+1,'sku','PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY-TOO-MANY-'||lpad(value::text,5,'0'))) from generate_series(1,5001) value)
  )$$,
  'P0001',
  'El archivo contiene mas de 5,000 productos. Divida la importacion en archivos mas pequenos.',
  '5,001 rows are rejected before product mutations'
);
select throws_ok(
  $$select public.create_product_import_preflight('PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY-LARGE.xlsx',10485761,repeat('c',64),'[{"row_number":2,"sku":"PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY-LARGE"}]'::jsonb)$$,
  'P0001',
  'El archivo Excel supera el limite de 10 MiB.',
  'XLSX bytes above 10 MiB are rejected server-side'
);
select throws_ok(
  $$select public.create_product_import_preflight('PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY-DUP.xlsx',1024,repeat('d',64),'[{"row_number":2,"sku":"TEST-ABC"},{"row_number":3,"sku":" test-abc "}]'::jsonb)$$,
  'P0001',
  'El archivo contiene SKU duplicados segun la normalizacion case-insensitive y trim.',
  'duplicate SKUs inside the XLSX are rejected case-insensitively with trim'
);
select is(
  (select count(*)::integer from public.products where sku like 'PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY%'),
  2,
  'preflight and rejected limits do not mutate products'
);

select * from finish();
rollback;
