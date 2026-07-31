begin;

set local lock_timeout = '15s';
set local statement_timeout = '120s';

create or replace function pg_temp.table_control(target_table regclass)
returns jsonb
language plpgsql
as $$
declare
  row_count bigint;
  row_hash text;
begin
  execute format(
    $sql$
      select count(*), encode(
        extensions.digest(
          convert_to(coalesce(string_agg(to_jsonb(row_data)::text, E'\n' order by row_data.id), ''), 'UTF8'
        ),
        'sha256'
      ), 'hex')
      from %s row_data
    $sql$,
    target_table
  ) into row_count, row_hash;
  return jsonb_build_object('count', row_count, 'sha256', row_hash);
end;
$$;

create or replace function pg_temp.protected_controls()
returns jsonb
language sql
as $$
  select jsonb_build_object(
    'orders', pg_temp.table_control('public.orders'),
    'order_items', pg_temp.table_control('public.order_items'),
    'invoices', pg_temp.table_control('public.invoices'),
    'invoice_items', pg_temp.table_control('public.invoice_items'),
    'payments', pg_temp.table_control('public.payments'),
    'accounts_receivable', pg_temp.table_control('public.accounts_receivable'),
    'inventory_movements', pg_temp.table_control('public.inventory_movements'),
    'inventory_reservations', pg_temp.table_control('public.inventory_reservations'),
    'journal_entries', pg_temp.table_control('public.journal_entries'),
    'journal_entry_lines', pg_temp.table_control('public.journal_entry_lines')
  );
$$;

create temporary table _wm_rollback_runtime (
  operation_status text not null,
  actor_id uuid,
  actor_role text,
  target_count integer,
  protected_product_hash_before text,
  protected_product_hash_after text,
  protected_tables_before jsonb,
  protected_tables_after jsonb
) on commit drop;

do $$
declare
  c_apply_key constant text := 'wholesale-minimum-all-products-to-one-20260731-v1';
  c_rollback_key constant text := 'rollback-wholesale-minimum-all-products-to-one-20260731-v1';
  c_reason constant text := 'Rollback controlado del minimo mayorista global solicitado por el business_owner.';
  c_requested_by constant text := 'Edgar / business_owner';
  c_origin constant text := 'controlled_maintenance';
  apply_completed_count integer;
  rollback_completed_count integer;
  rollback_existing_count integer;
  technical_actor_count integer;
  technical_actor_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(c_apply_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(c_rollback_key, 0));

  select count(*) into apply_completed_count
  from public.audit_logs
  where action = 'products.wholesale_minimum_to_one.completed'
    and new_data ->> 'request_key' = c_apply_key
    and new_data ->> 'status' = 'completed';

  if apply_completed_count <> 1 then
    raise exception 'ROLLBACK_ABORT: no existe un unico batch aplicado y completado.';
  end if;

  select count(*) into rollback_existing_count
  from public.audit_logs
  where coalesce(new_data ->> 'request_key', old_data ->> 'request_key') = c_rollback_key;

  select count(*) into rollback_completed_count
  from public.audit_logs
  where action = 'products.wholesale_minimum_to_one.rollback.completed'
    and new_data ->> 'request_key' = c_rollback_key
    and new_data ->> 'status' = 'completed';

  if rollback_completed_count > 1 then
    raise exception 'ROLLBACK_ABORT: existen rollbacks completed duplicados.';
  end if;

  if rollback_completed_count = 1 then
    insert into _wm_rollback_runtime (operation_status) values ('already_rolled_back');
    return;
  end if;

  if rollback_existing_count <> 0 then
    raise exception 'ROLLBACK_ABORT: existe un rollback incompleto.';
  end if;

  select count(*), (array_agg(u.id order by u.id))[1] into technical_actor_count, technical_actor_id
  from public.users u
  join public.roles r on r.id = u.role_id
  where u.active and r.name = 'technical_owner';

  if technical_actor_count <> 1 or technical_actor_id is null then
    raise exception 'ROLLBACK_ABORT: no existe un unico technical_owner activo.';
  end if;

  lock table public.checkout_requests_v4 in share mode;
  lock table public.products in share row exclusive mode;
  lock table public.orders, public.order_items, public.invoices, public.invoice_items,
    public.payments, public.accounts_receivable, public.inventory_movements,
    public.inventory_reservations, public.journal_entries, public.journal_entry_lines in share mode;

  if exists (
    select 1 from public.checkout_requests_v4
    where status not in ('committed', 'failed_final', 'conflict', 'expired')
  ) then
    raise exception 'ROLLBACK_ABORT: existe un Checkout V4 no terminal.';
  end if;

  insert into _wm_rollback_runtime (operation_status, actor_id, actor_role)
  values ('rollback', technical_actor_id, 'technical_owner');
end;
$$;

create temporary table _wm_rollback_targets on commit drop as
select
  a.record_id as product_id,
  a.new_data ->> 'sku' as sku,
  (a.old_data ->> 'wholesale_min_quantity')::integer as restore_minimum,
  (a.new_data ->> 'wholesale_min_quantity')::integer as applied_minimum,
  (a.new_data ->> 'product_sales_version')::bigint as post_sales_version
from public.audit_logs a
where a.action = 'product.wholesale_minimum_to_one.changed'
  and a.new_data ->> 'request_key' = 'wholesale-minimum-all-products-to-one-20260731-v1'
  and exists (select 1 from _wm_rollback_runtime where operation_status = 'rollback');

create unique index _wm_rollback_targets_product_id_idx on _wm_rollback_targets(product_id);

do $$
declare
  target_count_value integer;
  product_hash text;
begin
  if not exists (select 1 from _wm_rollback_runtime where operation_status = 'rollback') then
    return;
  end if;

  select count(*) into target_count_value from _wm_rollback_targets;
  if target_count_value <> 150 then
    raise exception 'ROLLBACK_ABORT: la auditoria canonica contiene % productos, no 150.', target_count_value;
  end if;

  if exists (
    select 1 from _wm_rollback_targets
    where restore_minimum <> 3 or applied_minimum <> 1
  ) then
    raise exception 'ROLLBACK_ABORT: la auditoria contiene valores incompatibles.';
  end if;

  if exists (
    select 1
    from _wm_rollback_targets t
    left join public.products p on p.id = t.product_id
    where p.id is null
       or p.wholesale_min_quantity <> t.applied_minimum
       or p.product_sales_version <> t.post_sales_version
  ) then
    raise exception 'ROLLBACK_ABORT: un producto fue modificado despues del batch.';
  end if;

  select encode(
    extensions.digest(
      convert_to(
        coalesce(string_agg(
          (to_jsonb(p) - array['wholesale_min_quantity', 'product_sales_version', 'updated_at'])::text,
          E'\n' order by p.id
        ), ''),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ) into product_hash
  from public.products p
  join _wm_rollback_targets t on t.product_id = p.id;

  update _wm_rollback_runtime
  set target_count = target_count_value,
      protected_product_hash_before = product_hash,
      protected_tables_before = pg_temp.protected_controls()
  where operation_status = 'rollback';
end;
$$;

insert into public.audit_logs (user_id, actor_role, table_name, action, old_data, new_data)
select
  actor_id,
  actor_role,
  'products',
  'products.wholesale_minimum_to_one.rollback.started',
  jsonb_build_object('applied_request_key', 'wholesale-minimum-all-products-to-one-20260731-v1'),
  jsonb_build_object(
    'request_key', 'rollback-wholesale-minimum-all-products-to-one-20260731-v1',
    'applied_request_key', 'wholesale-minimum-all-products-to-one-20260731-v1',
    'reason', 'Rollback controlado del minimo mayorista global solicitado por el business_owner.',
    'requested_by', 'Edgar / business_owner',
    'executed_by', actor_id,
    'executed_role', actor_role,
    'execution_origin', 'controlled_maintenance',
    'target_count', target_count,
    'status', 'started'
  )
from _wm_rollback_runtime
where operation_status = 'rollback';

create temporary table _wm_rolled_back on commit drop as
with changed as (
  update public.products p
  set wholesale_min_quantity = t.restore_minimum
  from _wm_rollback_targets t
  where p.id = t.product_id
    and p.wholesale_min_quantity = t.applied_minimum
    and p.product_sales_version = t.post_sales_version
    and exists (select 1 from _wm_rollback_runtime where operation_status = 'rollback')
  returning p.id, p.wholesale_min_quantity, p.product_sales_version, p.updated_at
)
select t.*, c.wholesale_min_quantity as restored_minimum,
  c.product_sales_version as rollback_sales_version, c.updated_at as rollback_updated_at
from _wm_rollback_targets t
join changed c on c.id = t.product_id;

do $$
declare
  changed_count integer;
  product_hash text;
  controls_after jsonb;
begin
  if not exists (select 1 from _wm_rollback_runtime where operation_status = 'rollback') then
    return;
  end if;

  select count(*) into changed_count from _wm_rolled_back;
  if changed_count <> (select target_count from _wm_rollback_runtime where operation_status = 'rollback') then
    raise exception 'ROLLBACK_ABORT: conflicto; solo % filas coincidieron.', changed_count;
  end if;

  if exists (
    select 1 from _wm_rolled_back
    where restored_minimum <> restore_minimum
       or rollback_sales_version <> post_sales_version + 1
  ) then
    raise exception 'ROLLBACK_ABORT: minimo o version monotona incorrectos.';
  end if;

  select encode(
    extensions.digest(
      convert_to(
        coalesce(string_agg(
          (to_jsonb(p) - array['wholesale_min_quantity', 'product_sales_version', 'updated_at'])::text,
          E'\n' order by p.id
        ), ''),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  ) into product_hash
  from public.products p
  join _wm_rollback_targets t on t.product_id = p.id;

  controls_after := pg_temp.protected_controls();

  update _wm_rollback_runtime
  set protected_product_hash_after = product_hash,
      protected_tables_after = controls_after
  where operation_status = 'rollback';

  if product_hash is distinct from (
    select protected_product_hash_before from _wm_rollback_runtime where operation_status = 'rollback'
  ) or controls_after is distinct from (
    select protected_tables_before from _wm_rollback_runtime where operation_status = 'rollback'
  ) then
    raise exception 'ROLLBACK_ABORT: cambio una columna o tabla protegida.';
  end if;
end;
$$;

insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, old_data, new_data)
select
  r.actor_id,
  r.actor_role,
  'products',
  b.product_id,
  'product.wholesale_minimum_to_one.rolled_back',
  jsonb_build_object(
    'request_key', 'rollback-wholesale-minimum-all-products-to-one-20260731-v1',
    'applied_request_key', 'wholesale-minimum-all-products-to-one-20260731-v1',
    'reason', 'Rollback controlado del minimo mayorista global solicitado por el business_owner.',
    'requested_by', 'Edgar / business_owner',
    'execution_origin', 'controlled_maintenance',
    'wholesale_min_quantity', b.applied_minimum,
    'product_sales_version', b.post_sales_version
  ),
  jsonb_build_object(
    'request_key', 'rollback-wholesale-minimum-all-products-to-one-20260731-v1',
    'applied_request_key', 'wholesale-minimum-all-products-to-one-20260731-v1',
    'reason', 'Rollback controlado del minimo mayorista global solicitado por el business_owner.',
    'requested_by', 'Edgar / business_owner',
    'executed_by', r.actor_id,
    'executed_role', r.actor_role,
    'execution_origin', 'controlled_maintenance',
    'wholesale_min_quantity', b.restored_minimum,
    'product_sales_version', b.rollback_sales_version,
    'updated_at', b.rollback_updated_at
  )
from _wm_rolled_back b
cross join _wm_rollback_runtime r
where r.operation_status = 'rollback';

insert into public.audit_logs (user_id, actor_role, table_name, action, old_data, new_data)
select
  actor_id,
  actor_role,
  'products',
  'products.wholesale_minimum_to_one.rollback.completed',
  jsonb_build_object(
    'applied_request_key', 'wholesale-minimum-all-products-to-one-20260731-v1',
    'protected_product_sha256', protected_product_hash_before,
    'protected_tables', protected_tables_before
  ),
  jsonb_build_object(
    'request_key', 'rollback-wholesale-minimum-all-products-to-one-20260731-v1',
    'applied_request_key', 'wholesale-minimum-all-products-to-one-20260731-v1',
    'reason', 'Rollback controlado del minimo mayorista global solicitado por el business_owner.',
    'requested_by', 'Edgar / business_owner',
    'executed_by', actor_id,
    'executed_role', actor_role,
    'execution_origin', 'controlled_maintenance',
    'restored_count', (select count(*) from _wm_rolled_back),
    'protected_product_sha256_before', protected_product_hash_before,
    'protected_product_sha256_after', protected_product_hash_after,
    'protected_tables_before', protected_tables_before,
    'protected_tables_after', protected_tables_after,
    'status', 'completed'
  )
from _wm_rollback_runtime
where operation_status = 'rollback';

update _wm_rollback_runtime
set operation_status = 'completed'
where operation_status = 'rollback';

select
  case operation_status
    when 'already_rolled_back' then 'ALREADY_ROLLED_BACK'
    else 'ROLLED_BACK'
  end as result,
  coalesce(target_count, 0) as selected_products,
  case when operation_status = 'completed' then (select count(*) from _wm_rolled_back) else 0 end as restored_products,
  protected_product_hash_before,
  protected_product_hash_after,
  protected_tables_before,
  protected_tables_after
from _wm_rollback_runtime;

commit;
