create or replace function public.confirm_manual_order_payment(target_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text;
  order_record record;
  payment_record record;
begin
  if actor_id is null or not (
    public.has_permission('payments:confirm')
    or public.has_permission('payments:manage')
  ) then
    raise exception 'Solo usuarios autorizados pueden confirmar pagos.';
  end if;

  select orders.id, orders.order_number, orders.status::text as status, orders.payment_method::text as payment_method, orders.payment_timing
  into order_record
  from public.orders
  where orders.id = target_order_id
  for update;

  if order_record.id is null then raise exception 'Pedido no encontrado.'; end if;
  if order_record.status in ('cancelado', 'cancelled') then raise exception 'No se puede confirmar el pago de un pedido cancelado.'; end if;
  if order_record.payment_timing = 'on_delivery' and order_record.status not in ('entregado', 'delivered') then
    raise exception 'El pago al recibir solo se confirma cuando el pedido fue entregado.';
  end if;

  select payments.id, coalesce(payments.payment_status::text, payments.status::text, 'pending') as status
  into payment_record
  from public.payments
  where payments.order_id = target_order_id
  order by payments.created_at desc
  limit 1
  for update;

  if payment_record.id is null then raise exception 'No hay pago registrado para este pedido.'; end if;
  if payment_record.status in ('approved', 'confirmed', 'paid') then raise exception 'El pago ya fue confirmado.'; end if;
  if payment_record.status = 'rejected' then raise exception 'No se puede confirmar un pago rechazado.'; end if;

  select roles.name
  into actor_role
  from public.users
  join public.roles on roles.id = users.role_id
  where users.id = actor_id and users.active = true;

  update public.payments
  set payment_status = 'approved',
      status = 'approved',
      paid_at = now(),
      confirmed_by = actor_id,
      updated_at = now()
  where id = payment_record.id;

  update public.orders
  set reservation_review_required = false,
      reservation_reviewed_at = case when reservation_review_required then now() else reservation_reviewed_at end,
      reservation_reviewed_by = case when reservation_review_required then actor_id else reservation_reviewed_by end,
      reservation_review_reason = case when reservation_review_required then 'Pago confirmado manualmente' else reservation_review_reason end,
      updated_at = now()
  where id = target_order_id;

  update public.internal_notifications
  set status = 'resolved', resolved_at = now(), resolved_by = actor_id, updated_at = now()
  where order_id = target_order_id
    and event_type = 'reservation.expired_review_required'
    and status in ('open', 'reviewing');

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
  values (
    actor_id,
    actor_role,
    'payments',
    payment_record.id,
    'payment.received.confirmed',
    jsonb_build_object('order_id', target_order_id, 'payment_status', payment_record.status, 'payment_method', order_record.payment_method),
    jsonb_build_object('order_id', target_order_id, 'payment_status', 'approved', 'payment_method', order_record.payment_method, 'confirmed_at', now())
  );

  return true;
end;
$$;

grant execute on function public.confirm_manual_order_payment(uuid) to authenticated;
