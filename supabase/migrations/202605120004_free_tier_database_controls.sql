create index if not exists orders_order_number_idx on public.orders(order_number);
create index if not exists orders_tracking_code_idx on public.orders(tracking_code) where tracking_code is not null;
create index if not exists orders_customer_created_at_idx on public.orders(customer_id, created_at desc);
create index if not exists orders_created_at_desc_idx on public.orders(created_at desc);
create index if not exists orders_email_created_at_idx on public.orders(email, created_at desc) where email is not null;

create index if not exists payments_order_created_at_idx on public.payments(order_id, created_at desc);
create index if not exists payments_payment_status_created_at_idx on public.payments(payment_status, created_at desc);
create index if not exists payments_customer_created_at_idx on public.payments(customer_id, created_at desc);

create index if not exists invoices_customer_created_at_idx on public.invoices(customer_id, created_at desc);
create index if not exists invoices_created_at_desc_idx on public.invoices(created_at desc);
create index if not exists invoices_issued_at_desc_idx on public.invoices(issued_at desc) where issued_at is not null;
create index if not exists invoices_status_created_at_idx on public.invoices(status, created_at desc);

create index if not exists crm_followups_status_due_at_idx on public.crm_followups(status, due_at);
create index if not exists crm_notes_created_at_desc_idx on public.crm_notes(created_at desc);
create index if not exists customers_created_at_desc_idx on public.customers(created_at desc);
create index if not exists customers_status_created_at_idx on public.customers(status, created_at desc);

create index if not exists audit_logs_created_at_desc_idx on public.audit_logs(created_at desc);
create index if not exists error_logs_created_at_action_idx on public.error_logs(created_at desc, action);
create index if not exists notification_logs_created_at_status_idx on public.notification_logs(created_at desc, status);

comment on table public.product_images is
  'Product images are stored in Cloudinary or object storage. Supabase stores only URLs, storage paths and provider IDs.';

comment on column public.product_images.public_url is
  'External image URL. Do not store image binaries in Postgres.';

comment on column public.payments.transfer_receipt_url is
  'External receipt URL from Cloudinary or object storage. Do not store receipt binaries in Postgres.';

comment on table public.invoices is
  'Fiscal invoice records only. PDF files should be generated on demand unless a legal retention workflow requires external storage.';

create or replace function public.cleanup_old_operational_logs(retention_days integer default 90)
returns table (
  table_name text,
  deleted_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  cutoff timestamptz := now() - make_interval(days => greatest(coalesce(retention_days, 90), 30));
  deleted_audit integer := 0;
  deleted_errors integer := 0;
  deleted_notifications integer := 0;
begin
  delete from public.audit_logs
  where created_at < cutoff;
  get diagnostics deleted_audit = row_count;

  delete from public.error_logs
  where created_at < cutoff;
  get diagnostics deleted_errors = row_count;

  delete from public.notification_logs
  where created_at < cutoff;
  get diagnostics deleted_notifications = row_count;

  return query values
    ('audit_logs'::text, deleted_audit),
    ('error_logs'::text, deleted_errors),
    ('notification_logs'::text, deleted_notifications);
end;
$$;

revoke all on function public.cleanup_old_operational_logs(integer) from public;
grant execute on function public.cleanup_old_operational_logs(integer) to service_role;
