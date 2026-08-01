-- Keep merge-owned commercial changes to one explicit version increment.

create or replace function public.bump_customer_commercial_version_v1()
returns trigger language plpgsql set search_path = public as $$
begin
  if nullif(current_setting('app.customer_merge_operation',true),'') is not null then return new; end if;
  new.commercial_version := old.commercial_version + 1;
  return new;
end;
$$;

create or replace function public.bump_customer_credit_commercial_version_v1()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if nullif(current_setting('app.customer_merge_operation',true),'') is not null then return coalesce(new,old); end if;
  update public.customers
  set commercial_version=commercial_version+1,updated_at=greatest(updated_at,now())
  where id=coalesce(new.customer_id,old.customer_id);
  return coalesce(new,old);
end;
$$;
