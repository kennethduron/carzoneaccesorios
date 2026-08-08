\set ON_ERROR_STOP on
begin;
select plan(39);

select ok(
  exists(select 1 from information_schema.columns where table_schema='public' and table_name='pos_sale_drafts' and column_name='additional_charge'),
  'POS drafts persist additional charge separately'
);
select is(
  (select count(*)::integer from pg_constraint where conrelid='public.pos_sale_drafts'::regclass and conname in (
    'pos_sale_drafts_shipping_fee_nonnegative','pos_sale_drafts_cod_fee_nonnegative',
    'pos_sale_drafts_additional_charge_nonnegative','pos_sale_drafts_other_charge_nonnegative'
  )), 4, 'all four POS charge columns have nonnegative database guards'
);
select is(public.normalize_pos_customer_phone_v1('+504 9999-1111'), '99991111', '+504 and local Honduran phones normalize identically');
select is(
  (public.calculate_pos_draft_financials_v2('[]'::jsonb,0.15,0.10,0.20,0.30,'HNL')->>'total')::numeric,
  0.60::numeric, 'decimal 0.10 + 0.20 and another charge remain exact'
);
select is(
  (public.calculate_pos_draft_financials_v2(
    '[{"quantity":3,"unit_price":0.10,"tax_category":"exempt"}]'::jsonb,
    0.15,0.11,0.22,0.33,'HNL'
  )->>'total')::numeric, 0.96::numeric, 'multiple quantities and all charge buckets round canonically'
);
select ok(to_regprocedure('public.save_pos_sale_draft_with_charges_v1(uuid,uuid,bigint,uuid,integer,jsonb,text,text,text,text,numeric,numeric,numeric,numeric)') is not null, 'guarded POS draft charge RPC exists');
select ok(to_regprocedure('public.suggest_pos_customer_duplicates_v1(text,text,text,text,text,integer)') is not null, 'canonical duplicate suggestion RPC exists');
select ok(to_regprocedure('public.save_pos_customer_commercial_profile_v2(uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,numeric,integer,text,text,text)') is not null, 'commercial profile v2 accepts explicit override reason');
select ok(pg_get_functiondef('public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)'::regprocedure) like '%additional_charge%', 'atomic confirmation consumes separate additional charge');
select ok((select prosecdef from pg_proc where oid='public.save_pos_sale_draft_with_charges_v1(uuid,uuid,bigint,uuid,integer,jsonb,text,text,text,text,numeric,numeric,numeric,numeric)'::regprocedure), 'charge save RPC is SECURITY DEFINER');
select ok((select prosecdef from pg_proc where oid='public.suggest_pos_customer_duplicates_v1(text,text,text,text,text,integer)'::regprocedure), 'suggestion RPC is SECURITY DEFINER');
select ok((select prosecdef from pg_proc where oid='public.save_pos_customer_commercial_profile_v2(uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,numeric,integer,text,text,text)'::regprocedure), 'profile v2 RPC is SECURITY DEFINER');
select ok(not has_function_privilege('anon','public.save_pos_sale_draft_with_charges_v1(uuid,uuid,bigint,uuid,integer,jsonb,text,text,text,text,numeric,numeric,numeric,numeric)','execute'), 'anon cannot save POS charges');
select ok(not has_function_privilege('anon','public.suggest_pos_customer_duplicates_v1(text,text,text,text,text,integer)','execute'), 'anon cannot enumerate duplicate suggestions');
select ok(has_function_privilege('authenticated','public.save_pos_sale_draft_with_charges_v1(uuid,uuid,bigint,uuid,integer,jsonb,text,text,text,text,numeric,numeric,numeric,numeric)','execute'), 'authenticated receives guarded charge save execute');
select ok(pg_get_functiondef('public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)'::regprocedure) like '%sale_shipping_fee%', 'confirmation validates delivery accounting mapping by fiscal date');
select ok(pg_get_functiondef('public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)'::regprocedure) like '%''pos'', ''store''%', 'confirmed orders preserve POS source and store channel');
select ok(pg_get_functiondef('public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)'::regprocedure) like '%Cargo adicional%', 'confirmation emits labeled additional invoice fee');
select ok(pg_get_functiondef('public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)'::regprocedure) like '%draft_record.shipping_fee, draft_record.shipping_fee, draft_record.cod_fee%', 'order receives canonical delivery and COD amounts');
select ok(pg_get_functiondef('public.save_pos_sale_draft_with_charges_v1(uuid,uuid,bigint,uuid,integer,jsonb,text,text,text,text,numeric,numeric,numeric,numeric)'::regprocedure) like '%calculate_pos_draft_financials_v2%', 'draft save reuses canonical financial calculator');
select ok(pg_get_functiondef('public.create_pos_customer_v1(uuid,text,text,text,text,text,text,text,text)'::regprocedure) like '%email_duplicate%', 'server revalidates exact email');
select ok(pg_get_functiondef('public.create_pos_customer_v1(uuid,text,text,text,text,text,text,text,text)'::regprocedure) like '%tax_duplicate%', 'server revalidates exact RTN');
select ok(pg_get_functiondef('public.create_pos_customer_v1(uuid,text,text,text,text,text,text,text,text)'::regprocedure) like '%duplicate_override%', 'shared phone override is explicitly audited');
select ok(pg_get_functiondef('public.create_pos_customer_v1(uuid,text,text,text,text,text,text,text,text)'::regprocedure) not like '%exact_normalized_name%', 'name similarity is no longer a blocking identity');
select ok(pg_get_functiondef('public.suggest_pos_customer_duplicates_v1(text,text,text,text,text,integer)'::regprocedure) like '%mask_pos_customer_email_v1%', 'suggestions return masked identifiers');

insert into public.roles(name,description,permissions)
values ('admin','POS-ENHANCEMENTS-LOCAL-ONLY',jsonb_build_array(
  'pos:access','pos:create_sale','pos:customers:search','pos:customers:create','pos:customers:update',
  'wholesale:manage','credit:manage'
))
on conflict(name) do update set permissions=excluded.permissions,description=excluded.description;

insert into auth.users(
  id,instance_id,aud,role,email,encrypted_password,email_confirmed_at,
  raw_app_meta_data,raw_user_meta_data,created_at,updated_at
) values (
  'b7100000-0000-4000-8000-000000000001','00000000-0000-0000-0000-000000000000',
  'authenticated','authenticated','pos-enhancements-admin@example.test','',now(),
  '{}'::jsonb,'{}'::jsonb,now(),now()
);
insert into public.users(id,role_id,full_name,email,active)
values (
  'b7100000-0000-4000-8000-000000000001',
  (select id from public.roles where name='admin'),
  'POS-ENHANCEMENTS-LOCAL-ONLY','pos-enhancements-admin@example.test',true
)
on conflict(id) do update set role_id=excluded.role_id,active=true;

select set_config('request.jwt.claim.sub','b7100000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims',jsonb_build_object(
  'sub','b7100000-0000-4000-8000-000000000001','role','authenticated'
)::text,true);

insert into public.customers(
  id,contact_name,business_name,email,phone,tax_id,city,active,status,
  is_wholesale,wholesale_status,lead_status,source
) values
(
  'b7200000-0000-4000-8000-000000000001','José Pérez','Repuestos Centro',
  'cliente@example.test','9999-1111','0801-1999-123456','Tegucigalpa',true,'active',
  false,'none','cliente','crm'
),(
  'b7200000-0000-4000-8000-000000000002','Cliente suspendido','Repuestos Suspendidos',
  'suspendido@example.test','9999-2222','0801-1999-123457','Tegucigalpa',true,'active',
  false,'suspended','cliente','accounts_receivable'
);

select is(
  (select match_level from public.suggest_pos_customer_duplicates_v1(null,null,' CLIENTE@EXAMPLE.TEST ',null,null,8) limit 1),
  'strong','exact normalized email is a strong match'
);
select isnt(
  (select email_masked from public.suggest_pos_customer_duplicates_v1(null,null,'cliente@example.test',null,null,8) limit 1),
  'cliente@example.test','email is masked in duplicate suggestions'
);
select is(
  (select customer_id from public.suggest_pos_customer_duplicates_v1(null,null,null,'+504 9999-1111',null,8) limit 1),
  'b7200000-0000-4000-8000-000000000001'::uuid,'country-prefixed phone finds the local customer'
);
select is(
  (select customer_id from public.suggest_pos_customer_duplicates_v1(null,null,null,null,'0801 1999 123456',8) limit 1),
  'b7200000-0000-4000-8000-000000000001'::uuid,'formatted RTN finds the canonical customer'
);
select is(
  (select match_level from public.suggest_pos_customer_duplicates_v1('Jose Perez',null,null,null,null,8) limit 1),
  'probable','accent-tolerant name match remains a probable warning'
);
select is(
  (select selectable from public.suggest_pos_customer_duplicates_v1(null,'Repuestos Suspendidos',null,null,null,8) where customer_id='b7200000-0000-4000-8000-000000000002'),
  false,'suspended customer is warning-only and not selectable'
);
select ok(
  (select count(*) from public.suggest_pos_customer_duplicates_v1('Cliente',null,null,null,null,2)) <= 2,
  'suggestion result limit is enforced'
);
select is(
  (public.create_pos_customer_v1(
    'b7300000-0000-4000-8000-000000000001','Otro nombre',null,
    'CLIENTE@example.test',null,null,null,null,null
  )->>'status'),
  'duplicate','exact email remains non-overridable on server'
);
select is(
  (public.create_pos_customer_v1(
    'b7300000-0000-4000-8000-000000000002','Familia Pérez','9999 1111',
    null,null,null,null,null,null
  )->>'status'),
  'duplicate','shared phone is blocked without explicit reason'
);
select set_config('app.pos_duplicate_override_reason','Teléfono familiar compartido autorizado.',true);
select is(
  (public.create_pos_customer_v1(
    'b7300000-0000-4000-8000-000000000003','Familia Pérez','+504 9999-1111',
    null,null,null,null,null,null
  )->>'status'),
  'created','shared phone can be created only with explicit reason'
);
select is(
  (select count(*)::integer from public.audit_logs where action='pos.customer.duplicate_override' and new_data->>'override_reason'='Teléfono familiar compartido autorizado.'),
  1,'allowed strong override records reason in audit'
);
select ok(
  (select user_id is null from public.customers where contact_name='Familia Pérez'),
  'internal override creates no Auth or portal link'
);
select is(
  (select enabled from public.customer_feature_flags where key='customer_merge_execution_v1'),
  false,'customer merge execution remains disabled'
);
select is(
  (select count(*)::integer from public.orders where source='pos'),
  0,'duplicate certification creates no economic records'
);

select * from finish();
rollback;
\echo 'POS optional charges and duplicate suggestions: OK'
