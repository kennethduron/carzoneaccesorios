do $$
begin
  if exists (select 1 from public.products where nullif(btrim(sku), '') is null) then
    raise exception 'No se puede proteger SKU: existen valores vacios o con espacios.';
  end if;

  if exists (
    select 1
    from public.products
    group by upper(btrim(sku))
    having count(*) > 1
  ) then
    raise exception 'No se puede proteger SKU: existen colisiones normalizadas por case/trim.';
  end if;
end;
$$;

create unique index if not exists products_sku_upper_btrim_uidx
  on public.products (upper(btrim(sku)));

alter table public.import_batches drop constraint if exists import_batches_module_check;
alter table public.import_batches add constraint import_batches_module_check
  check (module in ('accounts_receivable', 'accounts_payable', 'products'));

alter table public.import_rows drop constraint if exists import_rows_module_check;
alter table public.import_rows add constraint import_rows_module_check
  check (module in ('accounts_receivable', 'accounts_payable', 'products'));

alter table public.import_audit_events drop constraint if exists import_audit_events_module_check;
alter table public.import_audit_events add constraint import_audit_events_module_check
  check (module in ('accounts_receivable', 'accounts_payable', 'products'));

create unique index if not exists import_rows_batch_row_uidx
  on public.import_rows (batch_id, row_number);

create or replace function public.has_import_foundation_permission(import_module text, import_action text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if import_module = 'accounts_receivable' then
    if import_action = 'import' then
      return public.has_permission('receivables:import') or public.has_permission('credit:manage');
    elsif import_action = 'apply' then
      return public.has_permission('receivables:apply') or public.has_permission('credit:manage');
    elsif import_action = 'rollback' then
      return public.has_permission('receivables:rollback') or public.has_permission('credit:manage');
    elsif import_action = 'assign' then
      return public.has_permission('receivables:assign') or public.has_permission('credit:manage');
    elsif import_action in ('review', 'audit') then
      return public.has_permission('receivables:review') or public.has_permission('receivables:read') or public.has_permission('credit:manage');
    end if;
  elsif import_module = 'accounts_payable' then
    if import_action = 'import' then
      return public.has_permission('payables:import') or public.has_permission('payables:manage');
    elsif import_action = 'apply' then
      return public.has_permission('payables:apply') or public.has_permission('payables:manage');
    elsif import_action = 'rollback' then
      return public.has_permission('payables:rollback') or public.has_permission('payables:manage');
    elsif import_action = 'assign' then
      return public.has_permission('payables:assign') or public.has_permission('payables:manage');
    elsif import_action in ('review', 'audit') then
      return public.has_permission('payables:review') or public.has_permission('payables:read') or public.has_permission('payables:manage');
    end if;
  elsif import_module = 'products' then
    if import_action in ('import', 'apply') then
      return public.has_permission('products:import') or public.has_permission('products:manage');
    elsif import_action in ('review', 'audit') then
      return public.has_permission('products:read')
        or public.has_permission('products:import')
        or public.has_permission('products:manage');
    end if;
  end if;

  return false;
end;
$$;

create or replace function public.create_product_import_preflight(
  file_name text,
  file_bytes integer,
  file_sha256 text,
  row_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_batch_id uuid;
  total_rows integer;
begin
  if auth.uid() is null then
    raise exception 'Autenticacion requerida.';
  end if;
  if not public.has_import_foundation_permission('products', 'import') then
    raise exception 'No tienes permiso para importar productos.';
  end if;
  if file_bytes is null or file_bytes < 1 or file_bytes > 10485760 then
    raise exception 'El archivo Excel supera el limite de 10 MiB.';
  end if;
  if row_payload is null or jsonb_typeof(row_payload) <> 'array' then
    raise exception 'Las filas del archivo no son validas.';
  end if;

  total_rows := jsonb_array_length(row_payload);
  if total_rows < 1 then
    raise exception 'El archivo no contiene productos para importar.';
  end if;
  if total_rows > 5000 then
    raise exception 'El archivo contiene mas de 5,000 productos. Divida la importacion en archivos mas pequenos.';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(row_payload) payload(value)
    group by upper(btrim(value->>'sku'))
    having nullif(upper(btrim(value->>'sku')), '') is not null and count(*) > 1
  ) then
    raise exception 'El archivo contiene SKU duplicados segun la normalizacion case-insensitive y trim.';
  end if;
  if (
    select count(distinct (value->>'row_number')::integer)
    from jsonb_array_elements(row_payload) payload(value)
    where (value->>'row_number') ~ '^[0-9]+$'
      and (value->>'row_number')::integer between 2 and total_rows + 1
  ) <> total_rows then
    raise exception 'La numeracion de filas del archivo no es valida.';
  end if;

  insert into public.import_batches (
    module, status, created_by, total_rows, pending_rows, validated_rows, metadata
  ) values (
    'products', 'ready', auth.uid(), total_rows, total_rows, total_rows,
    jsonb_build_object(
      'file_name', nullif(btrim(file_name), ''),
      'file_bytes', file_bytes,
      'file_sha256', nullif(btrim(file_sha256), ''),
      'max_rows', 5000,
      'max_xlsx_bytes', 10485760
    )
  ) returning id into new_batch_id;

  insert into public.import_rows (
    batch_id, module, row_number, original_data, normalized_data,
    validation_status, validation_messages, assignment_type, assignment_status, apply_status
  )
  select
    new_batch_id,
    'products',
    (value->>'row_number')::integer,
    '{}'::jsonb,
    jsonb_build_object('sku', upper(btrim(coalesce(value->>'sku', '')))),
    case when nullif(btrim(value->>'sku'), '') is null then 'invalid' else 'valid' end,
    case when nullif(btrim(value->>'sku'), '') is null then '["SKU obligatorio."]'::jsonb else '[]'::jsonb end,
    'none',
    'not_required',
    'ready'
  from jsonb_array_elements(row_payload) payload(value);

  insert into public.import_audit_events (batch_id, module, event_type, metadata, created_by)
  values (
    new_batch_id,
    'products',
    'product_import_preflight_validated',
    jsonb_build_object('file_name', nullif(btrim(file_name), ''), 'file_bytes', file_bytes, 'total_rows', total_rows),
    auth.uid()
  );

  return new_batch_id;
end;
$$;

create or replace function public.import_product_batch_row_v3_atomic(
  target_batch_id uuid,
  target_row_number integer,
  product_data jsonb,
  images_data jsonb,
  target_stock integer,
  import_mode text default 'create_and_update'
)
returns table (
  product_id uuid,
  row_status text,
  stock_applied boolean,
  stock_unchanged boolean,
  movement_id uuid,
  stock_before integer,
  stock_after integer,
  quantity integer,
  removed_asset_ids text[],
  consumed_asset_ids text[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  target_batch public.import_batches;
  target_row public.import_rows;
  imported record;
  normalized_sku text := upper(nullif(btrim(product_data->>'sku'), ''));
begin
  select * into target_batch
  from public.import_batches
  where id = target_batch_id
  for update;

  if target_batch.id is null
    or target_batch.module <> 'products'
    or target_batch.created_by is distinct from auth.uid()
    or target_batch.total_rows < 1
    or target_batch.total_rows > 5000
    or target_batch.status not in ('ready', 'failed') then
    raise exception 'El lote de importacion no es valido.';
  end if;
  if not public.has_import_foundation_permission('products', 'import') then
    raise exception 'No tienes permiso para importar productos.';
  end if;

  select * into target_row
  from public.import_rows
  where batch_id = target_batch_id and row_number = target_row_number
  for update;

  if target_row.id is null or upper(btrim(coalesce(target_row.normalized_data->>'sku', ''))) is distinct from normalized_sku then
    raise exception 'La fila no coincide con el XLSX validado en servidor.';
  end if;

  if target_row.apply_status in ('applied', 'skipped') then
    product_id := null;
    row_status := 'skipped';
    stock_applied := false;
    stock_unchanged := true;
    movement_id := null;
    stock_before := null;
    stock_after := null;
    quantity := null;
    removed_asset_ids := array[]::text[];
    consumed_asset_ids := array[]::text[];
    return next;
    return;
  end if;

  select * into imported
  from public.import_product_row_v2_atomic(product_data, images_data, target_stock, import_mode);

  update public.import_rows
  set
    apply_status = case when imported.row_status = 'skipped' then 'skipped' else 'applied' end,
    apply_error = null,
    audit_metadata = audit_metadata || jsonb_build_object(
      'sku', normalized_sku,
      'row_status', imported.row_status,
      'product_id', imported.product_id,
      'movement_id', imported.movement_id
    ),
    updated_at = now()
  where id = target_row.id;

  product_id := imported.product_id;
  row_status := imported.row_status;
  stock_applied := imported.stock_applied;
  stock_unchanged := imported.stock_unchanged;
  movement_id := imported.movement_id;
  stock_before := imported.stock_before;
  stock_after := imported.stock_after;
  quantity := imported.quantity;
  removed_asset_ids := imported.removed_asset_ids;
  consumed_asset_ids := imported.consumed_asset_ids;
  return next;
end;
$$;

revoke all on function public.create_product_import_preflight(text, integer, text, jsonb) from public, anon;
revoke all on function public.import_product_batch_row_v3_atomic(uuid, integer, jsonb, jsonb, integer, text) from public, anon;
grant execute on function public.create_product_import_preflight(text, integer, text, jsonb) to authenticated, service_role;
grant execute on function public.import_product_batch_row_v3_atomic(uuid, integer, jsonb, jsonb, integer, text) to authenticated, service_role;

comment on index public.products_sku_upper_btrim_uidx is
  'Protects SKU uniqueness case-insensitively after trimming exterior whitespace; hyphens remain significant.';
comment on function public.create_product_import_preflight(text, integer, text, jsonb) is
  'Validates product XLSX limits and stages traceable rows before any product mutation.';
comment on function public.import_product_batch_row_v3_atomic(uuid, integer, jsonb, jsonb, integer, text) is
  'Imports one staged product row atomically and prevents replay after a committed row.';
