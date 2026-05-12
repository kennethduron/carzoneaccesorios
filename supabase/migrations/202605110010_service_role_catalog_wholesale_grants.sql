grant usage on schema public to anon, authenticated, service_role;

grant select on public.categories to anon, authenticated, service_role;
grant select on public.products to anon, authenticated, service_role;
grant select on public.product_images to anon, authenticated, service_role;

grant select, insert, update, delete on public.roles to service_role;
grant select, insert, update, delete on public.users to service_role;
grant select, insert, update, delete on public.customers to service_role;
grant select, insert, update, delete on public.products to service_role;
grant select, insert, update, delete on public.product_images to service_role;
grant select, insert, update, delete on public.categories to service_role;
grant select, insert, update, delete on public.wholesale_codes to service_role;
grant select, insert, update, delete on public.orders to service_role;
grant select, insert, update, delete on public.order_items to service_role;
grant select, insert, update, delete on public.payments to service_role;
grant select, insert, update, delete on public.invoices to service_role;
grant select, insert, update, delete on public.invoice_items to service_role;
grant select, insert, update, delete on public.shipment_tracking to service_role;
grant select, insert, update, delete on public.inventory_movements to service_role;
grant select, insert, update, delete on public.crm_followups to service_role;
grant select, insert, update, delete on public.crm_notes to service_role;
grant select, insert, update, delete on public.company_settings to service_role;
grant select, insert, update, delete on public.audit_logs to service_role;
grant select, insert, update, delete on public.error_logs to service_role;
grant select, insert, update, delete on public.backup_logs to service_role;

grant usage, select on all sequences in schema public to anon, authenticated, service_role;

grant execute on function public.write_error_log(text, text, text, text, jsonb) to anon, authenticated, service_role;
grant execute on function public.validate_wholesale_code_public(text) to anon, authenticated, service_role;
grant execute on function public.activate_wholesale_account(text) to authenticated, service_role;
