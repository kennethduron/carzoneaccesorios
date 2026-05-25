-- Release reserved stock when a payment is explicitly rejected.
-- Approved payments are already converted to final inventory sales by
-- apply_order_sale_inventory_on_payment_approval.

create or replace function public.release_order_reservation_from_rejected_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.order_id is null then
    return new;
  end if;

  if coalesce(new.payment_status::text, new.status::text) = 'rejected'
    or coalesce(new.status::text, new.payment_status::text) = 'rejected'
  then
    perform public.release_order_reservation(
      new.order_id,
      'released',
      'Pago rechazado: reserva liberada automaticamente',
      null
    );
  end if;

  return new;
end;
$$;

drop trigger if exists release_order_reservation_on_payment_rejection on public.payments;

create trigger release_order_reservation_on_payment_rejection
after insert or update of payment_status, status on public.payments
for each row
when (new.payment_status = 'rejected' or new.status = 'rejected')
execute function public.release_order_reservation_from_rejected_payment();
