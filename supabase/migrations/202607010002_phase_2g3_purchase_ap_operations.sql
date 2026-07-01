create or replace function public.register_supplier_payment(
  target_accounts_payable_id uuid,
  payment_amount numeric,
  payment_method text,
  payment_paid_at timestamptz default now(),
  payment_notes text default null
)
returns table (
  payment_id uuid,
  accounts_payable_status text,
  paid_amount numeric,
  balance numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  payable_row public.accounts_payable%rowtype;
  saved_payment public.supplier_payments%rowtype;
  next_paid numeric(12, 2);
  next_status text;
begin
  if auth.uid() is null or not public.has_permission('payables:manage') then
    raise exception 'No tienes permiso para registrar pagos a proveedores.';
  end if;

  if payment_amount is null or payment_amount <= 0 then
    raise exception 'El pago debe ser mayor que cero.';
  end if;

  if payment_method is null or char_length(trim(payment_method)) = 0 then
    raise exception 'El metodo de pago es obligatorio.';
  end if;

  select *
    into payable_row
    from public.accounts_payable
    where id = target_accounts_payable_id
    for update;

  if not found then
    raise exception 'La cuenta por pagar no existe.';
  end if;

  if payable_row.status in ('paid', 'cancelled') then
    raise exception 'Esta cuenta por pagar ya no admite pagos.';
  end if;

  if payment_amount > payable_row.balance then
    raise exception 'El pago no puede exceder el saldo pendiente.';
  end if;

  next_paid := round((payable_row.paid_amount + payment_amount)::numeric, 2);
  next_status := case
    when next_paid >= payable_row.total_amount then 'paid'
    when next_paid > 0 then 'partial'
    else 'pending'
  end;

  insert into public.supplier_payments (
    accounts_payable_id,
    supplier_id,
    amount,
    payment_method,
    status,
    paid_at,
    notes,
    created_by
  )
  values (
    payable_row.id,
    payable_row.supplier_id,
    round(payment_amount::numeric, 2),
    trim(payment_method),
    'paid',
    coalesce(payment_paid_at, now()),
    nullif(trim(coalesce(payment_notes, '')), ''),
    auth.uid()
  )
  returning * into saved_payment;

  update public.accounts_payable
  set paid_amount = next_paid,
      status = next_status,
      updated_at = now()
  where id = payable_row.id
  returning * into payable_row;

  if payable_row.supplier_invoice_id is not null then
    update public.supplier_invoices
    set status = case when next_status = 'paid' then 'paid' else 'posted_to_ap' end,
        updated_at = now()
    where id = payable_row.supplier_invoice_id
      and status <> 'cancelled';
  end if;

  payment_id := saved_payment.id;
  accounts_payable_status := payable_row.status;
  paid_amount := payable_row.paid_amount;
  balance := payable_row.balance;
  return next;
end;
$$;

create or replace function public.void_supplier_payment(
  target_supplier_payment_id uuid,
  void_notes text default null
)
returns table (
  payment_id uuid,
  accounts_payable_id uuid,
  accounts_payable_status text,
  paid_amount numeric,
  balance numeric
)
language plpgsql
security definer
set search_path = public
as $$
declare
  payment_row public.supplier_payments%rowtype;
  payable_row public.accounts_payable%rowtype;
  next_paid numeric(12, 2);
  next_status text;
begin
  if auth.uid() is null or not public.has_permission('payables:manage') then
    raise exception 'No tienes permiso para anular pagos a proveedores.';
  end if;

  select *
    into payment_row
    from public.supplier_payments
    where id = target_supplier_payment_id
    for update;

  if not found then
    raise exception 'El pago a proveedor no existe.';
  end if;

  if payment_row.status <> 'paid' then
    raise exception 'Solo se pueden anular pagos registrados como pagados.';
  end if;

  select *
    into payable_row
    from public.accounts_payable
    where id = payment_row.accounts_payable_id
    for update;

  if not found then
    raise exception 'La cuenta por pagar no existe.';
  end if;

  if payable_row.status = 'cancelled' then
    raise exception 'No se puede anular un pago de una cuenta cancelada.';
  end if;

  next_paid := greatest(round((payable_row.paid_amount - payment_row.amount)::numeric, 2), 0);
  next_status := case
    when next_paid <= 0 then 'pending'
    when next_paid < payable_row.total_amount then 'partial'
    else 'paid'
  end;

  update public.supplier_payments
  set status = 'voided',
      voided_by = auth.uid(),
      voided_at = now(),
      notes = case
        when nullif(trim(coalesce(void_notes, '')), '') is null then notes
        when notes is null or trim(notes) = '' then trim(void_notes)
        else notes || E'\nAnulacion: ' || trim(void_notes)
      end,
      updated_at = now()
  where id = payment_row.id
  returning * into payment_row;

  update public.accounts_payable
  set paid_amount = next_paid,
      status = next_status,
      updated_at = now()
  where id = payable_row.id
  returning * into payable_row;

  if payable_row.supplier_invoice_id is not null then
    update public.supplier_invoices
    set status = case when next_status = 'paid' then 'paid' else 'posted_to_ap' end,
        updated_at = now()
    where id = payable_row.supplier_invoice_id
      and status <> 'cancelled';
  end if;

  payment_id := payment_row.id;
  accounts_payable_id := payable_row.id;
  accounts_payable_status := payable_row.status;
  paid_amount := payable_row.paid_amount;
  balance := payable_row.balance;
  return next;
end;
$$;

revoke all on function public.register_supplier_payment(uuid, numeric, text, timestamptz, text) from public, anon;
revoke all on function public.void_supplier_payment(uuid, text) from public, anon;
grant execute on function public.register_supplier_payment(uuid, numeric, text, timestamptz, text) to authenticated, service_role;
grant execute on function public.void_supplier_payment(uuid, text) to authenticated, service_role;
