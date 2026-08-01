begin transaction read only;

set local statement_timeout = '60s';

select
  count(*)::integer as total_products,
  count(*) filter (where wholesale_min_quantity = 1)::integer as minimum_1,
  count(*) filter (where wholesale_min_quantity = 3)::integer as minimum_3,
  count(*) filter (where wholesale_min_quantity not in (1, 3))::integer as other_minimums,
  count(*) filter (where wholesale_min_quantity is null)::integer as null_minimums,
  count(*) filter (where wholesale_min_quantity = 0)::integer as zero_minimums
from public.products;

select action, count(*)::integer as events
from public.audit_logs
where coalesce(new_data ->> 'request_key', old_data ->> 'request_key')
  = 'wholesale-minimum-all-products-to-one-20260731-v1'
group by action
order by action;

select
  count(*)::integer as product_events,
  count(*) filter (
    where (old_data ->> 'wholesale_min_quantity')::integer = 3
      and (new_data ->> 'wholesale_min_quantity')::integer = 1
  )::integer as valid_minimum_changes,
  count(*) filter (
    where (new_data ->> 'product_sales_version')::bigint
      = (old_data ->> 'product_sales_version')::bigint + 1
  )::integer as exact_version_increments
from public.audit_logs
where action = 'product.wholesale_minimum_to_one.changed'
  and new_data ->> 'request_key' = 'wholesale-minimum-all-products-to-one-20260731-v1';

select
  new_data ->> 'snapshot_sha256' as snapshot_sha256,
  new_data ->> 'protected_product_sha256_before' as protected_product_sha256_before,
  new_data ->> 'protected_product_sha256_after' as protected_product_sha256_after,
  new_data -> 'protected_tables_before' as protected_tables_before,
  new_data -> 'protected_tables_after' as protected_tables_after,
  new_data ->> 'executed_by' as executed_by,
  new_data ->> 'executed_role' as executed_role,
  created_at as completed_at
from public.audit_logs
where action = 'products.wholesale_minimum_to_one.completed'
  and new_data ->> 'request_key' = 'wholesale-minimum-all-products-to-one-20260731-v1';

do $$
declare
  completed_count integer;
  expected_count integer;
  product_event_count integer;
begin
  if exists (select 1 from public.products where wholesale_min_quantity <> 1) then
    raise exception 'VERIFY_ABORT: existe un producto con minimo diferente de 1.';
  end if;

  select count(*), max((new_data ->> 'updated_count')::integer)
  into completed_count, expected_count
  from public.audit_logs
  where action = 'products.wholesale_minimum_to_one.completed'
    and new_data ->> 'request_key' = 'wholesale-minimum-all-products-to-one-20260731-v1'
    and new_data ->> 'status' = 'completed';

  if completed_count <> 1 or expected_count <> 150 then
    raise exception 'VERIFY_ABORT: batch completed invalido.';
  end if;

  select count(*) into product_event_count
  from public.audit_logs
  where action = 'product.wholesale_minimum_to_one.changed'
    and new_data ->> 'request_key' = 'wholesale-minimum-all-products-to-one-20260731-v1'
    and (old_data ->> 'wholesale_min_quantity')::integer = 3
    and (new_data ->> 'wholesale_min_quantity')::integer = 1
    and (new_data ->> 'product_sales_version')::bigint
      = (old_data ->> 'product_sales_version')::bigint + 1;

  if product_event_count <> expected_count then
    raise exception 'VERIFY_ABORT: auditoria por producto incompleta.';
  end if;

  if exists (
    select 1
    from public.audit_logs
    where action = 'products.wholesale_minimum_to_one.completed'
      and new_data ->> 'request_key' = 'wholesale-minimum-all-products-to-one-20260731-v1'
      and (
        new_data ->> 'protected_product_sha256_before'
          is distinct from new_data ->> 'protected_product_sha256_after'
        or new_data -> 'protected_tables_before'
          is distinct from new_data -> 'protected_tables_after'
      )
  ) then
    raise exception 'VERIFY_ABORT: un hash protegido cambio durante la operacion.';
  end if;
end;
$$;

select 'VERIFY_APPROVED' as result;

rollback;
