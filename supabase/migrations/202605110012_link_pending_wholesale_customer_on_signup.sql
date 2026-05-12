create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  customer_full_name text := nullif(trim(coalesce(new.raw_user_meta_data->>'full_name', '')), '');
  customer_phone text := regexp_replace(coalesce(new.raw_user_meta_data->>'phone', ''), '[^0-9]', '', 'g');
  customer_email text := lower(trim(coalesce(new.email, '')));
  pending_customer_id uuid;
begin
  if customer_full_name is null then
    customer_full_name := customer_email;
  end if;

  if nullif(customer_phone, '') is null then
    customer_phone := '00000000';
  end if;

  insert into public.users (id, role_id, full_name, email, phone, active)
  values (
    new.id,
    (select roles.id from public.roles where roles.name = 'cliente' limit 1),
    customer_full_name,
    customer_email,
    customer_phone,
    true
  )
  on conflict (id) do update
  set
    full_name = excluded.full_name,
    email = excluded.email,
    phone = excluded.phone,
    updated_at = now();

  select customers.id
  into pending_customer_id
  from public.customers
  where customers.user_id is null
    and lower(coalesce(customers.email, '')) = customer_email
  order by customers.is_wholesale desc, customers.created_at desc
  limit 1;

  if pending_customer_id is not null then
    update public.customers
    set
      user_id = new.id,
      contact_name = customer_full_name,
      email = customer_email,
      phone = customer_phone,
      status = 'active',
      active = true,
      updated_at = now()
    where customers.id = pending_customer_id;

    return new;
  end if;

  if not exists (
    select 1
    from public.customers
    where customers.user_id = new.id
  ) then
    insert into public.customers (
      user_id,
      contact_name,
      email,
      phone,
      is_wholesale,
      status,
      active,
      notes
    )
    values (
      new.id,
      customer_full_name,
      customer_email,
      customer_phone,
      false,
      'active',
      true,
      'Cliente retail registrado desde la tienda publica.'
    );
  end if;

  return new;
end;
$$;
