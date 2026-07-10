-- Allow contadora to edit fiscal configuration without granting broader settings access.

update public.roles
set
  permissions = (
    select coalesce(jsonb_agg(distinct permission order by permission), '[]'::jsonb)
    from (
      select jsonb_array_elements_text(coalesce(public.roles.permissions, '[]'::jsonb)) as permission
      union
      select 'settings:fiscal'
    ) as expanded
  ),
  updated_at = now()
where name = 'contadora'
  and not coalesce(permissions, '[]'::jsonb) ? 'settings:fiscal';