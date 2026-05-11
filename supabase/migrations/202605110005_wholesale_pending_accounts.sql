alter table public.customers
  drop constraint if exists customers_status_check;

alter table public.customers
  add constraint customers_status_check check (status in ('active', 'inactive', 'disabled', 'pending_account'));

alter table public.customers
  drop constraint if exists customers_wholesale_requires_user_id;

alter table public.customers
  add constraint customers_active_wholesale_requires_user_id
  check (not is_wholesale or status <> 'active' or user_id is not null)
  not valid;
