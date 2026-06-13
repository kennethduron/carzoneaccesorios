create table if not exists public.customer_credit_accounts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references public.customers(id) on delete cascade,
  is_credit_enabled boolean not null default false,
  credit_limit numeric(12, 2) not null default 0 check (credit_limit >= 0),
  terms_days integer not null default 30 check (terms_days between 1 and 365),
  status text not null default 'active' check (status in ('active', 'suspended')),
  activated_at timestamptz,
  activated_by uuid references public.users(id) on delete set null,
  suspended_at timestamptz,
  suspended_by uuid references public.users(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.accounts_receivable (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  order_id uuid not null unique references public.orders(id) on delete restrict,
  invoice_id uuid unique references public.invoices(id) on delete set null,
  original_amount numeric(12, 2) not null check (original_amount > 0),
  balance_due numeric(12, 2) not null check (balance_due >= 0),
  due_date date not null,
  status text not null default 'open' check (status in ('open', 'paid', 'overdue')),
  paid_at timestamptz,
  overdue_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounts_receivable_no_partial_payments check (
    (status = 'paid' and balance_due = 0 and paid_at is not null)
    or (status in ('open', 'overdue') and balance_due = original_amount and paid_at is null)
  )
);

create index if not exists customer_credit_accounts_customer_status_idx
  on public.customer_credit_accounts(customer_id, is_credit_enabled, status);

create index if not exists accounts_receivable_customer_status_idx
  on public.accounts_receivable(customer_id, status);

create index if not exists accounts_receivable_due_status_idx
  on public.accounts_receivable(status, due_date);

alter table public.customer_credit_accounts enable row level security;
alter table public.accounts_receivable enable row level security;

drop policy if exists customer_credit_accounts_select on public.customer_credit_accounts;
create policy customer_credit_accounts_select
  on public.customer_credit_accounts for select
  using (
    public.has_permission('credit:read')
    or public.has_permission('credit:manage')
    or exists (
      select 1
      from public.customers
      where customers.id = customer_credit_accounts.customer_id
        and customers.user_id = auth.uid()
        and customer_credit_accounts.is_credit_enabled = true
        and customer_credit_accounts.status = 'active'
    )
  );

drop policy if exists customer_credit_accounts_insert on public.customer_credit_accounts;
create policy customer_credit_accounts_insert
  on public.customer_credit_accounts for insert
  with check (public.has_permission('credit:manage'));

drop policy if exists customer_credit_accounts_update on public.customer_credit_accounts;
create policy customer_credit_accounts_update
  on public.customer_credit_accounts for update
  using (public.has_permission('credit:manage'))
  with check (public.has_permission('credit:manage'));

drop policy if exists accounts_receivable_select on public.accounts_receivable;
create policy accounts_receivable_select
  on public.accounts_receivable for select
  using (
    public.has_permission('receivables:read')
    or public.has_permission('credit:manage')
    or exists (
      select 1
      from public.customers
      join public.customer_credit_accounts
        on customer_credit_accounts.customer_id = customers.id
      where customers.id = accounts_receivable.customer_id
        and customers.user_id = auth.uid()
        and customer_credit_accounts.is_credit_enabled = true
        and customer_credit_accounts.status = 'active'
    )
  );

drop policy if exists accounts_receivable_insert on public.accounts_receivable;
create policy accounts_receivable_insert
  on public.accounts_receivable for insert
  with check (public.has_permission('credit:manage'));

drop policy if exists accounts_receivable_update on public.accounts_receivable;
create policy accounts_receivable_update
  on public.accounts_receivable for update
  using (public.has_permission('credit:manage'))
  with check (public.has_permission('credit:manage'));

grant select on public.customer_credit_accounts to authenticated;
grant select on public.accounts_receivable to authenticated;
grant select, insert, update, delete on public.customer_credit_accounts to service_role;
grant select, insert, update, delete on public.accounts_receivable to service_role;

update public.roles
set permissions = permissions || '["credit:read","credit:manage","credit:mark_paid","receivables:read","receivables:export"]'::jsonb,
    updated_at = now()
where name in ('technical_owner', 'business_owner', 'admin');

update public.roles
set permissions = permissions || '["credit:read","receivables:read","receivables:export"]'::jsonb,
    updated_at = now()
where name = 'contadora';

insert into public.notification_preferences (
  notification_type,
  module,
  label,
  internal_enabled,
  email_enabled,
  push_enabled,
  destination_roles,
  technical_only
)
values
  ('credit.due_7_days', 'pagos', 'Credito vence en 7 dias', true, false, false, array['business_owner','admin','contadora'], false),
  ('credit.due_3_days', 'pagos', 'Credito vence en 3 dias', true, false, false, array['business_owner','admin','contadora'], false),
  ('credit.due_1_day', 'pagos', 'Credito vence manana', true, false, false, array['business_owner','admin','contadora'], false),
  ('credit.overdue', 'pagos', 'Credito comercial vencido', true, false, false, array['business_owner','admin','contadora'], false)
on conflict (notification_type) do update
set module = excluded.module,
    label = excluded.label,
    internal_enabled = excluded.internal_enabled,
    destination_roles = excluded.destination_roles,
    updated_at = now();

create or replace function public.commercial_credit_manage_allowed()
returns boolean
language sql
security definer
set search_path = public
as $$
  select public.current_actor_role() in ('technical_owner', 'business_owner', 'admin')
    and public.has_permission('credit:manage');
$$;

grant execute on function public.commercial_credit_manage_allowed() to authenticated;

create or replace function public.set_customer_commercial_credit(
  target_customer_id uuid,
  credit_enabled boolean,
  target_credit_limit numeric,
  target_terms_days integer,
  target_status text default 'active',
  internal_notes text default null
)
returns table (
  credit_account_id uuid,
  is_credit_enabled boolean,
  credit_limit numeric,
  terms_days integer,
  status text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  previous_row public.customer_credit_accounts%rowtype;
  saved_row public.customer_credit_accounts%rowtype;
  normalized_status text := case when credit_enabled then coalesce(nullif(target_status, ''), 'active') else 'suspended' end;
  normalized_limit numeric(12, 2) := round(coalesce(target_credit_limit, 0), 2);
  normalized_terms integer := coalesce(target_terms_days, 30);
  action_name text := 'commercial_credit.updated';
begin
  if not public.commercial_credit_manage_allowed() then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      actor_id,
      actor_role_name,
      'customer_credit_accounts',
      target_customer_id,
      'commercial_credit.permission_denied',
      jsonb_build_object('customer_id', target_customer_id, 'attempted_status', target_status, 'credit_enabled', credit_enabled)
    );
    raise exception 'Solo usuarios autorizados pueden modificar crédito comercial.';
  end if;

  if normalized_status not in ('active', 'suspended') then
    raise exception 'Estado de crédito inválido.';
  end if;

  if normalized_limit < 0 then
    raise exception 'El límite de crédito no puede ser negativo.';
  end if;

  if normalized_terms < 1 or normalized_terms > 365 then
    raise exception 'El plazo de crédito debe estar entre 1 y 365 días.';
  end if;

  if credit_enabled and normalized_status = 'active' and normalized_limit <= 0 then
    raise exception 'El límite de crédito debe ser mayor a cero.';
  end if;

  if not exists (select 1 from public.customers where id = target_customer_id) then
    raise exception 'Cliente no encontrado.';
  end if;

  select *
  into previous_row
  from public.customer_credit_accounts
  where customer_id = target_customer_id
  for update;

  insert into public.customer_credit_accounts (
    customer_id,
    is_credit_enabled,
    credit_limit,
    terms_days,
    status,
    activated_at,
    activated_by,
    suspended_at,
    suspended_by,
    notes
  )
  values (
    target_customer_id,
    credit_enabled,
    normalized_limit,
    normalized_terms,
    normalized_status,
    case when credit_enabled then now() else null end,
    case when credit_enabled then actor_id else null end,
    case when not credit_enabled or normalized_status = 'suspended' then now() else null end,
    case when not credit_enabled or normalized_status = 'suspended' then actor_id else null end,
    nullif(trim(coalesce(internal_notes, '')), '')
  )
  on conflict (customer_id) do update
  set is_credit_enabled = excluded.is_credit_enabled,
      credit_limit = excluded.credit_limit,
      terms_days = excluded.terms_days,
      status = excluded.status,
      activated_at = case
        when excluded.is_credit_enabled and not customer_credit_accounts.is_credit_enabled then now()
        else customer_credit_accounts.activated_at
      end,
      activated_by = case
        when excluded.is_credit_enabled and not customer_credit_accounts.is_credit_enabled then actor_id
        else customer_credit_accounts.activated_by
      end,
      suspended_at = case
        when not excluded.is_credit_enabled or excluded.status = 'suspended' then now()
        when customer_credit_accounts.status = 'suspended' and excluded.status = 'active' then null
        else customer_credit_accounts.suspended_at
      end,
      suspended_by = case
        when not excluded.is_credit_enabled or excluded.status = 'suspended' then actor_id
        when customer_credit_accounts.status = 'suspended' and excluded.status = 'active' then null
        else customer_credit_accounts.suspended_by
      end,
      notes = excluded.notes,
      updated_at = now()
  returning * into saved_row;

  if previous_row.id is null and credit_enabled then
    action_name := 'commercial_credit.activated';
  elsif previous_row.id is not null and previous_row.is_credit_enabled = false and credit_enabled then
    action_name := 'commercial_credit.activated';
  elsif previous_row.id is not null and previous_row.is_credit_enabled = true and not credit_enabled then
    action_name := 'commercial_credit.deactivated';
  elsif previous_row.id is not null and previous_row.status <> saved_row.status and saved_row.status = 'suspended' then
    action_name := 'commercial_credit.suspended';
  elsif previous_row.id is not null and previous_row.status = 'suspended' and saved_row.status = 'active' then
    action_name := 'commercial_credit.reactivated';
  end if;

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
  values (
    actor_id,
    actor_role_name,
    'customer_credit_accounts',
    saved_row.id,
    action_name,
    case when previous_row.id is null then null else to_jsonb(previous_row) end,
    to_jsonb(saved_row)
  );

  credit_account_id := saved_row.id;
  is_credit_enabled := saved_row.is_credit_enabled;
  credit_limit := saved_row.credit_limit;
  terms_days := saved_row.terms_days;
  status := saved_row.status;
  return next;
end;
$$;

grant execute on function public.set_customer_commercial_credit(uuid, boolean, numeric, integer, text, text) to authenticated;

create or replace function public.mark_credit_receivable_paid(target_receivable_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  receivable_record record;
begin
  if not (
    actor_role_name in ('technical_owner', 'business_owner', 'admin')
    and public.has_permission('credit:mark_paid')
  ) then
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      actor_id,
      actor_role_name,
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.permission_denied',
      jsonb_build_object('action', 'mark_paid')
    );
    raise exception 'Solo usuarios autorizados pueden marcar crédito como pagado.';
  end if;

  select *
  into receivable_record
  from public.accounts_receivable
  where id = target_receivable_id
  for update;

  if receivable_record.id is null then
    raise exception 'Cuenta por cobrar no encontrada.';
  end if;

  if receivable_record.status = 'paid' then
    raise exception 'Esta cuenta por cobrar ya está pagada.';
  end if;

  update public.accounts_receivable
  set status = 'paid',
      balance_due = 0,
      paid_at = now(),
      updated_at = now()
  where id = target_receivable_id;

  update public.payments
  set payment_status = 'approved',
      status = 'approved',
      paid_at = now(),
      updated_at = now()
  where order_id = receivable_record.order_id
    and payment_method = 'commercial_credit';

  update public.email_queue
  set status = 'cancelled',
      updated_at = now()
  where related_id = target_receivable_id
    and template_key in (
      'commercial_credit.reminder_7_days',
      'commercial_credit.reminder_3_days',
      'commercial_credit.reminder_1_day',
      'commercial_credit.overdue'
    )
    and status in ('pending', 'retrying');

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
  values (
    actor_id,
    actor_role_name,
    'accounts_receivable',
    target_receivable_id,
    'commercial_credit.receivable_paid',
    to_jsonb(receivable_record),
    jsonb_build_object('status', 'paid', 'balance_due', 0, 'paid_at', now(), 'order_id', receivable_record.order_id)
  );

  return true;
end;
$$;

grant execute on function public.mark_credit_receivable_paid(uuid) to authenticated;

create or replace function public.mark_overdue_accounts_receivable(max_rows integer default 200)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_count integer := 0;
  item record;
begin
  for item in
    select *
    from public.accounts_receivable
    where status = 'open'
      and due_date < current_date
    order by due_date asc
    limit greatest(coalesce(max_rows, 200), 1)
    for update
  loop
    update public.accounts_receivable
    set status = 'overdue',
        overdue_at = coalesce(overdue_at, now()),
        updated_at = now()
    where id = item.id;

    insert into public.audit_logs (actor_role, table_name, record_id, action, old_data, new_data)
    values (
      public.current_actor_role(),
      'accounts_receivable',
      item.id,
      'commercial_credit.overdue',
      to_jsonb(item),
      jsonb_build_object('status', 'overdue', 'overdue_at', now(), 'due_date', item.due_date)
    );

    updated_count := updated_count + 1;
  end loop;

  return updated_count;
end;
$$;

grant execute on function public.mark_overdue_accounts_receivable(integer) to authenticated, service_role;

create or replace function public.link_accounts_receivable_invoice()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.accounts_receivable
  set invoice_id = new.id,
      updated_at = now()
  where order_id = new.order_id
    and invoice_id is null;
  return new;
end;
$$;

drop trigger if exists link_accounts_receivable_invoice_on_insert on public.invoices;
create trigger link_accounts_receivable_invoice_on_insert
after insert on public.invoices
for each row
execute function public.link_accounts_receivable_invoice();

create or replace function public.apply_credit_inventory_on_delivery()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.payment_method = 'commercial_credit'
     and new.status::text in ('entregado', 'delivered')
     and coalesce(old.status::text, 'recibido') not in ('entregado', 'delivered') then
    perform public.apply_order_sale_inventory(new.id, auth.uid());
    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
    values (
      auth.uid(),
      public.current_actor_role(),
      'orders',
      new.id,
      'commercial_credit.inventory_confirmed_on_delivery',
      jsonb_build_object('previous_status', old.status, 'payment_method', old.payment_method),
      jsonb_build_object('status', new.status, 'payment_method', new.payment_method)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists apply_credit_inventory_on_delivery_order_update on public.orders;
create trigger apply_credit_inventory_on_delivery_order_update
after update of status on public.orders
for each row
execute function public.apply_credit_inventory_on_delivery();

create or replace function public.apply_order_sale_inventory_from_approved_payment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  order_record public.orders%rowtype;
begin
  if new.payment_status = 'approved' or new.status = 'approved' then
    select *
    into order_record
    from public.orders
    where orders.id = new.order_id
    for update;

    if order_record.payment_method = 'commercial_credit' then
      return new;
    end if;

    perform public.apply_order_sale_inventory(new.order_id, order_record.user_id);

    update public.orders
    set status = case
          when orders.status::text in ('pending', 'recibido', 'paid') then 'confirmado'::public.order_status
          else orders.status
        end,
        tracking_status = case
          when orders.status::text in ('pending', 'recibido', 'paid') then 'confirmado'
          else coalesce(orders.tracking_status, orders.status::text)
        end,
        updated_at = now()
    where orders.id = new.order_id;
  end if;

  return new;
end;
$$;

create or replace function public.cancel_receivable_for_cancelled_credit_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  receivable_record public.accounts_receivable%rowtype;
begin
  if new.payment_method = 'commercial_credit'
     and new.status::text in ('cancelado', 'cancelled')
     and coalesce(old.status::text, '') not in ('cancelado', 'cancelled') then
    select *
    into receivable_record
    from public.accounts_receivable
    where order_id = new.id
      and status in ('open', 'overdue')
    for update;

    if receivable_record.id is not null then
      update public.email_queue
      set status = 'cancelled',
          updated_at = now()
      where related_id = receivable_record.id
        and template_key like 'commercial_credit.%'
        and status in ('pending', 'retrying');

      delete from public.accounts_receivable
      where id = receivable_record.id;

      insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
      values (
        auth.uid(),
        public.current_actor_role(),
        'accounts_receivable',
        receivable_record.id,
        'commercial_credit.receivable_cancelled_with_order',
        to_jsonb(receivable_record),
        jsonb_build_object('order_id', new.id, 'order_status', new.status)
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists cancel_receivable_on_credit_order_cancel on public.orders;
create trigger cancel_receivable_on_credit_order_cancel
after update of status on public.orders
for each row
execute function public.cancel_receivable_for_cancelled_credit_order();

create or replace function public.create_checkout_order_v2(
  customer_name text,
  customer_email text,
  customer_phone text,
  customer_rtn text,
  delivery_address text,
  requested_price_mode public.order_price_mode,
  requested_payment_method public.payment_method,
  bank_reference_number text,
  order_items jsonb,
  wholesale_code text default null,
  wholesale_code_id uuid default null,
  transfer_receipt_url text default null,
  delivery_country text default 'Honduras',
  country_code text default 'HN',
  delivery_department text default null,
  delivery_city text default null,
  requested_payment_timing text default null
)
returns table (
  order_id uuid,
  order_number text,
  tracking_code text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  created_order record;
  normalized_payment_timing text := case
    when requested_payment_method = 'cash' then 'on_delivery'
    when requested_payment_method = 'card' then 'before_delivery'
    when requested_payment_method = 'commercial_credit' then 'before_delivery'
    when requested_payment_timing = 'on_delivery' then 'on_delivery'
    else 'before_delivery'
  end;
  reference_for_checkout text := bank_reference_number;
  reservation_minutes integer := 2880;
  reservation_deadline timestamptz;
  cod_percentage numeric(6, 2) := 5;
  cod_enabled boolean := true;
  recalculated_cod numeric(12, 2) := 0;
  recalculated_total numeric(12, 2) := 0;
  extra_fees numeric(12, 2) := 0;
  credit_account record;
  open_credit_balance numeric(12, 2) := 0;
  receivable_id uuid;
begin
  if requested_payment_method = 'bank_transfer'
     and normalized_payment_timing = 'before_delivery'
     and nullif(trim(coalesce(bank_reference_number, '')), '') is null then
    raise exception 'Ingresa el numero de referencia bancaria.';
  end if;

  if requested_payment_method = 'commercial_credit' then
    if auth.uid() is null then
      raise exception 'Inicia sesión con una cuenta autorizada para usar crédito comercial.';
    end if;

    select
      customer_credit_accounts.*,
      customers.id as linked_customer_id
    into credit_account
    from public.customers
    join public.customer_credit_accounts
      on customer_credit_accounts.customer_id = customers.id
    where customers.user_id = auth.uid()
      and customers.active = true
      and customer_credit_accounts.is_credit_enabled = true
      and customer_credit_accounts.status = 'active'
    order by customer_credit_accounts.updated_at desc
    limit 1
    for update of customer_credit_accounts;

    if credit_account.id is null then
      raise exception 'Tu cuenta no tiene crédito comercial activo.';
    end if;

    reference_for_checkout := 'CREDITO COMERCIAL';
  end if;

  if requested_payment_method = 'bank_transfer' and normalized_payment_timing = 'on_delivery' then
    reference_for_checkout := 'PENDIENTE CONTRA ENTREGA';
  end if;

  select *
  into created_order
  from public.create_checkout_order(
    customer_name,
    customer_email,
    customer_phone,
    customer_rtn,
    delivery_address,
    requested_price_mode,
    requested_payment_method,
    reference_for_checkout,
    order_items,
    wholesale_code,
    wholesale_code_id,
    transfer_receipt_url,
    delivery_country,
    country_code,
    delivery_department,
    delivery_city
  )
  limit 1;

  select
    coalesce(company_settings.stock_reservation_minutes, 2880),
    coalesce(company_settings.cash_on_delivery_percentage, 5),
    coalesce(company_settings.enable_cash_on_delivery_fee, true)
  into reservation_minutes, cod_percentage, cod_enabled
  from public.company_settings
  order by company_settings.created_at asc
  limit 1;

  reservation_deadline := now() + make_interval(mins => greatest(coalesce(reservation_minutes, 2880), 15));

  update public.inventory_reservations
  set expires_at = reservation_deadline,
      updated_at = now()
  where inventory_reservations.order_id = created_order.order_id
    and status = 'reserved';

  select coalesce(sum(
    case
      when fee.value ? 'amount' then (fee.value->>'amount')::numeric
      when fee.value ? 'total' then (fee.value->>'total')::numeric
      else 0
    end
  ), 0)
  into extra_fees
  from public.orders
  left join lateral jsonb_array_elements(coalesce(orders.additional_fees, '[]'::jsonb)) as fee(value) on true
  where orders.id = created_order.order_id;

  select case
    when normalized_payment_timing = 'on_delivery' and cod_enabled
      then round(orders.subtotal * (cod_percentage / 100), 2)
    else 0
  end
  into recalculated_cod
  from public.orders
  where orders.id = created_order.order_id;

  update public.orders
  set customer_id = case
        when requested_payment_method = 'commercial_credit' then credit_account.linked_customer_id
        else customer_id
      end,
      payment_timing = normalized_payment_timing,
      reservation_expires_at = reservation_deadline,
      cash_on_delivery_fee = recalculated_cod,
      total = round(
        subtotal
        + tax
        + shipping_fee
        + recalculated_cod
        + coalesce(small_order_fee, 0)
        + coalesce(extra_fees, 0)
        - coalesce(discount_total, 0),
        2
      ),
      updated_at = now()
  where orders.id = created_order.order_id
  returning orders.total into recalculated_total;

  update public.payments
  set customer_id = case
        when requested_payment_method = 'commercial_credit' then credit_account.linked_customer_id
        else customer_id
      end,
      payment_timing = normalized_payment_timing,
      bank_reference_number = case
        when requested_payment_method = 'bank_transfer' and normalized_payment_timing = 'on_delivery' then null
        when requested_payment_method = 'commercial_credit' then null
        else create_checkout_order_v2.bank_reference_number
      end,
      reference = case
        when requested_payment_method = 'bank_transfer' and normalized_payment_timing = 'on_delivery' then null
        when requested_payment_method = 'commercial_credit' then null
        else reference
      end,
      amount = recalculated_total,
      updated_at = now()
  where payments.order_id = created_order.order_id;

  update public.invoices
  set customer_id = case
        when requested_payment_method = 'commercial_credit' then credit_account.linked_customer_id
        else customer_id
      end,
      cash_on_delivery_fee = recalculated_cod,
      total = recalculated_total,
      updated_at = now()
  where invoices.order_id = created_order.order_id
    and invoices.status = 'draft';

  if requested_payment_method = 'commercial_credit' then
    select coalesce(sum(balance_due), 0)
    into open_credit_balance
    from public.accounts_receivable
    where customer_id = credit_account.linked_customer_id
      and status in ('open', 'overdue');

    if open_credit_balance + recalculated_total > credit_account.credit_limit then
      raise exception 'Este pedido supera el crédito autorizado para este cliente.';
    end if;

    delete from public.invoices
    where invoices.order_id = created_order.order_id
      and invoices.status = 'draft';

    insert into public.accounts_receivable (
      customer_id,
      order_id,
      original_amount,
      balance_due,
      due_date,
      status
    )
    values (
      credit_account.linked_customer_id,
      created_order.order_id,
      recalculated_total,
      recalculated_total,
      (current_date + credit_account.terms_days),
      'open'
    )
    returning id into receivable_id;

    insert into public.email_queue (
      to_email,
      to_name,
      subject,
      template_key,
      payload,
      status,
      scheduled_at,
      related_module,
      related_id,
      priority,
      idempotency_key
    )
    values
      (
        lower(trim(customer_email)),
        customer_name,
        'Credito comercial creado - ' || created_order.order_number,
        'commercial_credit.created',
        jsonb_build_object(
          'title', 'Credito comercial creado',
          'message', 'Tu pedido fue creado con credito comercial. El pago debe realizarse completo antes de la fecha limite.',
          'order_number', created_order.order_number,
          'status', 'Abierto',
          'amount', recalculated_total,
          'due_at', (current_date + credit_account.terms_days),
          'action_path', '/cuenta',
          'action_label', 'Ver mi cuenta'
        ),
        'pending',
        now(),
        'pagos',
        receivable_id,
        3,
        'commercial_credit.created:' || receivable_id::text
      ),
      (
        lower(trim(customer_email)),
        customer_name,
        'Tu credito vence en 7 dias - ' || created_order.order_number,
        'commercial_credit.reminder_7_days',
        jsonb_build_object(
          'title', 'Tu credito vence en 7 dias',
          'message', 'Recuerda realizar el pago completo de tu credito comercial antes de la fecha limite.',
          'order_number', created_order.order_number,
          'status', 'Abierto',
          'amount', recalculated_total,
          'due_at', (current_date + credit_account.terms_days),
          'action_path', '/cuenta',
          'action_label', 'Ver mi cuenta'
        ),
        'pending',
        (((current_date + credit_account.terms_days - 7)::date + time '08:00') at time zone 'America/Tegucigalpa'),
        'pagos',
        receivable_id,
        4,
        'commercial_credit.reminder_7_days:' || receivable_id::text
      ),
      (
        lower(trim(customer_email)),
        customer_name,
        'Tu credito vence en 3 dias - ' || created_order.order_number,
        'commercial_credit.reminder_3_days',
        jsonb_build_object(
          'title', 'Tu credito vence en 3 dias',
          'message', 'Tu cuenta por cobrar se acerca a su vencimiento. El pago debe realizarse completo.',
          'order_number', created_order.order_number,
          'status', 'Abierto',
          'amount', recalculated_total,
          'due_at', (current_date + credit_account.terms_days),
          'action_path', '/cuenta',
          'action_label', 'Ver mi cuenta'
        ),
        'pending',
        (((current_date + credit_account.terms_days - 3)::date + time '08:00') at time zone 'America/Tegucigalpa'),
        'pagos',
        receivable_id,
        3,
        'commercial_credit.reminder_3_days:' || receivable_id::text
      ),
      (
        lower(trim(customer_email)),
        customer_name,
        'Tu credito vence manana - ' || created_order.order_number,
        'commercial_credit.reminder_1_day',
        jsonb_build_object(
          'title', 'Tu credito vence manana',
          'message', 'Realiza el pago completo de tu credito comercial antes de la fecha limite.',
          'order_number', created_order.order_number,
          'status', 'Abierto',
          'amount', recalculated_total,
          'due_at', (current_date + credit_account.terms_days),
          'action_path', '/cuenta',
          'action_label', 'Ver mi cuenta'
        ),
        'pending',
        (((current_date + credit_account.terms_days - 1)::date + time '08:00') at time zone 'America/Tegucigalpa'),
        'pagos',
        receivable_id,
        2,
        'commercial_credit.reminder_1_day:' || receivable_id::text
      ),
      (
        lower(trim(customer_email)),
        customer_name,
        'Credito comercial vencido - ' || created_order.order_number,
        'commercial_credit.overdue',
        jsonb_build_object(
          'title', 'Tu credito comercial esta vencido',
          'message', 'La cuenta por cobrar esta vencida. Comunicate con Car Zone Accesorios para realizar el pago completo.',
          'order_number', created_order.order_number,
          'status', 'Vencido',
          'amount', recalculated_total,
          'due_at', (current_date + credit_account.terms_days),
          'action_path', '/cuenta',
          'action_label', 'Ver mi cuenta'
        ),
        'pending',
        (((current_date + credit_account.terms_days + 1)::date + time '08:00') at time zone 'America/Tegucigalpa'),
        'pagos',
        receivable_id,
        1,
        'commercial_credit.overdue:' || receivable_id::text
      );

    update public.email_queue
    set status = 'cancelled',
        updated_at = now()
    where related_id = receivable_id
      and template_key in (
        'commercial_credit.reminder_7_days',
        'commercial_credit.reminder_3_days',
        'commercial_credit.reminder_1_day'
      )
      and scheduled_at <= now();

    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      auth.uid(),
      public.current_actor_role(),
      'accounts_receivable',
      receivable_id,
      'commercial_credit.receivable_created',
      jsonb_build_object(
        'order_id', created_order.order_id,
        'customer_id', credit_account.linked_customer_id,
        'original_amount', recalculated_total,
        'balance_due', recalculated_total,
        'due_date', (current_date + credit_account.terms_days)
      )
    );

    insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
    values (
      auth.uid(),
      public.current_actor_role(),
      'orders',
      created_order.order_id,
      'commercial_credit.order_created',
      jsonb_build_object(
        'receivable_id', receivable_id,
        'credit_limit', credit_account.credit_limit,
        'open_balance_before_order', open_credit_balance,
        'order_total', recalculated_total
      )
    );
  end if;

  insert into public.audit_logs (user_id, table_name, record_id, action, new_data)
  values (
    auth.uid(),
    'inventory_reservations',
    created_order.order_id,
    'inventory.reservation.created',
    jsonb_build_object(
      'payment_method', requested_payment_method,
      'payment_timing', normalized_payment_timing,
      'reservation_expires_at', reservation_deadline,
      'automatic_release', false
    )
  );

  order_id := created_order.order_id;
  order_number := created_order.order_number;
  tracking_code := created_order.tracking_code;
  return next;
end;
$$;

grant execute on function public.create_checkout_order_v2(
  text,
  text,
  text,
  text,
  text,
  public.order_price_mode,
  public.payment_method,
  text,
  jsonb,
  text,
  uuid,
  text,
  text,
  text,
  text,
  text,
  text
) to anon, authenticated, service_role;
