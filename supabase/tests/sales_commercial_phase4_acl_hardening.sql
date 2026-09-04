\set ON_ERROR_STOP on
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
select plan(35);

select ok(has_function_privilege('service_role','public.create_commission_policy_v1(uuid,text,text,numeric,text)','execute'),'service role can enter policy creation RPC');
select ok(has_function_privilege('service_role','public.duplicate_commission_policy_v1(uuid,uuid,text)','execute'),'service role can enter policy duplication RPC');
select ok(has_function_privilege('service_role','public.deactivate_commission_policy_v1(uuid,text)','execute'),'service role can enter policy deactivation RPC');
select ok(has_function_privilege('service_role','public.list_commission_policies_v1(text,text,text)','execute'),'service role can enter policy listing RPC');
select ok(has_function_privilege('service_role','public.preview_commission_policy_assignment_v1(uuid,uuid[],date)','execute'),'service role can enter policy preview RPC');
select ok(has_function_privilege('service_role','public.apply_commission_policy_assignment_v1(uuid,uuid,uuid[],date,text,text)','execute'),'service role can enter assignment RPC');
select ok(has_function_privilege('service_role','public.get_commercial_dashboard_v1(jsonb,integer,integer)','execute'),'service role can enter dashboard RPC');
select ok(has_function_privilege('service_role','public.create_commercial_report_generation_v1(uuid,text,text,text,jsonb,jsonb,jsonb,text)','execute'),'service role can enter report creation RPC');
select ok(has_function_privilege('service_role','public.complete_commercial_report_generation_v1(uuid,jsonb,integer,text)','execute'),'service role can enter report completion RPC');
select ok(has_function_privilege('service_role','public.fail_commercial_report_generation_v1(uuid,text,text)','execute'),'service role can enter report failure RPC');
select ok(has_function_privilege('service_role','public.list_commercial_report_history_v1(integer,integer)','execute'),'service role can enter report history RPC');
select ok(has_function_privilege('service_role','public.get_commercial_report_snapshot_v1(uuid)','execute'),'service role can enter report snapshot RPC');

select ok(not has_function_privilege('service_role','public.commercial_phase4_permission_allowed(text)','execute'),'permission helper stays private');
select ok(not has_function_privilege('service_role','public.prevent_phase4_audit_mutation_v1()','execute'),'audit trigger function stays private');
select ok(not has_function_privilege('service_role','public.prevent_commission_policy_rewrite_v1()','execute'),'policy trigger function stays private');
select ok(not has_function_privilege('service_role','public.phase4_policy_json_v1(uuid)','execute'),'policy serialization helper stays private');

select ok(not has_sequence_privilege('anon','public.sales_commission_policy_events_id_seq','usage') and not has_sequence_privilege('authenticated','public.sales_commission_policy_events_id_seq','usage') and not has_sequence_privilege('service_role','public.sales_commission_policy_events_id_seq','usage'),'policy event sequence is private');
select ok(not has_sequence_privilege('anon','public.sales_commission_policy_events_id_seq','select') and not has_sequence_privilege('authenticated','public.sales_commission_policy_events_id_seq','select') and not has_sequence_privilege('service_role','public.sales_commission_policy_events_id_seq','select'),'policy event sequence cannot be inspected directly');
select ok(not has_sequence_privilege('anon','public.sales_commission_policy_events_id_seq','update') and not has_sequence_privilege('authenticated','public.sales_commission_policy_events_id_seq','update') and not has_sequence_privilege('service_role','public.sales_commission_policy_events_id_seq','update'),'policy event sequence cannot be advanced directly');
select ok(not has_sequence_privilege('anon','public.sales_commission_assignment_items_id_seq','usage') and not has_sequence_privilege('authenticated','public.sales_commission_assignment_items_id_seq','usage') and not has_sequence_privilege('service_role','public.sales_commission_assignment_items_id_seq','usage'),'assignment item sequence is private');
select ok(not has_sequence_privilege('anon','public.sales_commission_assignment_items_id_seq','select') and not has_sequence_privilege('authenticated','public.sales_commission_assignment_items_id_seq','select') and not has_sequence_privilege('service_role','public.sales_commission_assignment_items_id_seq','select'),'assignment item sequence cannot be inspected directly');
select ok(not has_sequence_privilege('anon','public.sales_commission_assignment_items_id_seq','update') and not has_sequence_privilege('authenticated','public.sales_commission_assignment_items_id_seq','update') and not has_sequence_privilege('service_role','public.sales_commission_assignment_items_id_seq','update'),'assignment item sequence cannot be advanced directly');
select ok(not has_sequence_privilege('anon','public.commercial_report_generation_events_id_seq','usage') and not has_sequence_privilege('authenticated','public.commercial_report_generation_events_id_seq','usage') and not has_sequence_privilege('service_role','public.commercial_report_generation_events_id_seq','usage'),'report event sequence is private');
select ok(not has_sequence_privilege('anon','public.commercial_report_generation_events_id_seq','select') and not has_sequence_privilege('authenticated','public.commercial_report_generation_events_id_seq','select') and not has_sequence_privilege('service_role','public.commercial_report_generation_events_id_seq','select'),'report event sequence cannot be inspected directly');
select ok(not has_sequence_privilege('anon','public.commercial_report_generation_events_id_seq','update') and not has_sequence_privilege('authenticated','public.commercial_report_generation_events_id_seq','update') and not has_sequence_privilege('service_role','public.commercial_report_generation_events_id_seq','update'),'report event sequence cannot be advanced directly');

select ok(not has_table_privilege('service_role','public.sales_commission_policies','delete'),'policies cannot be deleted directly');
select ok(not has_table_privilege('service_role','public.sales_commission_policy_events','delete'),'policy events cannot be deleted directly');
select ok(not has_table_privilege('service_role','public.sales_commission_assignment_operations','delete'),'assignment operations cannot be deleted directly');
select ok(not has_table_privilege('service_role','public.sales_commission_assignment_items','delete'),'assignment items cannot be deleted directly');
select ok(not has_table_privilege('service_role','public.commercial_report_configurations','delete'),'saved report configurations cannot be deleted directly');
select ok(not has_table_privilege('service_role','public.commercial_report_generations','delete'),'report generations cannot be deleted directly');
select ok(not has_table_privilege('service_role','public.commercial_report_generation_events','delete'),'report events cannot be deleted directly');
select ok(has_table_privilege('service_role','public.sales_commission_policies','select,insert,update'),'service role retains the explicit policy table contract');
select ok(has_table_privilege('service_role','public.commercial_report_generations','select,insert,update'),'service role retains the explicit report table contract');
select ok(not has_table_privilege('service_role','public.sales_commission_policy_events','truncate') and not has_table_privilege('service_role','public.commercial_report_generation_events','trigger'),'environment default privileges are removed');

select * from finish();
rollback;
