\set ON_ERROR_STOP on
begin;
select plan(25);

select ok(to_regprocedure('public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)') is not null, 'atomic confirmation RPC exists');
select ok(to_regprocedure('public.recover_pos_sale_confirmation_v1(uuid)') is not null, 'recovery RPC exists');
select ok((select prosecdef from pg_proc where oid = 'public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)'::regprocedure), 'confirmation uses SECURITY DEFINER');
select ok((select prosecdef from pg_proc where oid = 'public.recover_pos_sale_confirmation_v1(uuid)'::regprocedure), 'recovery uses SECURITY DEFINER');
select ok((select array_to_string(proconfig, ',') like '%search_path=public, extensions, pg_temp%' from pg_proc where oid = 'public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)'::regprocedure), 'confirmation search_path is fixed');
select ok(not has_function_privilege('anon', 'public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)', 'execute'), 'anon cannot execute confirmation');
select ok(not has_function_privilege('anon', 'public.recover_pos_sale_confirmation_v1(uuid)', 'execute'), 'anon cannot execute recovery');
select ok(not has_table_privilege('authenticated', 'public.pos_sale_confirmation_context', 'select'), 'authenticated cannot read transaction context');
select ok((select relrowsecurity from pg_class where oid = 'public.pos_sale_drafts'::regclass), 'draft table has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.pos_sale_draft_items'::regclass), 'draft items table has RLS');
select ok((select relrowsecurity from pg_class where oid = 'public.pos_sale_confirmation_context'::regclass), 'transaction context has RLS');
select ok(to_regclass('public.pos_sale_drafts_confirmation_request_key_idx') is not null, 'request key has unique index');
select ok(to_regclass('public.pos_sale_drafts_order_id_idx') is not null, 'draft order link has unique index');
select ok(to_regclass('public.pos_sale_drafts_invoice_id_idx') is not null, 'draft invoice link has unique index');
select ok(to_regclass('public.pos_sale_drafts_payment_id_idx') is not null, 'draft payment link has unique index');
select ok(to_regclass('public.pos_sale_drafts_receivable_id_idx') is not null, 'draft receivable link has unique index');
select is(
  (select count(*)::integer from public.roles where name in ('technical_owner','business_owner','admin','vendedor') and permissions ? 'pos:confirm_sale'),
  (select count(*)::integer from public.roles where name in ('technical_owner','business_owner','admin','vendedor')),
  'every existing authorized role retains confirmation'
);
select is((select count(*)::integer from public.roles where name in ('contadora','bodega','soporte','cliente') and permissions ? 'pos:confirm_sale'), 0, 'roles outside the restricted POS contract cannot confirm');
select is((select count(*)::integer from information_schema.columns where table_schema='public' and table_name in ('payments','pos_sale_drafts') and lower(column_name) in ('card_number','cvv','pin','magnetic_stripe')), 0, 'no sensitive card columns exist');
select is((select count(*)::integer from public.accounting_periods), 0, 'Stage 6 does not create accounting periods');
select is((select value->>'mode' from public.accounting_automation_settings where key='automation_mode'), 'disabled', 'accounting automation remains disabled');
select is((select state from public.accounting_feature_flags where key='sales_draft_v2'), 'disabled', 'sales draft V2 retains its isolated-local default');
select is((select state from public.accounting_feature_flags where key='cogs_draft_v2'), 'disabled', 'COGS draft V2 retains its isolated-local default');
select ok(pg_get_functiondef('public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)'::regprocedure) like '%order by products.id for update%', 'product locks use stable order');
select ok(pg_get_functiondef('public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)'::regprocedure) like '%pg_advisory_xact_lock%', 'request and draft use transaction advisory locks');

select * from finish();
rollback;
\echo 'POS Stage 6 hardening certification: OK'
