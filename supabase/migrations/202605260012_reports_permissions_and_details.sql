-- Align report access with the application-level role contract.
-- Full report access: technical_owner, admin, business_owner, contadora.
-- Limited report access: vendedor can read operational report pages but cannot export financial reports in the UI.
update public.roles
set permissions = (
  select jsonb_agg(distinct permission order by permission)
  from (
    select jsonb_array_elements_text(coalesce(public.roles.permissions, '[]'::jsonb)) as permission
    union all
    select unnest(array['reports:read', 'reports:export'])
  ) as merged
)
where name in ('technical_owner', 'admin', 'business_owner', 'contadora');

update public.roles
set permissions = (
  select jsonb_agg(distinct permission order by permission)
  from (
    select jsonb_array_elements_text(coalesce(public.roles.permissions, '[]'::jsonb)) as permission
    union all
    select 'reports:read'
  ) as merged
)
where name = 'vendedor';
