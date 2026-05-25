-- One-click wholesale requests for registered customer accounts.

alter table public.customers
  add column if not exists wholesale_requested_at timestamptz,
  add column if not exists wholesale_request_source text not null default 'admin',
  add column if not exists wholesale_approved_at timestamptz,
  add column if not exists wholesale_approved_notice_seen boolean not null default false;

alter table public.customers
  drop constraint if exists customers_wholesale_request_source_check;

alter table public.customers
  add constraint customers_wholesale_request_source_check
  check (wholesale_request_source in ('formulario_publico', 'cuenta_registrada', 'admin'));

update public.customers
set
  wholesale_requested_at = coalesce(wholesale_requested_at, created_at),
  wholesale_request_source = case
    when coalesce(notes, '') like '%[SOLICITUD_MAYOREO]%' then 'formulario_publico'
    else wholesale_request_source
  end
where wholesale_status = 'pending';

update public.customers
set
  wholesale_approved_at = coalesce(wholesale_approved_at, updated_at, created_at),
  wholesale_approved_notice_seen = true
where wholesale_status = 'approved'
  and wholesale_approved_at is null;

create index if not exists customers_wholesale_request_review_idx
  on public.customers(wholesale_status, wholesale_requested_at desc, wholesale_request_source)
  where wholesale_status in ('pending', 'approved', 'rejected', 'suspended');

create index if not exists customers_wholesale_notice_idx
  on public.customers(user_id, wholesale_status, wholesale_approved_notice_seen)
  where wholesale_status = 'approved';

comment on column public.customers.wholesale_requested_at is 'Fecha en que el cliente solicito acceso mayorista.';
comment on column public.customers.wholesale_request_source is 'Origen operativo de la solicitud: formulario_publico, cuenta_registrada o admin.';
comment on column public.customers.wholesale_approved_at is 'Fecha en que el admin aprobo o reactivo acceso mayorista.';
comment on column public.customers.wholesale_approved_notice_seen is 'Indica si el cliente ya vio el aviso visual de aprobacion mayorista.';
