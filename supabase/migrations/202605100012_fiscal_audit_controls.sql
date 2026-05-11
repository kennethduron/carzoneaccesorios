create or replace function public.current_actor_role()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select roles.name
  from public.users
  left join public.roles on roles.id = users.role_id
  where users.id = auth.uid()
  limit 1
$$;

alter table public.audit_logs
  add column if not exists actor_role text;

update public.audit_logs
set actor_role = roles.name
from public.users
left join public.roles on roles.id = users.role_id
where audit_logs.user_id = users.id
  and audit_logs.actor_role is null;

alter table public.audit_logs
  alter column actor_role set default public.current_actor_role();

create index if not exists audit_logs_actor_role_idx on public.audit_logs(actor_role);
create index if not exists audit_logs_action_created_at_idx on public.audit_logs(action, created_at desc);
create index if not exists invoices_number_issued_at_idx on public.invoices(invoice_number, issued_at);

create or replace function public.write_audit_log(
  target_table text,
  target_record_id uuid,
  action_name text,
  previous_data jsonb default null,
  next_data jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  log_id uuid;
  actor_role_name text := public.current_actor_role();
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    old_data,
    new_data
  )
  values (
    auth.uid(),
    actor_role_name,
    target_table,
    target_record_id,
    action_name,
    previous_data,
    next_data
  )
  returning id into log_id;

  return log_id;
end;
$$;

grant execute on function public.current_actor_role() to authenticated;
grant execute on function public.write_audit_log(text, uuid, text, jsonb, jsonb) to authenticated;

create or replace function public.log_invoice_reprint(target_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  invoice_record public.invoices%rowtype;
  actor_role_name text := public.current_actor_role();
begin
  if not (
    public.has_permission('invoices:create')
    or public.has_permission('invoices:manage')
  ) then
    raise exception 'No tienes permiso para reimprimir facturas fiscales.';
  end if;

  if target_invoice_id is null then
    raise exception 'Selecciona una factura para reimprimir.';
  end if;

  select *
  into invoice_record
  from public.invoices
  where invoices.id = target_invoice_id;

  if invoice_record.id is null then
    raise exception 'No se encontro la factura.';
  end if;

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    new_data
  )
  values (
    auth.uid(),
    actor_role_name,
    'invoices',
    target_invoice_id,
    'fiscal.invoice.reprinted',
    jsonb_build_object(
      'invoice_id', invoice_record.id,
      'invoice_number', invoice_record.invoice_number,
      'order_id', invoice_record.order_id,
      'customer_id', invoice_record.customer_id,
      'customer_name', invoice_record.customer_name,
      'customer_rtn', invoice_record.customer_rtn,
      'cai', invoice_record.cai,
      'company_rtn', invoice_record.rtn,
      'status', invoice_record.status,
      'issued_at', invoice_record.issued_at,
      'subtotal', invoice_record.subtotal,
      'tax', invoice_record.tax,
      'total', invoice_record.total,
      'note', 'Reimpresion conserva numero fiscal, CAI, rango, fecha original, productos y totales.'
    )
  );
end;
$$;

grant execute on function public.log_invoice_reprint(uuid) to authenticated;
