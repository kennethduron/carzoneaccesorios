alter table public.company_settings
  add column if not exists free_shipping_threshold numeric(12, 2) not null default 3000 check (free_shipping_threshold >= 0),
  add column if not exists standard_shipping_fee numeric(12, 2) not null default 120 check (standard_shipping_fee >= 0),
  add column if not exists cash_on_delivery_percentage numeric(6, 2) not null default 5 check (cash_on_delivery_percentage >= 0),
  add column if not exists enable_cash_on_delivery_fee boolean not null default true,
  add column if not exists first_wholesale_minimum numeric(12, 2) not null default 10000 check (first_wholesale_minimum >= 0),
  add column if not exists facebook_url text,
  add column if not exists instagram_url text,
  add column if not exists whatsapp_url text,
  add column if not exists tiktok_url text,
  add column if not exists youtube_url text,
  add column if not exists website_url text;

alter table public.orders
  add column if not exists shipping_fee numeric(12, 2) not null default 0 check (shipping_fee >= 0),
  add column if not exists cash_on_delivery_fee numeric(12, 2) not null default 0 check (cash_on_delivery_fee >= 0);

update public.orders
set shipping_fee = coalesce(shipping_fee, shipping_total, 0)
where shipping_fee = 0 and coalesce(shipping_total, 0) > 0;

alter table public.invoices
  add column if not exists shipping_fee numeric(12, 2) not null default 0 check (shipping_fee >= 0),
  add column if not exists cash_on_delivery_fee numeric(12, 2) not null default 0 check (cash_on_delivery_fee >= 0);

update public.invoices
set
  shipping_fee = coalesce(orders.shipping_fee, orders.shipping_total, 0),
  cash_on_delivery_fee = coalesce(orders.cash_on_delivery_fee, 0)
from public.orders
where orders.id = invoices.order_id;

create table if not exists public.holiday_banners (
  id uuid primary key default gen_random_uuid(),
  holiday_key text unique,
  title text not null,
  message text not null,
  image_url text,
  start_date date not null,
  end_date date not null,
  is_active boolean not null default false,
  priority integer not null default 0,
  button_text text,
  button_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint holiday_banners_valid_dates check (end_date >= start_date)
);

alter table public.holiday_banners enable row level security;

create index if not exists holiday_banners_active_dates_idx
  on public.holiday_banners(is_active, start_date, end_date, priority desc);

drop policy if exists "Public can read active holiday banners" on public.holiday_banners;
create policy "Public can read active holiday banners"
  on public.holiday_banners for select
  using (is_active = true and current_date between start_date and end_date);

drop policy if exists "Staff can manage holiday banners" on public.holiday_banners;
create policy "Staff can manage holiday banners"
  on public.holiday_banners for all
  using (public.has_permission('settings:manage'))
  with check (public.has_permission('settings:manage'));

grant select on public.holiday_banners to anon, authenticated;
grant select, insert, update, delete on public.holiday_banners to authenticated;
grant select, insert, update, delete on public.holiday_banners to service_role;

insert into public.holiday_banners (holiday_key, title, message, start_date, end_date, is_active, priority, button_text, button_url)
values
  ('dia-madre', 'Feliz Dia de la Madre', 'Feliz Dia de la Madre. Celebramos a quienes nos guian con amor cada dia.', '2026-05-01', '2026-05-31', false, 20, 'Ver catalogo', '/catalogo'),
  ('dia-padre', 'Feliz Dia del Padre', 'Feliz Dia del Padre. Gracias por conducirnos con ejemplo y esfuerzo.', '2026-06-01', '2026-06-30', false, 20, 'Ver catalogo', '/catalogo'),
  ('navidad', 'Feliz Navidad', 'Feliz Navidad. Que esta temporada este llena de paz, alegria y buenos caminos.', '2026-12-01', '2026-12-31', false, 30, 'Ver catalogo', '/catalogo'),
  ('ano-nuevo', 'Feliz Ano Nuevo', 'Que este nuevo ano traiga nuevos caminos, seguridad y buenos viajes.', '2026-12-28', '2027-01-05', false, 30, 'Ver catalogo', '/catalogo'),
  ('independencia', 'Independencia de Honduras', 'Hoy celebramos con orgullo la independencia de Honduras.', '2026-09-10', '2026-09-16', false, 25, 'Ver catalogo', '/catalogo'),
  ('trabajador', 'Dia del Trabajador', 'Celebramos el esfuerzo que mueve a Honduras todos los dias.', '2026-05-01', '2026-05-02', false, 15, 'Ver catalogo', '/catalogo'),
  ('nino', 'Dia del Nino', 'Celebramos la alegria de quienes llenan el camino de esperanza.', '2026-09-09', '2026-09-11', false, 15, 'Ver catalogo', '/catalogo'),
  ('mujer', 'Dia de la Mujer', 'Reconocemos la fuerza, talento y liderazgo de las mujeres.', '2026-01-25', '2026-01-26', false, 15, 'Ver catalogo', '/catalogo'),
  ('suyapa', 'Virgen de Suyapa', 'Acompanamos esta fecha especial para muchas familias hondurenas.', '2026-02-02', '2026-02-04', false, 15, 'Ver catalogo', '/catalogo'),
  ('encuentro-culturas', 'Encuentro de Culturas', 'Recordamos nuestra historia y la diversidad que nos identifica.', '2026-10-12', '2026-10-13', false, 15, 'Ver catalogo', '/catalogo')
on conflict (holiday_key) do nothing;

create or replace view public.public_company_settings as
select
  company_name,
  currency,
  tax_rate,
  logo_url,
  free_shipping_threshold,
  standard_shipping_fee,
  cash_on_delivery_percentage,
  enable_cash_on_delivery_fee,
  first_wholesale_minimum,
  facebook_url,
  instagram_url,
  whatsapp_url,
  tiktok_url,
  youtube_url,
  website_url
from public.company_settings
order by created_at asc
limit 1;

grant select on public.public_company_settings to anon, authenticated;

create or replace function public.has_completed_wholesale_order(target_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.orders
    where orders.customer_id = target_customer_id
      and orders.price_mode = 'wholesale'
      and orders.status::text not in ('cancelado', 'cancelled')
  );
$$;

grant execute on function public.has_completed_wholesale_order(uuid) to authenticated, service_role;

create or replace function public.apply_order_fees_to_invoice()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  order_fee_record record;
begin
  select
    coalesce(orders.shipping_fee, orders.shipping_total, 0) as shipping_fee,
    coalesce(orders.cash_on_delivery_fee, 0) as cash_on_delivery_fee
  into order_fee_record
  from public.orders
  where orders.id = new.order_id;

  if found then
    new.shipping_fee := coalesce(new.shipping_fee, order_fee_record.shipping_fee, 0);
    new.cash_on_delivery_fee := coalesce(new.cash_on_delivery_fee, order_fee_record.cash_on_delivery_fee, 0);
  end if;

  return new;
end;
$$;

drop trigger if exists apply_order_fees_to_invoice_on_insert on public.invoices;
create trigger apply_order_fees_to_invoice_on_insert
before insert on public.invoices
for each row
execute function public.apply_order_fees_to_invoice();

create or replace function public.create_checkout_order(
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
  delivery_city text default null
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
  current_user_id uuid := auth.uid();
  wholesale_allowed_id uuid;
  user_has_authorized_wholesale_account boolean := false;
  normalized_wholesale_code text := upper(trim(coalesce(wholesale_code, '')));
  normalized_country text := coalesce(nullif(trim(delivery_country), ''), 'Honduras');
  normalized_country_code text := coalesce(nullif(upper(trim(country_code)), ''), 'HN');
  legacy_row record;
  created_order record;
  free_shipping_threshold numeric(12, 2) := 3000;
  standard_shipping_fee numeric(12, 2) := 120;
  cash_on_delivery_percentage numeric(6, 2) := 5;
  enable_cash_on_delivery_fee boolean := true;
  first_wholesale_minimum numeric(12, 2) := 10000;
  shipping_amount numeric(12, 2) := 0;
  cod_amount numeric(12, 2) := 0;
  final_total numeric(12, 2) := 0;
  has_previous_wholesale boolean := false;
begin
  if normalized_country_code <> 'HN' or lower(normalized_country) not in ('honduras', 'hn') then
    raise exception 'Actualmente solo realizamos entregas dentro de Honduras.';
  end if;

  if requested_price_mode = 'wholesale' then
    if current_user_id is null then
      raise exception 'Codigo valido. Inicia sesion con tu cuenta mayorista para activar precios.';
    end if;

    if normalized_wholesale_code = '' or wholesale_code_id is null then
      raise exception 'Codigo mayorista invalido.';
    end if;

    if not exists (
      select 1
      from public.wholesale_codes wc
      where wc.code = normalized_wholesale_code
        and wc.id = wholesale_code_id
        and coalesce(wc.is_active, wc.active) = true
        and wc.status = 'active'
        and (wc.starts_at is null or wc.starts_at <= now())
        and (wc.expires_at is null or wc.expires_at >= now())
        and (wc.max_uses is null or wc.used_count < wc.max_uses)
    ) then
      raise exception 'Codigo mayorista invalido.';
    end if;

    select exists (
      select 1
      from public.customers c
      join public.users u on u.id = c.user_id
      where c.user_id = current_user_id
        and c.active = true
        and c.status = 'active'
        and c.is_wholesale = true
        and u.active = true
    )
    into user_has_authorized_wholesale_account;

    if not user_has_authorized_wholesale_account then
      raise exception 'Tu cuenta no esta autorizada para compras mayoristas.';
    end if;

    select wc.id
    into wholesale_allowed_id
    from public.wholesale_codes wc
    join public.customers c on c.id = wc.customer_id
    join public.users u on u.id = c.user_id
    where wc.code = normalized_wholesale_code
      and wc.id = wholesale_code_id
      and coalesce(wc.is_active, wc.active) = true
      and wc.status = 'active'
      and (wc.starts_at is null or wc.starts_at <= now())
      and (wc.expires_at is null or wc.expires_at >= now())
      and (wc.max_uses is null or wc.used_count < wc.max_uses)
      and c.user_id = current_user_id
      and c.active = true
      and c.status = 'active'
      and c.is_wholesale = true
      and u.active = true
    limit 1;

    if wholesale_allowed_id is null then
      raise exception 'Este codigo mayorista no pertenece a tu cuenta.';
    end if;
  end if;

  select *
  into legacy_row
  from public.create_checkout_order_legacy_20260511(
    customer_name,
    customer_email,
    customer_phone,
    customer_rtn,
    delivery_address,
    requested_price_mode,
    requested_payment_method,
    bank_reference_number,
    order_items,
    wholesale_code,
    wholesale_code_id,
    transfer_receipt_url
  )
  limit 1;

  select *
  into created_order
  from public.orders
  where orders.id = legacy_row.order_id
  for update;

  select
    coalesce(company_settings.free_shipping_threshold, 3000),
    coalesce(company_settings.standard_shipping_fee, 120),
    coalesce(company_settings.cash_on_delivery_percentage, 5),
    coalesce(company_settings.enable_cash_on_delivery_fee, true),
    coalesce(company_settings.first_wholesale_minimum, 10000)
  into
    free_shipping_threshold,
    standard_shipping_fee,
    cash_on_delivery_percentage,
    enable_cash_on_delivery_fee,
    first_wholesale_minimum
  from public.company_settings
  order by company_settings.created_at asc
  limit 1;

  if requested_price_mode = 'wholesale' then
    select exists (
      select 1
      from public.orders previous_orders
      where previous_orders.customer_id = created_order.customer_id
        and previous_orders.price_mode = 'wholesale'
        and previous_orders.status::text not in ('cancelado', 'cancelled')
        and previous_orders.id <> created_order.id
    )
    into has_previous_wholesale;

    if not has_previous_wholesale and created_order.subtotal < first_wholesale_minimum then
      raise exception 'Para tu primera compra mayorista, el minimo requerido es de L %.', first_wholesale_minimum;
    end if;
  end if;

  shipping_amount := case
    when created_order.subtotal >= free_shipping_threshold then 0
    else standard_shipping_fee
  end;

  cod_amount := case
    when requested_payment_method = 'cash' and enable_cash_on_delivery_fee
      then round(created_order.subtotal * (cash_on_delivery_percentage / 100), 2)
    else 0
  end;

  final_total := round(created_order.subtotal + shipping_amount + cod_amount, 2);

  update public.orders
  set
    shipping_fee = shipping_amount,
    shipping_total = shipping_amount,
    cash_on_delivery_fee = cod_amount,
    total = final_total,
    delivery_country = normalized_country,
    delivery_country_code = normalized_country_code,
    delivery_department = nullif(trim(coalesce(create_checkout_order.delivery_department, '')), ''),
    delivery_city = nullif(trim(coalesce(create_checkout_order.delivery_city, '')), ''),
    tracking_status = coalesce(nullif(tracking_status, ''), status::text),
    public_tracking_enabled = true,
    updated_at = now()
  where orders.id = legacy_row.order_id
  returning orders.tracking_code into tracking_code;

  update public.payments
  set amount = final_total,
      updated_at = now()
  where payments.order_id = legacy_row.order_id;

  update public.crm_followups
  set estimated_value = final_total,
      notes = notes || chr(10) ||
        'Envio: ' || shipping_amount::text || chr(10) ||
        'Comision pago al recibir: ' || cod_amount::text || chr(10) ||
        'Total final: ' || final_total::text,
      updated_at = now()
  where crm_followups.order_id = legacy_row.order_id;

  order_id := legacy_row.order_id;
  order_number := legacy_row.order_number;
  return next;
end;
$$;

grant execute on function public.create_checkout_order(
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
  text
) to anon, authenticated, service_role;
