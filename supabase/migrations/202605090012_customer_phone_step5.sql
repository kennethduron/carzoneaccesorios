alter table public.orders
  add column if not exists customer_phone text;

update public.orders
set customer_phone = coalesce(customer_phone, phone)
where customer_phone is null;

alter table public.orders
  alter column customer_phone set not null;

create or replace function public.sync_order_customer_phone()
returns trigger
language plpgsql
as $$
begin
  new.customer_phone := coalesce(nullif(trim(new.customer_phone), ''), new.phone);
  new.phone := coalesce(nullif(trim(new.phone), ''), new.customer_phone);
  return new;
end;
$$;

drop trigger if exists sync_order_customer_phone_trigger on public.orders;

create trigger sync_order_customer_phone_trigger
before insert or update on public.orders
for each row
execute function public.sync_order_customer_phone();

alter table public.crm_followups
  add column if not exists phone text;

update public.crm_followups
set phone = customers.phone
from public.customers
where crm_followups.customer_id = customers.id
  and crm_followups.phone is null;

create index if not exists orders_customer_phone_idx on public.orders(customer_phone);
create index if not exists crm_followups_phone_idx on public.crm_followups(phone);

comment on column public.orders.customer_phone is 'Telefono / WhatsApp del cliente al momento de crear el pedido.';
comment on column public.crm_followups.phone is 'Telefono / WhatsApp del cliente asociado al seguimiento CRM, si aplica.';
