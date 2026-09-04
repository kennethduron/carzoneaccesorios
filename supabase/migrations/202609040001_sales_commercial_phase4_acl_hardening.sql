-- Phase 4 production ACL hardening.
-- Keep the application entry-point RPCs callable by the trusted server role,
-- while preserving their internal actor/RBAC checks. Trigger and helper
-- functions remain private. No business data is modified.
begin;

grant execute on function public.create_commission_policy_v1(uuid,text,text,numeric,text) to service_role;
grant execute on function public.duplicate_commission_policy_v1(uuid,uuid,text) to service_role;
grant execute on function public.deactivate_commission_policy_v1(uuid,text) to service_role;
grant execute on function public.list_commission_policies_v1(text,text,text) to service_role;
grant execute on function public.preview_commission_policy_assignment_v1(uuid,uuid[],date) to service_role;
grant execute on function public.apply_commission_policy_assignment_v1(uuid,uuid,uuid[],date,text,text) to service_role;
grant execute on function public.get_commercial_dashboard_v1(jsonb,integer,integer) to service_role;
grant execute on function public.create_commercial_report_generation_v1(uuid,text,text,text,jsonb,jsonb,jsonb,text) to service_role;
grant execute on function public.complete_commercial_report_generation_v1(uuid,jsonb,integer,text) to service_role;
grant execute on function public.fail_commercial_report_generation_v1(uuid,text,text) to service_role;
grant execute on function public.list_commercial_report_history_v1(integer,integer) to service_role;
grant execute on function public.get_commercial_report_snapshot_v1(uuid) to service_role;

-- These functions are invoked only by table triggers or by SECURITY DEFINER
-- entry points. Direct execution is not part of the service-role contract.
revoke all on function public.commercial_phase4_permission_allowed(text) from service_role;
revoke all on function public.prevent_phase4_audit_mutation_v1() from service_role;
revoke all on function public.prevent_commission_policy_rewrite_v1() from service_role;
revoke all on function public.phase4_policy_json_v1(uuid) from service_role;

-- Identity values are allocated inside owner-executed SECURITY DEFINER RPCs;
-- callers do not require direct access to the backing sequences.
revoke all on sequence public.sales_commission_policy_events_id_seq,
  public.sales_commission_assignment_items_id_seq,
  public.commercial_report_generation_events_id_seq
from anon,authenticated,service_role;

-- Preserve the explicit Phase-4 table contract and remove privileges inherited
-- from environment-specific defaults. Physical deletion is not supported.
revoke delete,truncate,references,trigger on table
  public.sales_commission_policies,
  public.sales_commission_policy_events,
  public.sales_commission_assignment_operations,
  public.sales_commission_assignment_items,
  public.commercial_report_configurations,
  public.commercial_report_generations,
  public.commercial_report_generation_events
from service_role;

-- PostgreSQL 17 added MAINTAIN as a table privilege. Revoke it when available
-- without making the migration incompatible with older local test runtimes.
do $acl$
begin
  if current_setting('server_version_num')::integer >= 170000 then
    execute 'revoke maintain on table '
      || 'public.sales_commission_policies,'
      || 'public.sales_commission_policy_events,'
      || 'public.sales_commission_assignment_operations,'
      || 'public.sales_commission_assignment_items,'
      || 'public.commercial_report_configurations,'
      || 'public.commercial_report_generations,'
      || 'public.commercial_report_generation_events from service_role';
  end if;
end
$acl$;

grant select,insert,update on table
  public.sales_commission_policies,
  public.sales_commission_policy_events,
  public.sales_commission_assignment_operations,
  public.sales_commission_assignment_items,
  public.commercial_report_configurations,
  public.commercial_report_generations,
  public.commercial_report_generation_events
to service_role;

commit;
