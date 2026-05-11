do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'customers_wholesale_requires_user_id'
      and conrelid = 'public.customers'::regclass
  ) then
    alter table public.customers
      add constraint customers_wholesale_requires_user_id
      check (not is_wholesale or user_id is not null)
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'customers_wholesale_requires_email'
      and conrelid = 'public.customers'::regclass
  ) then
    alter table public.customers
      add constraint customers_wholesale_requires_email
      check (not is_wholesale or nullif(trim(coalesce(email, '')), '') is not null)
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'customers_wholesale_requires_company_name'
      and conrelid = 'public.customers'::regclass
  ) then
    alter table public.customers
      add constraint customers_wholesale_requires_company_name
      check (not is_wholesale or nullif(trim(coalesce(company_name, business_name, '')), '') is not null)
      not valid;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'wholesale_codes_requires_customer_id'
      and conrelid = 'public.wholesale_codes'::regclass
  ) then
    alter table public.wholesale_codes
      add constraint wholesale_codes_requires_customer_id
      check (customer_id is not null)
      not valid;
  end if;
end;
$$;
