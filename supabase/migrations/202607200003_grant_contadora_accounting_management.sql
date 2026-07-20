-- Grant the accountant the remaining granular permissions required for full
-- accounting-module management. Existing permissions and all business data
-- remain unchanged.
update public.roles
set permissions =
  coalesce(permissions, '[]'::jsonb)
  || case
    when coalesce(permissions, '[]'::jsonb) ? 'accounting:reverse' then '[]'::jsonb
    else '["accounting:reverse"]'::jsonb
  end
  || case
    when coalesce(permissions, '[]'::jsonb) ? 'accounting:settings' then '[]'::jsonb
    else '["accounting:settings"]'::jsonb
  end
  || case
    when coalesce(permissions, '[]'::jsonb) ? 'accounting:reopen_period' then '[]'::jsonb
    else '["accounting:reopen_period"]'::jsonb
  end
where name = 'contadora'
  and not (
    coalesce(permissions, '[]'::jsonb) ? 'accounting:reverse'
    and coalesce(permissions, '[]'::jsonb) ? 'accounting:settings'
    and coalesce(permissions, '[]'::jsonb) ? 'accounting:reopen_period'
  );
