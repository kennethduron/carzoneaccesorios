-- Checkout V4 controlled rollout compatibility.
-- PostgREST exposes the current role through request.jwt.claims on current
-- runtimes; auth.role() reads that canonical claim and remains compatible with
-- the older request.jwt.claim.role GUC when present.

create or replace function public.set_checkout_feature_flag_v1(
  p_enabled boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  role_claim text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    auth.role()
  );
  updated public.checkout_feature_flags%rowtype;
begin
  if role_claim is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'CHECKOUT_FEATURE_FLAG_FORBIDDEN';
  end if;

  if char_length(trim(coalesce(p_reason, ''))) < 10
     or char_length(trim(coalesce(p_reason, ''))) > 500 then
    raise exception using errcode = '22023', message = 'CHECKOUT_FEATURE_FLAG_REASON_INVALID';
  end if;

  update public.checkout_feature_flags
  set enabled = coalesce(p_enabled, false),
      enabled_at = case when coalesce(p_enabled, false) then now() else null end,
      version = version + 1,
      reason = trim(p_reason),
      updated_at = now()
  where key = 'checkout_order_v4'
  returning * into updated;

  insert into public.audit_logs(actor_role, table_name, action, new_data)
  values (
    'service_role',
    'checkout_feature_flags',
    'checkout_v4.feature_flag_changed',
    jsonb_build_object(
      'key', updated.key,
      'enabled', updated.enabled,
      'version', updated.version,
      'reason', updated.reason
    )
  );

  return jsonb_build_object(
    'key', updated.key,
    'enabled', updated.enabled,
    'version', updated.version,
    'updatedAt', updated.updated_at
  );
end;
$$;

create or replace function public.cleanup_checkout_v4_retention_v1()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  role_claim text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    auth.role()
  );
  expired_count integer := 0;
  deleted_events integer := 0;
  deleted_requests integer := 0;
begin
  if role_claim is distinct from 'service_role' then
    raise exception using errcode = '42501', message = 'CHECKOUT_RETENTION_FORBIDDEN';
  end if;

  update public.checkout_requests_v4
  set status = 'expired',
      error_code = 'CHECKOUT_REQUEST_EXPIRED',
      failed_at = coalesce(failed_at, now()),
      updated_at = now()
  where expires_at < now()
    and status in ('started', 'processing', 'failed_retryable');
  get diagnostics expired_count = row_count;

  delete from public.checkout_observability_events
  where created_at < now() - interval '90 days';
  get diagnostics deleted_events = row_count;

  delete from public.checkout_requests_v4
  where created_at < now() - interval '30 days'
    and status in ('failed_final', 'conflict', 'expired')
    and order_id is null;
  get diagnostics deleted_requests = row_count;

  return jsonb_build_object(
    'expired', expired_count,
    'deletedEvents', deleted_events,
    'deletedRequests', deleted_requests
  );
end;
$$;

revoke all on function public.set_checkout_feature_flag_v1(boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_checkout_feature_flag_v1(boolean, text)
  to service_role;

revoke all on function public.cleanup_checkout_v4_retention_v1()
  from public, anon, authenticated;
grant execute on function public.cleanup_checkout_v4_retention_v1()
  to service_role;

comment on function public.set_checkout_feature_flag_v1(boolean, text) is
  'Canonical audited Checkout V4 rollout switch. Service-role authorization supports current and legacy PostgREST claim exposure.';

comment on function public.cleanup_checkout_v4_retention_v1() is
  'Service-only Checkout V4 retention cleanup with current and legacy PostgREST role-claim compatibility.';
