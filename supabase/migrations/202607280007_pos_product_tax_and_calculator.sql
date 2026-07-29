-- POS Phase 1 / Stage 4: product fiscal classification and a versioned,
-- line-aware calculator. The public checkout keeps calculate_sale_financials_v1.

alter table public.products
  add column if not exists tax_category text,
  add column if not exists product_sales_version bigint;

update public.products
set tax_category = 'standard'
where tax_category is null;

update public.products
set product_sales_version = 1
where product_sales_version is null;

alter table public.products
  alter column tax_category set default 'standard',
  alter column tax_category set not null,
  alter column product_sales_version set default 1,
  alter column product_sales_version set not null;

alter table public.products
  drop constraint if exists products_tax_category_check;

alter table public.products
  add constraint products_tax_category_check
  check (tax_category in ('standard', 'exempt'));

alter table public.products
  drop constraint if exists products_product_sales_version_check;

alter table public.products
  add constraint products_product_sales_version_check
  check (product_sales_version > 0);

comment on column public.products.tax_category is
  'Fiscal classification used by POS calculations. Existing products were conservatively backfilled as standard after reconciling historical 15% included-tax documents; this is not a fiscal certification.';
comment on column public.products.product_sales_version is
  'Optimistic commercial version. Changes only when a sales-relevant product attribute changes; stock-only updates do not increment it.';

create or replace function public.bump_product_sales_version_v1()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if row(
    new.category_id,
    new.sku,
    new.internal_code,
    new.name,
    new.brand,
    new.short_description,
    new.retail_price,
    new.wholesale_price,
    new.wholesale_min_quantity,
    new.cost_price,
    new.tax_category,
    new.status,
    new.active
  ) is distinct from row(
    old.category_id,
    old.sku,
    old.internal_code,
    old.name,
    old.brand,
    old.short_description,
    old.retail_price,
    old.wholesale_price,
    old.wholesale_min_quantity,
    old.cost_price,
    old.tax_category,
    old.status,
    old.active
  ) then
    new.product_sales_version := old.product_sales_version + 1;
  else
    new.product_sales_version := old.product_sales_version;
  end if;
  return new;
end;
$$;

drop trigger if exists products_bump_sales_version on public.products;
create trigger products_bump_sales_version
before update on public.products
for each row execute function public.bump_product_sales_version_v1();

create or replace function public.audit_product_tax_category_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.tax_category is distinct from new.tax_category and auth.uid() is not null then
    perform public.write_audit_log(
      'products',
      new.id,
      'product.tax_category_changed',
      jsonb_build_object(
        'tax_category', old.tax_category,
        'product_sales_version', old.product_sales_version
      ),
      jsonb_build_object(
        'tax_category', new.tax_category,
        'product_sales_version', new.product_sales_version
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists products_audit_tax_category on public.products;
create trigger products_audit_tax_category
after update of tax_category on public.products
for each row execute function public.audit_product_tax_category_v1();

-- V2 wrappers retain the proven catalog/image and atomic import behavior, then
-- apply the new fiscal field in the same database transaction.
create or replace function public.save_product_catalog_v2_locked(
  target_product_id uuid,
  product_data jsonb,
  images_data jsonb default null
)
returns table (
  product_id uuid,
  removed_asset_ids text[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  saved record;
  normalized_tax_category text := lower(trim(coalesce(product_data->>'tax_category', '')));
begin
  if normalized_tax_category not in ('standard', 'exempt') then
    raise exception using errcode = '22023',
      message = 'La clasificacion fiscal debe ser standard o exempt.';
  end if;

  select * into saved
  from public.save_product_catalog_locked(target_product_id, product_data, images_data);

  update public.products
  set tax_category = normalized_tax_category
  where id = saved.product_id
    and tax_category is distinct from normalized_tax_category;

  product_id := saved.product_id;
  removed_asset_ids := saved.removed_asset_ids;
  return next;
end;
$$;

create or replace function public.import_product_row_v2_atomic(
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
  imported record;
  normalized_tax_category text := lower(trim(coalesce(product_data->>'tax_category', '')));
begin
  if normalized_tax_category not in ('standard', 'exempt') then
    raise exception using errcode = '22023',
      message = 'La clasificacion fiscal debe ser standard o exempt.';
  end if;

  select * into imported
  from public.import_product_row_atomic(product_data, images_data, target_stock, import_mode);

  if imported.product_id is not null and imported.row_status <> 'skipped' then
    update public.products
    set tax_category = normalized_tax_category
    where id = imported.product_id
      and tax_category is distinct from normalized_tax_category;
  end if;

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

revoke all on function public.save_product_catalog_v2_locked(uuid, jsonb, jsonb) from public, anon;
revoke all on function public.import_product_row_v2_atomic(jsonb, jsonb, integer, text) from public, anon;
grant execute on function public.save_product_catalog_v2_locked(uuid, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.import_product_row_v2_atomic(jsonb, jsonb, integer, text) to authenticated, service_role;

create or replace function public.calculate_pos_draft_financials_v2(
  resolved_lines jsonb,
  included_tax_rate numeric default 0.15,
  delivery_charge numeric default 0,
  cash_on_delivery_charge numeric default 0,
  other_charges numeric default 0,
  currency_code text default 'HNL'
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  line_record record;
  line_gross numeric(14,2);
  line_base numeric(14,2);
  line_tax numeric(14,2);
  merchandise_total numeric(14,2) := 0;
  taxable_gross numeric(14,2) := 0;
  taxable_base numeric(14,2) := 0;
  exempt_total numeric(14,2) := 0;
  tax_total numeric(14,2) := 0;
  normalized_delivery numeric(14,2) := round(coalesce(delivery_charge, 0), 2);
  normalized_cod numeric(14,2) := round(coalesce(cash_on_delivery_charge, 0), 2);
  normalized_other numeric(14,2) := round(coalesce(other_charges, 0), 2);
  calculated_lines jsonb := '[]'::jsonb;
begin
  if upper(trim(coalesce(currency_code, ''))) <> 'HNL' then
    raise exception using errcode = '22023', message = 'La moneda del calculo debe ser HNL.';
  end if;
  if included_tax_rate is null or included_tax_rate < 0 or included_tax_rate > 1 then
    raise exception using errcode = '22023', message = 'La tasa fiscal incluida no es valida.';
  end if;
  if normalized_delivery < 0 or normalized_cod < 0 or normalized_other < 0 then
    raise exception using errcode = '22023', message = 'Los cargos no pueden ser negativos.';
  end if;
  if resolved_lines is null or jsonb_typeof(resolved_lines) <> 'array' then
    raise exception using errcode = '22023', message = 'Las lineas no tienen un formato valido.';
  end if;

  for line_record in
    select
      value as line,
      nullif(value->>'quantity', '')::numeric as quantity,
      nullif(value->>'unit_price', '')::numeric as unit_price,
      lower(trim(coalesce(value->>'tax_category', ''))) as tax_category
    from jsonb_array_elements(resolved_lines)
  loop
    if jsonb_typeof(line_record.line) <> 'object'
      or line_record.quantity is null
      or line_record.quantity <= 0
      or trunc(line_record.quantity) <> line_record.quantity then
      raise exception using errcode = '22023', message = 'Todas las cantidades deben ser enteros mayores que cero.';
    end if;
    if line_record.unit_price is null or line_record.unit_price <= 0 then
      raise exception using errcode = '22023', message = 'Todos los precios deben ser mayores que cero.';
    end if;
    if line_record.tax_category not in ('standard', 'exempt') then
      raise exception using errcode = '22023', message = 'La clasificacion fiscal de una linea no es valida.';
    end if;

    line_gross := round(line_record.quantity * line_record.unit_price, 2);
    if line_record.tax_category = 'standard' and included_tax_rate > 0 then
      line_base := round(line_gross / (1 + included_tax_rate), 2);
      line_tax := round(line_gross - line_base, 2);
      taxable_base := round(taxable_base + line_base, 2);
      tax_total := round(tax_total + line_tax, 2);
      taxable_gross := round(taxable_gross + line_gross, 2);
    else
      line_base := line_gross;
      line_tax := 0;
      exempt_total := round(exempt_total + line_gross, 2);
    end if;
    merchandise_total := round(merchandise_total + line_gross, 2);
    calculated_lines := calculated_lines || jsonb_build_array(
      line_record.line || jsonb_build_object(
        'line_total', line_gross,
        'taxable_base', line_base,
        'tax_amount', line_tax
      )
    );
  end loop;

  return jsonb_build_object(
    'calculation_version', 2,
    'currency', 'HNL',
    'included_tax_rate', round(included_tax_rate, 6),
    'lines', calculated_lines,
    'merchandise_total', merchandise_total,
    'merchandise_gross', merchandise_total,
    'taxable_gross', taxable_gross,
    'taxable_base', taxable_base,
    'exempt_total', exempt_total,
    'exempt_gross', exempt_total,
    'tax_total', tax_total,
    'tax_amount', tax_total,
    'discount_total', 0,
    'delivery_charge', normalized_delivery,
    'shipping_fee', normalized_delivery,
    'cash_on_delivery_charge', normalized_cod,
    'cod_fee', normalized_cod,
    'other_charges', normalized_other,
    'other_charge', normalized_other,
    'total', round(merchandise_total + normalized_delivery + normalized_cod + normalized_other, 2),
    'grand_total', round(merchandise_total + normalized_delivery + normalized_cod + normalized_other, 2)
  );
end;
$$;

revoke all on function public.calculate_pos_draft_financials_v2(jsonb, numeric, numeric, numeric, numeric, text)
  from public, anon, authenticated;
grant execute on function public.calculate_pos_draft_financials_v2(jsonb, numeric, numeric, numeric, numeric, text)
  to service_role;
