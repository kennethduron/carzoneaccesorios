create table if not exists public.purchase_returns (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid not null references public.purchases(id) on delete restrict,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  accounts_payable_id uuid references public.accounts_payable(id) on delete set null,
  return_number text not null,
  return_date date not null default current_date,
  status text not null default 'confirmed',
  subtotal numeric(12, 2) not null default 0,
  tax_amount numeric(12, 2) not null default 0,
  total numeric(12, 2) not null default 0,
  reason text,
  created_by uuid references public.users(id) on delete set null,
  confirmed_by uuid references public.users(id) on delete set null,
  confirmed_at timestamptz,
  cancelled_by uuid references public.users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint purchase_returns_number_not_empty check (char_length(trim(return_number)) > 0),
  constraint purchase_returns_status_check check (status in ('draft', 'confirmed', 'cancelled')),
  constraint purchase_returns_amounts_non_negative check (subtotal >= 0 and tax_amount >= 0 and total >= 0)
);

create table if not exists public.purchase_return_items (
  id uuid primary key default gen_random_uuid(),
  purchase_return_id uuid not null references public.purchase_returns(id) on delete cascade,
  purchase_item_id uuid references public.purchase_items(id) on delete restrict,
  product_id uuid references public.products(id) on delete set null,
  quantity numeric(12, 2) not null,
  unit_cost numeric(12, 2) not null,
  total_cost numeric(12, 2) not null,
  inventory_movement_id uuid references public.inventory_movements(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint purchase_return_items_quantity_positive check (quantity > 0),
  constraint purchase_return_items_amounts_non_negative check (unit_cost >= 0 and total_cost >= 0)
);

create table if not exists public.supplier_credits (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  purchase_id uuid references public.purchases(id) on delete set null,
  supplier_invoice_id uuid references public.supplier_invoices(id) on delete set null,
  accounts_payable_id uuid references public.accounts_payable(id) on delete set null,
  credit_number text not null,
  credit_date date not null default current_date,
  amount numeric(12, 2) not null,
  remaining_amount numeric(12, 2) not null,
  status text not null default 'open',
  reason text,
  created_by uuid references public.users(id) on delete set null,
  applied_by uuid references public.users(id) on delete set null,
  applied_at timestamptz,
  cancelled_by uuid references public.users(id) on delete set null,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint supplier_credits_number_not_empty check (char_length(trim(credit_number)) > 0),
  constraint supplier_credits_status_check check (status in ('open', 'applied', 'cancelled')),
  constraint supplier_credits_amounts_non_negative check (amount > 0 and remaining_amount >= 0 and remaining_amount <= amount)
);

create unique index if not exists purchase_returns_purchase_return_number_key
  on public.purchase_returns (purchase_id, (lower(trim(return_number))))
  where status <> 'cancelled';
create index if not exists purchase_returns_purchase_id_idx
  on public.purchase_returns (purchase_id);
create index if not exists purchase_returns_supplier_id_idx
  on public.purchase_returns (supplier_id);
create index if not exists purchase_returns_accounts_payable_id_idx
  on public.purchase_returns (accounts_payable_id);
create index if not exists purchase_returns_status_idx
  on public.purchase_returns (status);
create index if not exists purchase_returns_return_date_idx
  on public.purchase_returns (return_date desc);

create index if not exists purchase_return_items_purchase_return_id_idx
  on public.purchase_return_items (purchase_return_id);
create index if not exists purchase_return_items_purchase_item_id_idx
  on public.purchase_return_items (purchase_item_id);
create index if not exists purchase_return_items_product_id_idx
  on public.purchase_return_items (product_id);

create unique index if not exists supplier_credits_supplier_credit_number_key
  on public.supplier_credits (supplier_id, (lower(trim(credit_number))))
  where status <> 'cancelled';
create index if not exists supplier_credits_supplier_id_idx
  on public.supplier_credits (supplier_id);
create index if not exists supplier_credits_purchase_id_idx
  on public.supplier_credits (purchase_id);
create index if not exists supplier_credits_supplier_invoice_id_idx
  on public.supplier_credits (supplier_invoice_id);
create index if not exists supplier_credits_accounts_payable_id_idx
  on public.supplier_credits (accounts_payable_id);
create index if not exists supplier_credits_status_idx
  on public.supplier_credits (status);
create index if not exists supplier_credits_credit_date_idx
  on public.supplier_credits (credit_date desc);

drop trigger if exists purchase_returns_set_updated_at on public.purchase_returns;
create trigger purchase_returns_set_updated_at
before update on public.purchase_returns
for each row execute function public.set_updated_at();

drop trigger if exists supplier_credits_set_updated_at on public.supplier_credits;
create trigger supplier_credits_set_updated_at
before update on public.supplier_credits
for each row execute function public.set_updated_at();

alter table public.purchase_returns enable row level security;
alter table public.purchase_return_items enable row level security;
alter table public.supplier_credits enable row level security;

create policy purchase_returns_select
  on public.purchase_returns for select
  using (public.has_permission('purchases:read') or public.has_permission('purchases:manage'));
create policy purchase_returns_insert
  on public.purchase_returns for insert
  with check (public.has_permission('purchases:manage'));
create policy purchase_returns_update
  on public.purchase_returns for update
  using (public.has_permission('purchases:manage'))
  with check (public.has_permission('purchases:manage'));

create policy purchase_return_items_select
  on public.purchase_return_items for select
  using (public.has_permission('purchases:read') or public.has_permission('purchases:manage'));
create policy purchase_return_items_insert
  on public.purchase_return_items for insert
  with check (public.has_permission('purchases:manage'));
create policy purchase_return_items_update
  on public.purchase_return_items for update
  using (public.has_permission('purchases:manage'))
  with check (public.has_permission('purchases:manage'));

create policy supplier_credits_select
  on public.supplier_credits for select
  using (public.has_permission('payables:read') or public.has_permission('payables:manage'));
create policy supplier_credits_insert
  on public.supplier_credits for insert
  with check (public.has_permission('payables:manage'));
create policy supplier_credits_update
  on public.supplier_credits for update
  using (public.has_permission('payables:manage'))
  with check (public.has_permission('payables:manage'));

grant select, insert, update on public.purchase_returns to authenticated, service_role;
grant select, insert, update on public.purchase_return_items to authenticated, service_role;
grant select, insert, update on public.supplier_credits to authenticated, service_role;

create or replace function public.register_purchase_return(
  target_purchase_id uuid,
  purchase_return_number text,
  purchase_return_date date default current_date,
  return_amount numeric default 0,
  return_reason text default null
)
returns table (
  purchase_return_id uuid,
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
  purchase_row public.purchases%rowtype;
  payable_row public.accounts_payable%rowtype;
  saved_return public.purchase_returns%rowtype;
  next_total numeric(12, 2);
  next_status text;
begin
  if auth.uid() is null or not public.has_permission('purchases:manage') then
    raise exception 'No tienes permiso para registrar devoluciones a proveedor.';
  end if;

  if purchase_return_number is null or char_length(trim(purchase_return_number)) = 0 then
    raise exception 'El numero de devolucion es obligatorio.';
  end if;

  if return_amount is null or return_amount <= 0 then
    raise exception 'El monto de la devolucion debe ser mayor que cero.';
  end if;

  select *
    into purchase_row
    from public.purchases
    where id = target_purchase_id
    for update;

  if not found then
    raise exception 'La compra no existe.';
  end if;

  if purchase_row.status not in ('confirmed', 'received', 'returned') then
    raise exception 'Solo se pueden registrar devoluciones de compras confirmadas o recibidas.';
  end if;

  if return_amount > purchase_row.total then
    raise exception 'La devolucion no puede exceder el total de la compra.';
  end if;

  select *
    into payable_row
    from public.accounts_payable
    where purchase_id = target_purchase_id
      and status <> 'cancelled'
    order by created_at asc
    limit 1
    for update;

  if found then
    if return_amount > payable_row.balance then
      raise exception 'La devolucion no puede exceder el saldo pendiente de la cuenta por pagar.';
    end if;

    next_total := round((payable_row.total_amount - return_amount)::numeric, 2);
    if next_total < payable_row.paid_amount then
      raise exception 'La devolucion dejaria la cuenta por pagar por debajo de los pagos registrados.';
    end if;

    next_status := case
      when next_total <= payable_row.paid_amount then 'paid'
      when payable_row.paid_amount > 0 then 'partial'
      else 'pending'
    end;

    update public.accounts_payable
    set total_amount = next_total,
        status = next_status,
        updated_at = now()
    where id = payable_row.id
    returning * into payable_row;
  end if;

  insert into public.purchase_returns (
    purchase_id,
    supplier_id,
    accounts_payable_id,
    return_number,
    return_date,
    status,
    subtotal,
    tax_amount,
    total,
    reason,
    created_by,
    confirmed_by,
    confirmed_at
  )
  values (
    purchase_row.id,
    purchase_row.supplier_id,
    case when found then payable_row.id else null end,
    trim(purchase_return_number),
    coalesce(purchase_return_date, current_date),
    'confirmed',
    round(return_amount::numeric, 2),
    0,
    round(return_amount::numeric, 2),
    nullif(trim(coalesce(return_reason, '')), ''),
    auth.uid(),
    auth.uid(),
    now()
  )
  returning * into saved_return;

  update public.purchases
  set status = 'returned',
      updated_at = now()
  where id = purchase_row.id
    and status <> 'cancelled';

  purchase_return_id := saved_return.id;
  accounts_payable_id := saved_return.accounts_payable_id;
  accounts_payable_status := case when saved_return.accounts_payable_id is null then null else payable_row.status end;
  paid_amount := case when saved_return.accounts_payable_id is null then null else payable_row.paid_amount end;
  balance := case when saved_return.accounts_payable_id is null then null else payable_row.balance end;
  return next;
end;
$$;

create or replace function public.register_supplier_credit(
  target_supplier_id uuid,
  supplier_credit_number text,
  supplier_credit_date date default current_date,
  credit_amount numeric default 0,
  target_purchase_id uuid default null,
  target_supplier_invoice_id uuid default null,
  target_accounts_payable_id uuid default null,
  credit_reason text default null
)
returns table (
  supplier_credit_id uuid,
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
  supplier_row public.suppliers%rowtype;
  payable_row public.accounts_payable%rowtype;
  saved_credit public.supplier_credits%rowtype;
  next_total numeric(12, 2);
  next_status text;
  credit_status text := 'open';
  remaining numeric(12, 2);
begin
  if auth.uid() is null or not public.has_permission('payables:manage') then
    raise exception 'No tienes permiso para registrar notas de credito de proveedor.';
  end if;

  if supplier_credit_number is null or char_length(trim(supplier_credit_number)) = 0 then
    raise exception 'El numero de nota de credito es obligatorio.';
  end if;

  if credit_amount is null or credit_amount <= 0 then
    raise exception 'El monto de la nota de credito debe ser mayor que cero.';
  end if;

  select *
    into supplier_row
    from public.suppliers
    where id = target_supplier_id;

  if not found then
    raise exception 'El proveedor no existe.';
  end if;

  remaining := round(credit_amount::numeric, 2);

  if target_accounts_payable_id is not null then
    select *
      into payable_row
      from public.accounts_payable
      where id = target_accounts_payable_id
      for update;

    if not found then
      raise exception 'La cuenta por pagar no existe.';
    end if;

    if payable_row.status = 'cancelled' then
      raise exception 'No se puede aplicar credito a una cuenta por pagar cancelada.';
    end if;

    if payable_row.supplier_id <> target_supplier_id then
      raise exception 'La cuenta por pagar no pertenece al proveedor seleccionado.';
    end if;

    if credit_amount > payable_row.balance then
      raise exception 'La nota de credito no puede exceder el saldo pendiente.';
    end if;

    next_total := round((payable_row.total_amount - credit_amount)::numeric, 2);
    if next_total < payable_row.paid_amount then
      raise exception 'La nota de credito dejaria la cuenta por pagar por debajo de los pagos registrados.';
    end if;

    next_status := case
      when next_total <= payable_row.paid_amount then 'paid'
      when payable_row.paid_amount > 0 then 'partial'
      else 'pending'
    end;

    update public.accounts_payable
    set total_amount = next_total,
        status = next_status,
        updated_at = now()
    where id = payable_row.id
    returning * into payable_row;

    credit_status := 'applied';
    remaining := 0;
  end if;

  insert into public.supplier_credits (
    supplier_id,
    purchase_id,
    supplier_invoice_id,
    accounts_payable_id,
    credit_number,
    credit_date,
    amount,
    remaining_amount,
    status,
    reason,
    created_by,
    applied_by,
    applied_at
  )
  values (
    target_supplier_id,
    target_purchase_id,
    target_supplier_invoice_id,
    target_accounts_payable_id,
    trim(supplier_credit_number),
    coalesce(supplier_credit_date, current_date),
    round(credit_amount::numeric, 2),
    remaining,
    credit_status,
    nullif(trim(coalesce(credit_reason, '')), ''),
    auth.uid(),
    case when credit_status = 'applied' then auth.uid() else null end,
    case when credit_status = 'applied' then now() else null end
  )
  returning * into saved_credit;

  supplier_credit_id := saved_credit.id;
  accounts_payable_id := saved_credit.accounts_payable_id;
  accounts_payable_status := case when saved_credit.accounts_payable_id is null then null else payable_row.status end;
  paid_amount := case when saved_credit.accounts_payable_id is null then null else payable_row.paid_amount end;
  balance := case when saved_credit.accounts_payable_id is null then null else payable_row.balance end;
  return next;
end;
$$;

revoke all on function public.register_purchase_return(uuid, text, date, numeric, text) from public, anon;
revoke all on function public.register_supplier_credit(uuid, text, date, numeric, uuid, uuid, uuid, text) from public, anon;
grant execute on function public.register_purchase_return(uuid, text, date, numeric, text) to authenticated, service_role;
grant execute on function public.register_supplier_credit(uuid, text, date, numeric, uuid, uuid, uuid, text) to authenticated, service_role;
