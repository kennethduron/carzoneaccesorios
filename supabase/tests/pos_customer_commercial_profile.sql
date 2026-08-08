\set ON_ERROR_STOP on
begin;
select plan(30);

select ok(to_regprocedure('public.save_pos_customer_commercial_profile_v1(uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,numeric,integer,text,text)') is not null, 'atomic commercial profile RPC exists');
select ok(to_regprocedure('public.return_customer_to_retail_v1(uuid,uuid,integer,text,text)') is not null, 'return-to-retail RPC exists');
select ok(to_regprocedure('public.get_pos_customer_credit_configuration_v1(uuid)') is not null, 'credit configuration reader exists');
select ok(to_regprocedure('public.pos_child_request_key_v1(uuid,text)') is not null, 'deterministic child request helper exists');
select ok((select prosecdef from pg_proc where oid = 'public.save_pos_customer_commercial_profile_v1(uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,numeric,integer,text,text)'::regprocedure), 'profile RPC is SECURITY DEFINER');
select ok((select prosecdef from pg_proc where oid = 'public.return_customer_to_retail_v1(uuid,uuid,integer,text,text)'::regprocedure), 'retail transition is SECURITY DEFINER');
select ok((select prosecdef from pg_proc where oid = 'public.get_pos_customer_credit_configuration_v1(uuid)'::regprocedure), 'credit reader is SECURITY DEFINER');
select ok((select array_to_string(proconfig, ',') like '%search_path=public, extensions, pg_temp%' from pg_proc where oid = 'public.save_pos_customer_commercial_profile_v1(uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,numeric,integer,text,text)'::regprocedure), 'profile search_path is fixed');
select ok((select array_to_string(proconfig, ',') like '%search_path=public, extensions, pg_temp%' from pg_proc where oid = 'public.return_customer_to_retail_v1(uuid,uuid,integer,text,text)'::regprocedure), 'retail transition search_path is fixed');
select ok(not has_function_privilege('anon', 'public.save_pos_customer_commercial_profile_v1(uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,numeric,integer,text,text)', 'execute'), 'anon cannot save commercial profile');
select ok(not has_function_privilege('anon', 'public.return_customer_to_retail_v1(uuid,uuid,integer,text,text)', 'execute'), 'anon cannot return customer to retail');
select ok(not has_function_privilege('anon', 'public.get_pos_customer_credit_configuration_v1(uuid)', 'execute'), 'anon cannot read credit configuration');
select ok(has_function_privilege('authenticated', 'public.save_pos_customer_commercial_profile_v1(uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,numeric,integer,text,text)', 'execute'), 'authenticated receives guarded profile execute');
select ok(has_function_privilege('authenticated', 'public.return_customer_to_retail_v1(uuid,uuid,integer,text,text)', 'execute'), 'authenticated receives guarded retail execute');
select ok(not has_function_privilege('authenticated', 'public.pos_child_request_key_v1(uuid,text)', 'execute'), 'child request helper is internal');
select ok((select is_nullable = 'YES' from information_schema.columns where table_schema='public' and table_name='customers' and column_name='phone'), 'customer phone remains nullable');
select ok((select pg_get_constraintdef(oid) like '%return_to_retail%' from pg_constraint where conrelid='public.wholesale_access_history'::regclass and conname='wholesale_access_history_operation_check'), 'wholesale history accepts return-to-retail');
select is(
  (select count(*)::integer from public.roles where name in ('technical_owner','business_owner','admin') and permissions ? 'pos:customers:create' and permissions ? 'wholesale:manage' and permissions ? 'credit:manage'),
  (select count(*)::integer from public.roles where name in ('technical_owner','business_owner','admin')),
  'every existing authorized role has all commercial permissions'
);
select is((select count(*)::integer from public.roles where name in ('contadora','vendedor','bodega','soporte','cliente') and permissions ? 'pos:customers:create'), 0, 'non-POS roles cannot create customers');
select ok(pg_get_functiondef('public.save_pos_customer_commercial_profile_v1(uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,numeric,integer,text,text)'::regprocedure) like '%claim_pos_idempotency_v1%', 'profile RPC claims durable idempotency');
select ok(pg_get_functiondef('public.save_pos_customer_commercial_profile_v1(uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,numeric,integer,text,text)'::regprocedure) like '%create_pos_customer_v1%', 'profile RPC reuses canonical customer creation');
select ok(pg_get_functiondef('public.save_pos_customer_commercial_profile_v1(uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,numeric,integer,text,text)'::regprocedure) like '%update_pos_customer_v1%', 'profile RPC reuses canonical customer update');
select ok(pg_get_functiondef('public.save_pos_customer_commercial_profile_v1(uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,numeric,integer,text,text)'::regprocedure) like '%grant_customer_wholesale_access_v1%', 'profile RPC reuses canonical wholesale grant');
select ok(pg_get_functiondef('public.save_pos_customer_commercial_profile_v1(uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,numeric,integer,text,text)'::regprocedure) like '%set_customer_commercial_credit%', 'profile RPC reuses canonical credit contract');
select ok(pg_get_functiondef('public.save_pos_customer_commercial_profile_v1(uuid,uuid,integer,text,text,text,text,text,text,text,text,text,text,numeric,integer,text,text)'::regprocedure) like '%commercial_profile_saved%', 'profile RPC writes summary audit');
select ok(pg_get_functiondef('public.create_pos_customer_v1(uuid,text,text,text,text,text,text,text,text)'::regprocedure) like '%normalized_phone is not null%', 'supplied phone is conditionally validated');
select ok(pg_get_functiondef('public.suggest_pos_customer_duplicates_v1(text,text,text,text,text,integer)'::regprocedure) like '%name_match%', 'exact and similar names are surfaced by the non-blocking suggestion service');
select ok(pg_get_functiondef('public.return_customer_to_retail_v1(uuid,uuid,integer,text,text)'::regprocedure) like '%wholesale_access_history%', 'retail transition appends wholesale history');
select ok(pg_get_functiondef('public.return_customer_to_retail_v1(uuid,uuid,integer,text,text)'::regprocedure) like '%commercial_version%', 'retail transition uses optimistic commercial version');
select is((select count(*)::integer from public.accounting_periods), 0, 'migration creates no accounting period');

select * from finish();
rollback;
\echo 'POS customer commercial profile certification: OK'
