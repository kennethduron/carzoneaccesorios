begin transaction read only;

set local statement_timeout = '60s';

select
  count(*)::integer as total_products,
  count(*) filter (where wholesale_min_quantity = 1)::integer as minimum_1,
  count(*) filter (where wholesale_min_quantity = 3)::integer as minimum_3,
  count(*) filter (where wholesale_min_quantity not in (1, 3))::integer as other_minimums,
  count(*) filter (where wholesale_min_quantity is null)::integer as null_minimums,
  count(*) filter (where wholesale_min_quantity <> 1)::integer as target_products,
  count(*) filter (where wholesale_min_quantity <> 1 and active)::integer as active_targets,
  count(*) filter (where wholesale_min_quantity <> 1 and not active)::integer as inactive_targets,
  count(*) filter (
    where wholesale_min_quantity <> 1
      and wholesale_price > 0
      and wholesale_price < retail_price
  )::integer as targets_with_valid_wholesale_price,
  count(*) filter (
    where wholesale_min_quantity <> 1
      and not (wholesale_price > 0 and wholesale_price < retail_price)
  )::integer as targets_with_invalid_wholesale_price
from public.products;

select status, count(*)::integer as requests
from public.checkout_requests_v4
group by status
order by status;

select action, count(*)::integer as events
from public.audit_logs
where coalesce(new_data ->> 'request_key', old_data ->> 'request_key')
  = 'wholesale-minimum-all-products-to-one-20260731-v1'
group by action
order by action;

do $$
declare
  technical_actor_count integer;
  active_checkout_count integer;
  active_import_count integer;
begin
  if (select count(*) from public.products) < 1 then
    raise exception 'PREVIEW_ABORT: no hay productos.';
  end if;

  if (select count(*) from public.products where wholesale_min_quantity <> 1) <> 150 then
    raise exception 'PREVIEW_ABORT: la cantidad objetivo ya no es 150.';
  end if;

  if exists (
    select 1 from public.products
    where wholesale_min_quantity is null
       or wholesale_min_quantity <= 0
       or wholesale_min_quantity not in (1, 3)
  ) then
    raise exception 'PREVIEW_ABORT: existe un minimo nulo, no positivo o diferente de 1/3.';
  end if;

  if exists (
    select 1 from public.products
    where retail_price is null or retail_price <= 0
       or wholesale_price is null or wholesale_price <= 0
       or wholesale_price >= retail_price
  ) then
    raise exception 'PREVIEW_ABORT: existe un producto con precio retail/wholesale inconsistente.';
  end if;

  if exists (
    select id from public.products group by id having count(*) <> 1
  ) then
    raise exception 'PREVIEW_ABORT: existen IDs de producto duplicados.';
  end if;

  select count(*) into technical_actor_count
  from public.users u
  join public.roles r on r.id = u.role_id
  where u.active and r.name = 'technical_owner';

  if technical_actor_count <> 1 then
    raise exception 'PREVIEW_ABORT: se esperaban 1 actor technical_owner activo; encontrados %.', technical_actor_count;
  end if;

  select count(*) into active_checkout_count
  from public.checkout_requests_v4
  where status not in ('committed', 'failed_final', 'conflict', 'expired');

  if active_checkout_count <> 0 then
    raise exception 'PREVIEW_ABORT: existen % Checkout V4 no terminales.', active_checkout_count;
  end if;

  select count(*) into active_import_count
  from pg_catalog.pg_stat_activity
  where pid <> pg_backend_pid()
    and state in ('active', 'idle in transaction')
    and (
      query ilike '%import_product_row_atomic%'
      or query ilike '%import_product_row_v2_atomic%'
      or query ilike '%products.bulk_import%'
    );

  if active_import_count <> 0 then
    raise exception 'PREVIEW_ABORT: existe una importacion de productos activa.';
  end if;

  if exists (
    select 1
    from public.audit_logs
    where coalesce(new_data ->> 'request_key', old_data ->> 'request_key')
      = 'wholesale-minimum-all-products-to-one-20260731-v1'
  ) then
    raise exception 'PREVIEW_ABORT: la request key ya tiene evidencia; revisar idempotencia antes de continuar.';
  end if;
end;
$$;

select 'PREVIEW_APPROVED' as result;

rollback;
