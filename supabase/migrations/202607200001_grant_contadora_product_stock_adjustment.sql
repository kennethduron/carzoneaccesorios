-- Grant the accountant role the narrow stock-adjustment capability used by
-- product import and product stock edits. This preserves every existing
-- permission and does not mutate products, inventory, or users.
update public.roles
set permissions = case
  when coalesce(public.roles.permissions, '[]'::jsonb) ? 'products:adjust_stock'
    then public.roles.permissions
  else coalesce(public.roles.permissions, '[]'::jsonb) || '["products:adjust_stock"]'::jsonb
end
where name = 'contadora';