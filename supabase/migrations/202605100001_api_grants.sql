grant usage on schema public to anon, authenticated;

grant select on public.roles to anon, authenticated;
grant select on public.categories to anon, authenticated;
grant select on public.products to anon, authenticated;
grant select on public.product_images to anon, authenticated;

grant select, insert, update on public.users to authenticated;
grant select, insert, update on public.customers to authenticated;
grant select, insert, update on public.orders to authenticated;
grant select, insert, update on public.order_items to authenticated;
grant select, insert, update on public.payments to authenticated;
grant select, insert, update on public.invoices to authenticated;
grant select, insert, update on public.invoice_items to authenticated;
grant select, insert, update on public.shipment_tracking to authenticated;
grant select, insert, update on public.inventory_movements to authenticated;
grant select, insert, update on public.crm_followups to authenticated;
grant select, insert, update on public.crm_notes to authenticated;
grant select on public.audit_logs to authenticated;
grant select, insert, update on public.backup_logs to authenticated;

grant insert, update, delete on public.products to authenticated;
grant insert, update, delete on public.product_images to authenticated;
grant insert, update, delete on public.categories to authenticated;
grant insert, update, delete on public.wholesale_codes to authenticated;

grant usage, select on all sequences in schema public to anon, authenticated;
