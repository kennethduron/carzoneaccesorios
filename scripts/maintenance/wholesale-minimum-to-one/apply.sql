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

create temporary table _wm_runtime (
  operation_status text not null,
  actor_id uuid,
  actor_role text,
  total_before integer,
  minimum_1_before integer,
  minimum_3_before integer,
  target_count integer,
  protected_product_hash_before text,
  protected_product_hash_after text,
  protected_tables_before jsonb,
  protected_tables_after jsonb
) on commit drop;

do $$
declare
  c_request_key constant text := 'wholesale-minimum-all-products-to-one-20260731-v1';
  c_reason constant text := 'Solicitud del business_owner para permitir que los clientes mayoristas compren desde una unidad al precio mayorista.';
  c_requested_by constant text := 'Edgar / business_owner';
  c_origin constant text := 'controlled_maintenance';
  completed_count integer;
  existing_count integer;
  mismatched_payload_count integer;
  technical_actor_count integer;
  technical_actor_id uuid;
  active_checkout_count integer;
  active_import_count integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(c_request_key, 0));

  select count(*) into existing_count
  from public.audit_logs
  where coalesce(new_data ->> 'request_key', old_data ->> 'request_key') = c_request_key;

  select count(*) into mismatched_payload_count
  from public.audit_logs
  where coalesce(new_data ->> 'request_key', old_data ->> 'request_key') = c_request_key
    and (
      coalesce(new_data ->> 'reason', old_data ->> 'reason') is distinct from c_reason
      or coalesce(new_data ->> 'requested_by', old_data ->> 'requested_by') is distinct from c_requested_by
      or coalesce(new_data ->> 'execution_origin', old_data ->> 'execution_origin') is distinct from c_origin
    );

  if mismatched_payload_count <> 0 then
    raise exception 'APPLY_ABORT: request key reutilizada con razon, solicitante u origen diferentes.';
  end if;

  select count(*) into completed_count
  from public.audit_logs
  where action = 'products.wholesale_minimum_to_one.completed'
    and new_data ->> 'request_key' = c_request_key
    and new_data ->> 'status' = 'completed';

  if completed_count > 1 then
    raise exception 'APPLY_ABORT: existen batches completed duplicados.';
  end if;

  if completed_count = 1 then
    if exists (select 1 from public.products where wholesale_min_quantity <> 1) then
      raise exception 'APPLY_ABORT: el batch figura completed pero existen productos con minimo diferente de 1.';
    end if;
    insert into _wm_runtime (operation_status) values ('already_applied');
    return;
  end if;

  if existing_count <> 0 then
    raise exception 'APPLY_ABORT: existe un batch incompleto para la request key.';
  end if;

  select count(*), (array_agg(u.id order by u.id))[1] into technical_actor_count, technical_actor_id
  from public.users u
  join public.roles r on r.id = u.role_id
  where u.active and r.name = 'technical_owner';

  if technical_actor_count <> 1 or technical_actor_id is null then
    raise exception 'APPLY_ABORT: no existe un unico technical_owner activo.';
  end if;

  lock table public.checkout_requests_v4 in share mode;
  lock table public.products in share row exclusive mode;
  lock table public.orders, public.order_items, public.invoices, public.invoice_items,
    public.payments, public.accounts_receivable, public.inventory_movements,
    public.inventory_reservations, public.journal_entries, public.journal_entry_lines in share mode;

  select count(*) into active_checkout_count
  from public.checkout_requests_v4
  where status not in ('committed', 'failed_final', 'conflict', 'expired');

  if active_checkout_count <> 0 then
    raise exception 'APPLY_ABORT: existen % Checkout V4 no terminales.', active_checkout_count;
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
    raise exception 'APPLY_ABORT: existe una importacion de productos activa.';
  end if;

  insert into _wm_runtime (operation_status, actor_id, actor_role)
  values ('apply', technical_actor_id, 'technical_owner');
end;
$$;

create temporary table _wm_targets on commit drop as
select
  p.id as product_id,
  p.sku,
  p.name,
  p.active,
  p.wholesale_min_quantity as old_minimum,
  p.product_sales_version as old_sales_version,
  p.updated_at as old_updated_at
from public.products p
where p.wholesale_min_quantity <> 1
  and exists (select 1 from _wm_runtime where operation_status = 'apply');

create unique index _wm_targets_product_id_idx on _wm_targets(product_id);

do $$
declare
  target_count_value integer;
  total_value integer;
  minimum_1_value integer;
  minimum_3_value integer;
  product_hash text;
begin
  if not exists (select 1 from _wm_runtime where operation_status = 'apply') then
    return;
  end if;

  select count(*) into target_count_value from _wm_targets;
  if target_count_value <> 150 then
    raise exception 'APPLY_ABORT: se esperaban 150 objetivos y se encontraron %.', target_count_value;
  end if;

  if exists (select 1 from _wm_targets where old_minimum <> 3) then
    raise exception 'APPLY_ABORT: un objetivo tiene minimo anterior diferente de 3.';
  end if;

  if exists (
    select 1 from public.products
    where wholesale_min_quantity is null
       or wholesale_min_quantity <= 0
       or wholesale_min_quantity not in (1, 3)
       or retail_price is null or retail_price <= 0
       or wholesale_price is null or wholesale_price <= 0
       or wholesale_price >= retail_price
  ) then
    raise exception 'APPLY_ABORT: existe un producto con minimo o precio inconsistente.';
  end if;

  select
    count(*)::integer,
    count(*) filter (where wholesale_min_quantity = 1)::integer,
    count(*) filter (where wholesale_min_quantity = 3)::integer
  into total_value, minimum_1_value, minimum_3_value
  from public.products;

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
  join _wm_targets t on t.product_id = p.id;

  update _wm_runtime
  set total_before = total_value,
      minimum_1_before = minimum_1_value,
      minimum_3_before = minimum_3_value,
      target_count = target_count_value,
      protected_product_hash_before = product_hash,
      protected_tables_before = pg_temp.protected_controls()
  where operation_status = 'apply';
end;
$$;

insert into public.audit_logs (
  user_id, actor_role, table_name, record_id, action, old_data, new_data
)
select
  actor_id,
  actor_role,
  'products',
  null,
  'products.wholesale_minimum_to_one.started',
  jsonb_build_object(
    'minimum_1', minimum_1_before,
    'minimum_3', minimum_3_before,
    'target_count', target_count
  ),
  jsonb_build_object(
    'request_key', 'wholesale-minimum-all-products-to-one-20260731-v1',
    'operation_type', 'global_wholesale_minimum_update',
    'reason', 'Solicitud del business_owner para permitir que los clientes mayoristas compren desde una unidad al precio mayorista.',
    'requested_by', 'Edgar / business_owner',
    'executed_by', actor_id,
    'executed_role', actor_role,
    'execution_origin', 'controlled_maintenance',
    'expected_count', 150,
    'snapshot_sha256', 'b28f0a4778f54d6b186c6faed320a0f2f1d65e548b65113e73fa061b8e7b4f41',
    'protected_product_sha256', protected_product_hash_before,
    'status', 'started'
  )
from _wm_runtime
where operation_status = 'apply';

create temporary table _wm_updated on commit drop as
with changed as (
  update public.products p
  set wholesale_min_quantity = 1
  from _wm_targets t
  where p.id = t.product_id
    and p.wholesale_min_quantity = t.old_minimum
    and p.product_sales_version = t.old_sales_version
    and exists (select 1 from _wm_runtime where operation_status = 'apply')
  returning p.id, p.wholesale_min_quantity, p.product_sales_version, p.updated_at
)
select
  t.*,
  c.wholesale_min_quantity as new_minimum,
  c.product_sales_version as new_sales_version,
  c.updated_at as new_updated_at
from _wm_targets t
join changed c on c.id = t.product_id;

do $$
declare
  changed_count integer;
  product_hash text;
  controls_after jsonb;
begin
  if not exists (select 1 from _wm_runtime where operation_status = 'apply') then
    return;
  end if;

  select count(*) into changed_count from _wm_updated;
  if changed_count <> (select target_count from _wm_runtime where operation_status = 'apply') then
    raise exception 'APPLY_ABORT: conflicto de concurrencia; solo % filas de % coincidieron.',
      changed_count, (select target_count from _wm_runtime where operation_status = 'apply');
  end if;

  if exists (
    select 1 from _wm_updated
    where old_minimum <> 3
       or new_minimum <> 1
       or new_sales_version <> old_sales_version + 1
       or new_updated_at < old_updated_at
  ) then
    raise exception 'APPLY_ABORT: minimo, version comercial o updated_at no cumplieron el contrato.';
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
  join _wm_targets t on t.product_id = p.id;

  controls_after := pg_temp.protected_controls();

  update _wm_runtime
  set protected_product_hash_after = product_hash,
      protected_tables_after = controls_after
  where operation_status = 'apply';

  if product_hash is distinct from (
    select protected_product_hash_before from _wm_runtime where operation_status = 'apply'
  ) then
    raise exception 'APPLY_ABORT: cambio el hash de columnas protegidas de products.';
  end if;

  if controls_after is distinct from (
    select protected_tables_before from _wm_runtime where operation_status = 'apply'
  ) then
    raise exception 'APPLY_ABORT: cambio una tabla protegida.';
  end if;

  if exists (select 1 from public.products where wholesale_min_quantity <> 1) then
    raise exception 'APPLY_ABORT: la postcondicion global de minimo 1 fallo.';
  end if;
end;
$$;

insert into public.audit_logs (
  user_id, actor_role, table_name, record_id, action, old_data, new_data
)
select
  r.actor_id,
  r.actor_role,
  'products',
  u.product_id,
  'product.wholesale_minimum_to_one.changed',
  jsonb_build_object(
    'request_key', 'wholesale-minimum-all-products-to-one-20260731-v1',
    'reason', 'Solicitud del business_owner para permitir que los clientes mayoristas compren desde una unidad al precio mayorista.',
    'requested_by', 'Edgar / business_owner',
    'execution_origin', 'controlled_maintenance',
    'product_id', u.product_id,
    'sku', u.sku,
    'wholesale_min_quantity', u.old_minimum,
    'product_sales_version', u.old_sales_version,
    'updated_at', u.old_updated_at
  ),
  jsonb_build_object(
    'request_key', 'wholesale-minimum-all-products-to-one-20260731-v1',
    'reason', 'Solicitud del business_owner para permitir que los clientes mayoristas compren desde una unidad al precio mayorista.',
    'requested_by', 'Edgar / business_owner',
    'executed_by', r.actor_id,
    'executed_role', r.actor_role,
    'execution_origin', 'controlled_maintenance',
    'product_id', u.product_id,
    'sku', u.sku,
    'wholesale_min_quantity', u.new_minimum,
    'product_sales_version', u.new_sales_version,
    'updated_at', u.new_updated_at
  )
from _wm_updated u
cross join _wm_runtime r
where r.operation_status = 'apply';

insert into public.audit_logs (
  user_id, actor_role, table_name, record_id, action, old_data, new_data
)
select
  r.actor_id,
  r.actor_role,
  'products',
  null,
  'products.wholesale_minimum_to_one.completed',
  jsonb_build_object(
    'minimum_1', r.minimum_1_before,
    'minimum_3', r.minimum_3_before,
    'target_count', r.target_count,
    'protected_product_sha256', r.protected_product_hash_before,
    'protected_tables', r.protected_tables_before
  ),
  jsonb_build_object(
    'request_key', 'wholesale-minimum-all-products-to-one-20260731-v1',
    'operation_type', 'global_wholesale_minimum_update',
    'reason', 'Solicitud del business_owner para permitir que los clientes mayoristas compren desde una unidad al precio mayorista.',
    'requested_by', 'Edgar / business_owner',
    'executed_by', r.actor_id,
    'executed_role', r.actor_role,
    'execution_origin', 'controlled_maintenance',
    'expected_count', 150,
    'updated_count', (select count(*) from _wm_updated),
    'skipped_count', 0,
    'version_conflicts', 0,
    'snapshot_sha256', 'b28f0a4778f54d6b186c6faed320a0f2f1d65e548b65113e73fa061b8e7b4f41',
    'protected_product_sha256_before', r.protected_product_hash_before,
    'protected_product_sha256_after', r.protected_product_hash_after,
    'protected_tables_before', r.protected_tables_before,
    'protected_tables_after', r.protected_tables_after,
    'status', 'completed'
  )
from _wm_runtime r
where r.operation_status = 'apply';

update _wm_runtime
set operation_status = 'completed'
where operation_status = 'apply';

select
  case operation_status
    when 'already_applied' then 'ALREADY_APPLIED'
    else 'APPLIED'
  end as result,
  coalesce(target_count, 0) as selected_products,
  case when operation_status = 'completed' then (select count(*) from _wm_updated) else 0 end as updated_products,
  coalesce(protected_product_hash_before, protected_product_hash_after) as protected_product_sha256_before,
  protected_product_hash_after as protected_product_sha256_after,
  protected_tables_before,
  protected_tables_after
from _wm_runtime;

commit;
