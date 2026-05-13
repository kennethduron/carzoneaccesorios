alter table public.users
  add column if not exists username text;

create unique index if not exists users_username_unique_idx
  on public.users (username)
  where username is not null;

create index if not exists users_username_lookup_idx
  on public.users (username);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  customer_full_name text := nullif(trim(coalesce(new.raw_user_meta_data->>'full_name', '')), '');
  raw_username text := lower(trim(coalesce(new.raw_user_meta_data->>'username', '')));
  customer_username text := null;
  customer_phone text := regexp_replace(coalesce(new.raw_user_meta_data->>'phone', ''), '[^0-9]', '', 'g');
  customer_email text := lower(trim(coalesce(new.email, '')));
  linked_customer_id uuid;
  pending_customer_id uuid;
begin
  if raw_username ~ '^[a-z0-9._-]{3,30}$'
    and raw_username not in ('admin', 'soporte', 'root', 'carzone', 'mayorista', 'facturas', 'pedidos')
  then
    customer_username := raw_username;
  end if;

  if customer_full_name is null then
    customer_full_name := customer_email;
  end if;

  if nullif(customer_phone, '') is null then
    customer_phone := '00000000';
  end if;

  insert into public.users (id, role_id, full_name, username, email, phone, active)
  values (
    new.id,
    (select roles.id from public.roles where roles.name = 'cliente' limit 1),
    customer_full_name,
    customer_username,
    customer_email,
    customer_phone,
    true
  )
  on conflict (id) do update
  set
    full_name = excluded.full_name,
    username = coalesce(public.users.username, excluded.username),
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
    where customers.id = pending_customer_id
    returning customers.id into linked_customer_id;
  else
    select customers.id
    into linked_customer_id
    from public.customers
    where customers.user_id = new.id
    limit 1;

    if linked_customer_id is null then
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
      )
      returning id into linked_customer_id;
    end if;
  end if;

  if linked_customer_id is not null
    and not exists (
      select 1
      from public.crm_followups
      where crm_followups.customer_id = linked_customer_id
        and crm_followups.title = 'Nuevo cliente registrado'
    )
  then
    insert into public.crm_followups (
      customer_id,
      title,
      interaction_type,
      next_action,
      priority,
      phone,
      notes,
      status
    )
    values (
      linked_customer_id,
      'Nuevo cliente registrado',
      'prospecto',
      'Revisar datos de cuenta y confirmar si requiere seguimiento.',
      'media',
      customer_phone,
      'Cuenta creada desde registro publico. Estado inicial: pendiente de confirmacion de correo.',
      'pending'
    );
  end if;

  return new;
end;
$$;

grant execute on function public.handle_new_user() to service_role;
