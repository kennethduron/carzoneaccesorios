create or replace function public.validate_wholesale_code(raw_code text)
returns table (
  id uuid,
  code text,
  customer_id uuid,
  customer_name text,
  business_name text,
  label text,
  minimum_order numeric,
  expires_at timestamptz,
  used_count integer,
  status public.wholesale_code_status
)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_code text := upper(trim(raw_code));
  matched_code public.wholesale_codes%rowtype;
  matched_customer public.customers%rowtype;
begin
  if normalized_code = '' then
    return;
  end if;

  select *
  into matched_code
  from public.wholesale_codes wc
  where wc.code = normalized_code
  limit 1;

  if matched_code.id is null then
    return;
  end if;

  if not matched_code.active
    or matched_code.status <> 'active'
    or (matched_code.starts_at is not null and matched_code.starts_at > now())
    or (matched_code.expires_at is not null and matched_code.expires_at < now())
    or (matched_code.max_uses is not null and matched_code.used_count >= matched_code.max_uses)
  then
    return;
  end if;

  if matched_code.customer_id is null then
    return;
  end if;

  select *
  into matched_customer
  from public.customers c
  where c.id = matched_code.customer_id
    and c.active = true
    and c.is_wholesale = true;

  if matched_customer.id is null then
    return;
  end if;

  id := matched_code.id;
  code := matched_code.code;
  customer_id := matched_code.customer_id;
  customer_name := coalesce(matched_customer.contact_name, matched_code.label);
  business_name := coalesce(matched_customer.business_name, matched_code.label);
  label := matched_code.label;
  minimum_order := matched_code.minimum_order;
  expires_at := matched_code.expires_at;
  used_count := matched_code.used_count;
  status := matched_code.status;

  return next;
end;
$$;

grant execute on function public.validate_wholesale_code(text) to anon, authenticated;

drop function if exists public.create_checkout_order(
  text,
  text,
  text,
  text,
  public.order_price_mode,
  public.payment_method,
  text,
  jsonb,
  text
);

drop function if exists public.create_checkout_order(
  text,
  text,
  text,
  text,
  public.order_price_mode,
  public.payment_method,
  text,
  jsonb,
  text,
  uuid
);

drop function if exists public.create_checkout_order(
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
  text
);

create or replace function public.create_checkout_order(
  customer_name text,
  customer_email text,
  customer_phone text,
  delivery_address text,
  requested_price_mode public.order_price_mode,
  requested_payment_method public.payment_method,
  bank_reference_number text,
  order_items jsonb,
  wholesale_code text default null,
  wholesale_code_id uuid default null,
  transfer_receipt_url text default null
)
returns table (
  order_id uuid,
  order_number text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  linked_customer_id uuid;
  linked_wholesale_code_id uuid;
  wholesale_minimum_order numeric(12, 2) := 0;
  normalized_customer_name text := trim(coalesce(customer_name, ''));
  normalized_customer_email text := nullif(trim(coalesce(customer_email, '')), '');
  normalized_customer_phone text := trim(coalesce(customer_phone, ''));
  normalized_delivery_address text := trim(coalesce(delivery_address, ''));
  normalized_bank_reference text := nullif(trim(coalesce(bank_reference_number, '')), '');
  normalized_transfer_receipt_url text := nullif(trim(coalesce(transfer_receipt_url, '')), '');
  tax_rate numeric(5, 4) := 0.1500;
  subtotal_amount numeric(12, 2) := 0;
  tax_amount numeric(12, 2) := 0;
  total_amount numeric(12, 2) := 0;
  new_order_id uuid := gen_random_uuid();
  new_order_number text;
  expected_item_count integer := 0;
  locked_item_count integer := 0;
  stock_update_count integer := 0;
  item_record record;
  wholesale_record record;
begin
  if normalized_customer_name = '' then
    raise exception 'El nombre del cliente es obligatorio.';
  end if;

  if normalized_customer_phone = '' then
    raise exception 'El telefono del cliente es obligatorio.';
  end if;

  if normalized_delivery_address = '' then
    raise exception 'La direccion de entrega es obligatoria.';
  end if;

  if requested_payment_method = 'bank_transfer' and normalized_bank_reference is null then
    raise exception 'Debes ingresar el numero de referencia de la transferencia.';
  end if;

  if order_items is null or jsonb_typeof(order_items) <> 'array' or jsonb_array_length(order_items) = 0 then
    raise exception 'Agrega productos validos para crear el pedido.';
  end if;

  create temporary table if not exists checkout_items_temp (
    product_id uuid primary key,
    quantity integer not null check (quantity > 0)
  ) on commit drop;

  truncate table checkout_items_temp;

  insert into checkout_items_temp (product_id, quantity)
  select
    raw_items.product_id::uuid,
    sum(raw_items.quantity)::integer
  from jsonb_to_recordset(order_items) as raw_items(product_id text, quantity numeric)
  where raw_items.product_id is not null
    and raw_items.quantity is not null
    and raw_items.quantity > 0
  group by raw_items.product_id::uuid;

  select count(*) into expected_item_count from checkout_items_temp;

  if expected_item_count = 0 then
    raise exception 'Agrega productos validos para crear el pedido.';
  end if;

  if requested_price_mode = 'wholesale' then
    if nullif(trim(coalesce(wholesale_code, '')), '') is null or wholesale_code_id is null then
      raise exception 'Debes validar un codigo mayorista antes de comprar con precio mayorista.';
    end if;

    select
      wc.id,
      wc.customer_id,
      wc.minimum_order
    into wholesale_record
    from public.wholesale_codes wc
    join public.customers c on c.id = wc.customer_id
    where wc.code = upper(trim(wholesale_code))
      and wc.id = wholesale_code_id
      and wc.active = true
      and wc.status = 'active'
      and (wc.starts_at is null or wc.starts_at <= now())
      and (wc.expires_at is null or wc.expires_at >= now())
      and (wc.max_uses is null or wc.used_count < wc.max_uses)
      and c.active = true
      and c.is_wholesale = true
    limit 1
    for update of wc;

    if not found then
      raise exception 'Codigo mayorista invalido, inactivo, vencido, sin usos disponibles o sin cliente mayorista valido.';
    end if;

    linked_wholesale_code_id := wholesale_record.id;
    linked_customer_id := wholesale_record.customer_id;
    wholesale_minimum_order := coalesce(wholesale_record.minimum_order, 0);
  end if;

  if current_user_id is not null and linked_customer_id is null then
    select customers.id
    into linked_customer_id
    from public.customers
    where customers.user_id = current_user_id
    order by customers.created_at desc
    limit 1;
  end if;

  if linked_customer_id is null then
    select customers.id
    into linked_customer_id
    from public.customers
    where (normalized_customer_email is not null and lower(customers.email) = lower(normalized_customer_email))
       or customers.phone = normalized_customer_phone
    order by customers.created_at desc
    limit 1;
  end if;

  select coalesce(company_settings.tax_rate, 0.1500)
  into tax_rate
  from public.company_settings
  order by company_settings.created_at asc
  limit 1;

  tax_rate := coalesce(tax_rate, 0.1500);

  select count(*)
  into locked_item_count
  from checkout_items_temp checkout_items
  join public.products on products.id = checkout_items.product_id
  where products.active = true
    and products.status = 'active';

  if locked_item_count <> expected_item_count then
    raise exception 'Uno de los productos ya no esta disponible.';
  end if;

  for item_record in
    select
      products.id,
      products.sku,
      products.name,
      products.stock,
      products.retail_price,
      products.wholesale_price,
      checkout_items.quantity
    from checkout_items_temp checkout_items
    join public.products on products.id = checkout_items.product_id
    where products.active = true
      and products.status = 'active'
    order by products.id
    for update of products
  loop
    if item_record.quantity > item_record.stock then
      raise exception 'El producto ya no tiene stock suficiente disponible.';
    end if;

    subtotal_amount := subtotal_amount + round(
      (
        case
          when requested_price_mode = 'wholesale' then item_record.wholesale_price
          else item_record.retail_price
        end
      ) * item_record.quantity,
      2
    );
  end loop;

  if requested_price_mode = 'wholesale' and subtotal_amount < wholesale_minimum_order then
    raise exception 'El codigo mayorista requiere un pedido minimo de %.', wholesale_minimum_order;
  end if;

  if linked_wholesale_code_id is not null then
    update public.wholesale_codes
    set
      used_count = used_count + 1,
      last_used_at = now(),
      updated_at = now()
    where wholesale_codes.id = linked_wholesale_code_id;
  end if;

  tax_amount := round(subtotal_amount * tax_rate, 2);
  total_amount := round(subtotal_amount + tax_amount, 2);
  new_order_number := 'CZ-' || to_char(clock_timestamp(), 'YYMMDDHH24MISS') || '-' || upper(substr(encode(gen_random_bytes(3), 'hex'), 1, 6));

  insert into public.orders (
    id,
    order_number,
    user_id,
    customer_id,
    wholesale_code_id,
    customer_name,
    email,
    phone,
    customer_phone,
    delivery_address,
    payment_method,
    price_mode,
    subtotal,
    tax,
    shipping_total,
    total,
    status
  )
  values (
    new_order_id,
    new_order_number,
    current_user_id,
    linked_customer_id,
    linked_wholesale_code_id,
    normalized_customer_name,
    normalized_customer_email,
    normalized_customer_phone,
    normalized_customer_phone,
    normalized_delivery_address,
    requested_payment_method,
    requested_price_mode,
    subtotal_amount,
    tax_amount,
    0,
    total_amount,
    'pending'
  );

  for item_record in
    select
      products.id,
      products.sku,
      products.name,
      products.stock,
      products.retail_price,
      products.wholesale_price,
      checkout_items.quantity
    from checkout_items_temp checkout_items
    join public.products on products.id = checkout_items.product_id
    order by products.id
  loop
    insert into public.order_items (
      order_id,
      product_id,
      sku,
      product_name,
      quantity,
      applied_price_mode,
      unit_price,
      line_total,
      retail_price_snapshot,
      wholesale_price_snapshot
    )
    values (
      new_order_id,
      item_record.id,
      item_record.sku,
      item_record.name,
      item_record.quantity,
      requested_price_mode,
      round(
        case
          when requested_price_mode = 'wholesale' then item_record.wholesale_price
          else item_record.retail_price
        end,
        2
      ),
      round(
        (
          case
            when requested_price_mode = 'wholesale' then item_record.wholesale_price
            else item_record.retail_price
          end
        ) * item_record.quantity,
        2
      ),
      round(item_record.retail_price, 2),
      round(item_record.wholesale_price, 2)
    );

    update public.products
    set
      stock = item_record.stock - item_record.quantity,
      updated_at = now()
    where products.id = item_record.id
      and products.stock >= item_record.quantity;

    get diagnostics stock_update_count = row_count;

    if stock_update_count <> 1 then
      raise exception 'El producto ya no tiene stock suficiente disponible.';
    end if;

    insert into public.inventory_movements (
      product_id,
      user_id,
      movement_type,
      quantity,
      stock_before,
      stock_after,
      reference_type,
      reference_id,
      notes
    )
    values (
      item_record.id,
      current_user_id,
      'sale',
      -item_record.quantity,
      item_record.stock,
      item_record.stock - item_record.quantity,
      'orders',
      new_order_id,
      'Salida automatica por checkout'
    );
  end loop;

  insert into public.payments (
    order_id,
    customer_id,
    method,
    payment_method,
    status,
    payment_status,
    amount,
    reference,
    bank_reference_number,
    transfer_receipt_url,
    provider
  )
  values (
    new_order_id,
    linked_customer_id,
    requested_payment_method,
    requested_payment_method,
    'pending',
    'pending',
    total_amount,
    case when requested_payment_method = 'bank_transfer' then normalized_bank_reference else null end,
    case when requested_payment_method = 'bank_transfer' then normalized_bank_reference else null end,
    case when requested_payment_method = 'bank_transfer' then normalized_transfer_receipt_url else null end,
    case when requested_payment_method = 'card' then 'pending_gateway' else null end
  );

  order_id := new_order_id;
  order_number := new_order_number;
  return next;
end;
$$;

grant execute on function public.create_checkout_order(
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
  text
) to anon, authenticated;
