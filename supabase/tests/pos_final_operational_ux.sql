\set ON_ERROR_STOP on
begin;
select plan(23);

select ok(to_regprocedure('public.get_selectable_pos_customer_context_v1(uuid)') is not null, 'selectable POS customer context exists');
select ok(to_regprocedure('public.assert_pos_customer_selectable_v1(uuid)') is not null, 'POS customer eligibility guard exists');
select ok(to_regprocedure('public.enforce_pos_draft_customer_selectable_v1()') is not null, 'draft customer trigger guard exists');
select ok(to_regprocedure('public.create_selectable_pos_sale_draft_v1(uuid,uuid)') is not null, 'guarded POS draft creation exists');
select ok(to_regprocedure('public.confirm_selectable_pos_sale_v1(uuid,uuid,bigint,date,jsonb)') is not null, 'guarded POS confirmation exists');
select ok((select prosecdef from pg_proc where oid = 'public.get_selectable_pos_customer_context_v1(uuid)'::regprocedure), 'selectable context is SECURITY DEFINER');
select ok((select prosecdef from pg_proc where oid = 'public.assert_pos_customer_selectable_v1(uuid)'::regprocedure), 'eligibility guard is SECURITY DEFINER');
select ok(has_function_privilege('authenticated', 'public.get_selectable_pos_customer_context_v1(uuid)', 'execute'), 'authenticated can execute guarded context');
select ok(not has_function_privilege('authenticated', 'public.get_pos_customer_context_v1(uuid)', 'execute'), 'legacy unguarded context is not directly executable');
select ok(has_function_privilege('authenticated', 'public.create_selectable_pos_sale_draft_v1(uuid,uuid)', 'execute'), 'authenticated can create a guarded draft');
select ok(not has_function_privilege('authenticated', 'public.create_pos_sale_draft_v1(uuid,uuid)', 'execute'), 'legacy unguarded draft creation is not directly executable');
select ok(has_function_privilege('authenticated', 'public.confirm_selectable_pos_sale_v1(uuid,uuid,bigint,date,jsonb)', 'execute'), 'authenticated can execute guarded confirmation');
select ok(not has_function_privilege('authenticated', 'public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)', 'execute'), 'legacy confirmation cannot bypass customer eligibility');
select ok(not has_function_privilege('anon', 'public.get_selectable_pos_customer_context_v1(uuid)', 'execute'), 'anon cannot execute guarded context');
select ok(pg_get_functiondef('public.search_pos_customers_v1(text,integer,integer,boolean)'::regprocedure) like '%customer.active%', 'POS search requires active customer flag');
select ok(pg_get_functiondef('public.search_pos_customers_v1(text,integer,integer,boolean)'::regprocedure) like '%customer.status = ''active''%', 'POS search requires active operational status');
select ok(pg_get_functiondef('public.search_pos_customers_v1(text,integer,integer,boolean)'::regprocedure) like '%customer.wholesale_status <> ''suspended''%', 'POS search excludes suspended customers');
select ok(pg_get_functiondef('public.search_pos_customers_v1(text,integer,integer,boolean)'::regprocedure) like '%customer.merged_into_customer_id is null%', 'POS search excludes merged customers');
select is((select count(*)::integer from pg_trigger where tgrelid = 'public.pos_sale_drafts'::regclass and tgname = 'enforce_pos_draft_customer_selectable_trigger' and tgenabled = 'O'), 1, 'draft create and save guard is enabled');
select is((select count(*)::integer from pg_trigger where tgrelid = 'public.pos_sale_drafts'::regclass and tgname = 'enforce_pos_confirmation_customer_selectable_trigger' and tgenabled = 'O'), 1, 'draft confirmation guard is enabled');
select ok(pg_get_functiondef('public.enforce_pos_draft_customer_selectable_v1()'::regprocedure) like '%POS_CUSTOMER_SUSPENDED%', 'draft guard returns the sanitized suspension code');
select ok(pg_get_functiondef('public.confirm_selectable_pos_sale_v1(uuid,uuid,bigint,date,jsonb)'::regprocedure) like '%assert_pos_customer_selectable_v1%', 'confirmation revalidates customer eligibility first');
select is((select count(*)::integer from public.accounting_periods), 0, 'migration creates no accounting period');

select * from finish();
rollback;
\echo 'POS final operational UX guards: OK'
