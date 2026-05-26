do $$
declare
  v_protected_user_id uuid := 'a0784ed3-bb00-44f1-8b19-900f0800e858'::uuid;
  v_protected_email text := 'kennethduron.paz@gmail.com';
  v_target_order_number text := 'CZ-260525223822-D012E7';
  v_target_invoice_number text := '000-001-01-00000001';
  v_target_order_id uuid;
  v_target_invoice_id uuid;
  v_invoice_count integer;
  v_invoice_after_count integer;
  v_target_auth_count integer;
  v_target_public_user_count integer;
  v_target_customer_count integer;
  v_protected_count integer;
  v_next_invoice_number text;
  v_current_invoice_number text;
  movement_record record;
begin
  select count(*)
  into v_protected_count
  from auth.users au
  join public.users u on u.id = au.id
  join public.roles r on r.id = u.role_id
  where au.id = v_protected_user_id
    and lower(au.email) = v_protected_email
    and u.id = v_protected_user_id
    and lower(u.email) = v_protected_email
    and u.active = true
    and r.name in ('admin', 'technical_owner');

  if v_protected_count <> 1 then
    raise exception 'Cleanup aborted: protected technical account is not intact.';
  end if;

  select count(*)
  into v_target_auth_count
  from auth.users
  where lower(email) in ('kencodehn@gmail.com', 'kennethduron08@gmail.com');

  if v_target_auth_count <> 0 then
    raise exception 'Cleanup aborted: target test auth users still exist.';
  end if;

  select count(*)
  into v_target_public_user_count
  from public.users
  where lower(email) in ('kencodehn@gmail.com', 'kennethduron08@gmail.com');

  if v_target_public_user_count <> 0 then
    raise exception 'Cleanup aborted: target test public users still exist.';
  end if;

  select count(*)
  into v_target_customer_count
  from public.customers
  where lower(email) in ('kencodehn@gmail.com', 'kennethduron08@gmail.com');

  if v_target_customer_count <> 0 then
    raise exception 'Cleanup aborted: target test customers still exist.';
  end if;

  select id
  into v_target_order_id
  from public.orders
  where order_number = v_target_order_number;

  select id
  into v_target_invoice_id
  from public.invoices
  where invoice_number = v_target_invoice_number;

  if v_target_order_id is null or v_target_invoice_id is null then
    raise exception 'Cleanup aborted: target order or invoice was not found.';
  end if;

  if not exists (
    select 1
    from public.invoices
    where id = v_target_invoice_id
      and order_id = v_target_order_id
      and invoice_number = v_target_invoice_number
  ) then
    raise exception 'Cleanup aborted: invoice is not linked to the expected order.';
  end if;

  select count(*)
  into v_invoice_count
  from public.invoices;

  select count(*)
  into v_invoice_after_count
  from public.invoices i
  where i.created_at > (
    select created_at
    from public.invoices
    where id = v_target_invoice_id
  );

  if v_invoice_count <> 1 or v_invoice_after_count <> 0 then
    raise exception 'Cleanup aborted: fiscal correlatives exist after the target test invoice.';
  end if;

  v_next_invoice_number := public.increment_fiscal_invoice_number(v_target_invoice_number);

  select nullif(trim(coalesce(current_invoice_number, '')), '')
  into v_current_invoice_number
  from public.fiscal_settings
  where id = true
  for update;

  if v_current_invoice_number is not null
    and v_current_invoice_number not in (v_target_invoice_number, v_next_invoice_number)
  then
    raise exception 'Cleanup aborted: fiscal current invoice number (%) is not compatible with deleting the target test invoice.', v_current_invoice_number;
  end if;

  for movement_record in
    select product_id, sum(abs(quantity))::integer as restore_quantity
    from public.inventory_movements
    where reference_type = 'orders'
      and reference_id = v_target_order_id
      and movement_type = 'sale'
      and quantity < 0
    group by product_id
  loop
    update public.products
    set
      stock = stock + movement_record.restore_quantity,
      updated_at = now()
    where id = movement_record.product_id;
  end loop;

  update public.products p
  set
    reserved_stock = greatest(coalesce(p.reserved_stock, 0) - r.reserved_quantity, 0),
    updated_at = now()
  from (
    select product_id, sum(quantity)::integer as reserved_quantity
    from public.inventory_reservations
    where order_id = v_target_order_id
      and status in ('reserved', 'pending')
    group by product_id
  ) r
  where p.id = r.product_id;

  delete from public.notification_logs
  where order_id = v_target_order_id;

  delete from public.audit_logs
  where record_id in (v_target_order_id, v_target_invoice_id)
    and table_name in ('orders', 'invoices', 'payments', 'inventory_movements', 'inventory_reservations');

  delete from public.inventory_movements
  where reference_type = 'orders'
    and reference_id = v_target_order_id;

  delete from public.inventory_reservations
  where order_id = v_target_order_id;

  delete from public.crm_notes
  where order_id = v_target_order_id;

  delete from public.crm_followups
  where order_id = v_target_order_id;

  delete from public.shipment_tracking
  where order_id = v_target_order_id;

  delete from public.invoice_items
  where invoice_id = v_target_invoice_id;

  delete from public.invoices
  where id = v_target_invoice_id;

  delete from public.payments
  where order_id = v_target_order_id;

  delete from public.order_items
  where order_id = v_target_order_id;

  delete from public.orders
  where id = v_target_order_id;

  update public.fiscal_settings
  set
    current_invoice_number = v_target_invoice_number,
    updated_at = now()
  where id = true
    and v_current_invoice_number = v_next_invoice_number;
end;
$$;
