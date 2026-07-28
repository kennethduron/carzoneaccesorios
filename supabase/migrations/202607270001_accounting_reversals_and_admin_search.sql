-- Accounting reversal integrity, accounted-report contract, safe public products,
-- and bounded administrative search contracts.
-- This migration changes no historical journal entry, product, purchase, or stock row.

create or replace function public.get_accounting_report_aggregates(
  p_date_from date default null,
  p_date_to date default null,
  p_account_ids uuid[] default null,
  p_mode text default 'period'
)
returns table (
  calculation_mode text,
  account_id uuid,
  debit_total numeric(20, 2),
  credit_total numeric(20, 2)
)
language sql
stable
security invoker
set search_path = public
as $function$
  with requested_modes as (
    select unnest(
      case p_mode
        when 'opening' then array['opening']::text[]
        when 'period' then array['period']::text[]
        when 'both' then array['opening', 'period']::text[]
        when 'as_of' then array['as_of']::text[]
        else array[]::text[]
      end
    ) as calculation_mode
  )
  select
    requested_modes.calculation_mode,
    lines.account_id,
    coalesce(sum(lines.debit), 0)::numeric(20, 2) as debit_total,
    coalesce(sum(lines.credit), 0)::numeric(20, 2) as credit_total
  from requested_modes
  cross join public.journal_entry_lines as lines
  inner join public.journal_entries as entries
    on entries.id = lines.journal_entry_id
  where entries.status in ('publicada', 'reversada')
    and (p_account_ids is null or lines.account_id = any(p_account_ids))
    and case requested_modes.calculation_mode
      when 'opening' then p_date_from is not null and entries.entry_date < p_date_from
      when 'period' then
        (p_date_from is null or entries.entry_date >= p_date_from)
        and (p_date_to is null or entries.entry_date <= p_date_to)
      when 'as_of' then p_date_to is null or entries.entry_date <= p_date_to
      else false
    end
  group by requested_modes.calculation_mode, lines.account_id
  order by requested_modes.calculation_mode, lines.account_id;
$function$;

comment on function public.get_accounting_report_aggregates(date, date, uuid[], text) is
  'Read-only debit and credit totals for accounted journal entries (publicada and reversada). Modes: opening, period, both, as_of.';

drop function if exists public.reverse_journal_entry(uuid);

create or replace function public.reverse_journal_entry(
  target_entry_id uuid,
  p_reversal_reason text,
  actor_ip text default null,
  actor_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_user_id uuid := auth.uid();
  original_entry public.journal_entries%rowtype;
  existing_reversal_id uuid;
  reversal_entry_id uuid;
  reversal_entry_number text;
  reversal_entry_date date := (now() at time zone 'America/Tegucigalpa')::date;
  normalized_reason text := btrim(regexp_replace(coalesce(p_reversal_reason, ''), '\s+', ' ', 'g'));
  reversed_at_value timestamptz := now();
  line_count integer;
  total_debit numeric(14, 2);
  total_credit numeric(14, 2);
  linked_event_id uuid;
begin
  if actor_user_id is null or not public.has_permission('accounting:reverse') then
    raise exception 'No tienes permiso para reversar partidas.' using errcode = '42501';
  end if;

  if char_length(normalized_reason) < 10 or char_length(normalized_reason) > 500 then
    raise exception 'El motivo de la reversión debe tener entre 10 y 500 caracteres.' using errcode = '22023';
  end if;

  select *
  into original_entry
  from public.journal_entries
  where id = target_entry_id
  for update;

  if not found then
    raise exception 'La partida no existe.';
  end if;

  if original_entry.source_type = 'journal_reversal'
     or coalesce(original_entry.metadata->>'entry_kind', '') = 'reversal' then
    raise exception 'Una partida de reversa no puede volver a reversarse.' using errcode = '22023';
  end if;

  if original_entry.status <> 'publicada' then
    raise exception 'Solo se pueden reversar partidas publicadas.';
  end if;

  if original_entry.reversed_entry_id is not null then
    raise exception 'La partida ya fue reversada.';
  end if;

  if public.is_date_in_closed_accounting_period(reversal_entry_date) then
    raise exception 'No se puede crear el reverso dentro de un periodo cerrado.';
  end if;

  select id
  into existing_reversal_id
  from public.journal_entries
  where source_type = 'journal_reversal'
    and source_id = original_entry.id::text
  limit 1;

  if existing_reversal_id is not null then
    raise exception 'La partida ya tiene un asiento de reverso.';
  end if;

  select
    count(*)::integer,
    coalesce(sum(debit), 0)::numeric(14, 2),
    coalesce(sum(credit), 0)::numeric(14, 2)
  into line_count, total_debit, total_credit
  from public.journal_entry_lines
  where journal_entry_id = original_entry.id;

  if line_count < 2 or total_debit <= 0 or total_debit <> total_credit then
    raise exception 'La partida original no está cuadrada y no puede reversarse.';
  end if;

  reversal_entry_number := public.next_journal_entry_number();

  insert into public.journal_entries (
    entry_number,
    entry_date,
    description,
    status,
    source_type,
    source_id,
    created_by,
    updated_by,
    metadata
  )
  values (
    reversal_entry_number,
    reversal_entry_date,
    left(format('Reverso de %s: %s', original_entry.entry_number, original_entry.description), 500),
    'borrador',
    'journal_reversal',
    original_entry.id::text,
    actor_user_id,
    actor_user_id,
    jsonb_build_object(
      'entry_kind', 'reversal',
      'original_entry_id', original_entry.id,
      'reversal_reason', normalized_reason,
      'reversal_actor_id', actor_user_id,
      'reversed_at', reversed_at_value
    )
  )
  returning id into reversal_entry_id;

  insert into public.journal_entry_lines (
    journal_entry_id,
    account_id,
    debit,
    credit,
    description,
    customer_id,
    vendor_id,
    product_id
  )
  select
    reversal_entry_id,
    account_id,
    credit,
    debit,
    coalesce('Reverso: ' || nullif(description, ''), 'Reverso de ' || original_entry.entry_number),
    customer_id,
    vendor_id,
    product_id
  from public.journal_entry_lines
  where journal_entry_id = original_entry.id
  order by created_at, id;

  update public.journal_entries
  set
    status = 'publicada',
    posted_by = actor_user_id,
    posted_at = reversed_at_value,
    updated_by = actor_user_id,
    version = version + 1
  where id = reversal_entry_id;

  update public.journal_entries
  set
    status = 'reversada',
    reversed_entry_id = reversal_entry_id,
    updated_by = actor_user_id,
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'reversal_entry_id', reversal_entry_id,
      'reversal_reason', normalized_reason,
      'reversal_actor_id', actor_user_id,
      'reversed_at', reversed_at_value
    ),
    version = version + 1
  where id = original_entry.id;

  if original_entry.source_type = 'financial_event' then
    begin
      linked_event_id := original_entry.source_id::uuid;
    exception
      when others then linked_event_id := null;
    end;

    if linked_event_id is not null then
      update public.financial_events
      set status = 'reversed', journal_entry_id = original_entry.id, updated_at = now()
      where id = linked_event_id
        and journal_entry_id = original_entry.id;
    end if;
  end if;

  perform public.write_audit_log(
    'journal_entries',
    reversal_entry_id,
    'accounting.journal_reversal.created',
    null,
    jsonb_build_object(
      'status', 'publicada',
      'version', 2,
      'original_entry_id', original_entry.id,
      'original_entry_number', original_entry.entry_number,
      'reversal_reason', normalized_reason,
      'reversal_actor_id', actor_user_id,
      'total_debit', total_debit,
      'total_credit', total_credit
    ),
    actor_ip,
    actor_user_agent
  );

  perform public.write_audit_log(
    'journal_entries',
    original_entry.id,
    'accounting.journal_entry.reversed',
    jsonb_build_object('status', 'publicada', 'version', original_entry.version),
    jsonb_build_object(
      'status', 'reversada',
      'version', original_entry.version + 1,
      'reversal_entry_id', reversal_entry_id,
      'reversal_reason', normalized_reason,
      'reversal_actor_id', actor_user_id,
      'financial_event_id', linked_event_id
    ),
    actor_ip,
    actor_user_agent
  );

  insert into public.accounting_event_log (
    event_type,
    entity_type,
    entity_id,
    source_type,
    source_id,
    metadata,
    created_by
  )
  values
  (
    'journal_reversal.created',
    'journal_entries',
    reversal_entry_id,
    'journal_reversal',
    original_entry.id::text,
    jsonb_build_object(
      'original_entry_id', original_entry.id,
      'reversal_entry_number', reversal_entry_number,
      'reversal_reason', normalized_reason,
      'reversal_actor_id', actor_user_id,
      'total_debit', total_debit,
      'total_credit', total_credit
    ),
    actor_user_id
  ),
  (
    'journal_entry.reversed',
    'journal_entries',
    original_entry.id,
    'journal_reversal',
    reversal_entry_id::text,
    jsonb_build_object(
      'reversal_entry_id', reversal_entry_id,
      'reversal_reason', normalized_reason,
      'reversal_actor_id', actor_user_id,
      'financial_event_id', linked_event_id,
      'previous_status', 'publicada',
      'next_status', 'reversada'
    ),
    actor_user_id
  );

  return jsonb_build_object(
    'ok', true,
    'original_entry_id', original_entry.id,
    'original_version', original_entry.version + 1,
    'reversal_entry_id', reversal_entry_id,
    'reversal_entry_number', reversal_entry_number,
    'reversal_reason', normalized_reason,
    'financial_event_id', linked_event_id
  );
end;
$$;

revoke all on function public.reverse_journal_entry(uuid, text, text, text) from public, anon;
grant execute on function public.reverse_journal_entry(uuid, text, text, text) to authenticated;

comment on function public.reverse_journal_entry(uuid, text, text, text) is
  'Atomically creates and publishes one exact reversal. Requires a reason and rejects reversal entries, duplicate reversals, and non-published entries.';

drop view if exists public.public_catalog_products_v1;

create view public.public_catalog_products_v1
with (security_barrier = true)
as
select
  products.id,
  products.category_id,
  categories.name as category_name,
  categories.slug as category_slug,
  products.sku,
  products.internal_code,
  products.slug,
  products.name,
  products.brand,
  products.vehicle_brand,
  products.vehicle_model,
  products.vehicle_year_start,
  products.vehicle_year_end,
  products.short_description,
  products.description,
  products.features,
  products.specifications,
  products.compatibility_notes,
  products.available_stock,
  products.retail_price,
  products.wholesale_price,
  products.wholesale_min_quantity,
  products.is_new,
  products.updated_at
from public.products
left join public.categories
  on categories.id = products.category_id
where products.active = true
  and products.status = 'active';

comment on view public.public_catalog_products_v1 is
  'Explicit public product DTO. Excludes cost_price, raw stock controls, supplier data, margins, purchase data, and internal audit fields.';

drop view if exists public.public_catalog_product_images_v1;

create view public.public_catalog_product_images_v1
with (security_barrier = true)
as
select
  product_images.id,
  product_images.product_id,
  product_images.public_url,
  product_images.angle,
  product_images.alt_text,
  product_images.sort_order,
  product_images.is_primary
from public.product_images
join public.products
  on products.id = product_images.product_id
where products.active = true
  and products.status = 'active';

comment on view public.public_catalog_product_images_v1 is
  'Explicit public product image DTO for active catalog products. Avoids product-table access through image RLS policies.';

-- These expression indexes match the accent-insensitive search predicates below.
-- pg_trgm already exists from the operational hardening migration.
create index if not exists accounting_accounts_code_normalized_trgm_idx
  on public.accounting_accounts using gin (
    (translate(lower(code), 'áéíóúüñ', 'aeiouun')) extensions.gin_trgm_ops
  );
create index if not exists accounting_accounts_name_normalized_trgm_idx
  on public.accounting_accounts using gin (
    (translate(lower(name), 'áéíóúüñ', 'aeiouun')) extensions.gin_trgm_ops
  );
create index if not exists products_sku_normalized_trgm_idx
  on public.products using gin (
    (translate(lower(sku), 'áéíóúüñ', 'aeiouun')) extensions.gin_trgm_ops
  );
create index if not exists products_internal_code_normalized_trgm_idx
  on public.products using gin (
    (translate(lower(coalesce(internal_code, '')), 'áéíóúüñ', 'aeiouun')) extensions.gin_trgm_ops
  );
create index if not exists products_name_normalized_trgm_idx
  on public.products using gin (
    (translate(lower(name), 'áéíóúüñ', 'aeiouun')) extensions.gin_trgm_ops
  );
create index if not exists products_brand_normalized_trgm_idx
  on public.products using gin (
    (translate(lower(brand), 'áéíóúüñ', 'aeiouun')) extensions.gin_trgm_ops
  );

revoke all on public.public_catalog_products_v1 from public;
grant select on public.public_catalog_products_v1 to anon, authenticated, service_role;

revoke select on public.products from anon, authenticated;

revoke all on public.public_catalog_product_images_v1 from public;
grant select on public.public_catalog_product_images_v1 to anon, authenticated, service_role;

-- Authenticated operational code may still read non-cost product fields through
-- existing RLS. cost_price remains unavailable unless a permission-checked
-- SECURITY DEFINER RPC or trusted server-side service is used.
grant select (
  id,
  category_id,
  sku,
  internal_code,
  slug,
  name,
  brand,
  vehicle_brand,
  vehicle_model,
  vehicle_year_start,
  vehicle_year_end,
  short_description,
  description,
  features,
  specifications,
  compatibility_notes,
  stock,
  low_stock_threshold,
  min_stock,
  retail_price,
  wholesale_price,
  wholesale_min_quantity,
  is_new,
  status,
  active,
  reserved_stock,
  available_stock,
  auto_disabled_by_stock,
  created_at,
  updated_at
) on public.products to authenticated;

grant select on public.products to service_role;

create or replace function public.search_accounting_accounts_v1(
  p_query text default null,
  p_limit integer default 25,
  p_offset integer default 0,
  p_include_inactive boolean default false
)
returns table (
  id uuid,
  code text,
  name text,
  account_type text,
  normal_balance text,
  is_active boolean,
  parent_id uuid,
  is_selectable boolean,
  match_rank integer,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  normalized_query text := translate(
    lower(btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g'))),
    'áéíóúüñ',
    'aeiouun'
  );
  safe_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  safe_offset integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
begin
  if auth.uid() is null or not (
    public.has_permission('accounting:read')
    or public.has_permission('accounting:create')
    or public.has_permission('accounting:edit_draft_entries')
    or public.has_permission('accounting:settings')
    or public.has_permission('accounting:manage')
  ) then
    raise exception 'No tienes permiso para buscar cuentas contables.' using errcode = '42501';
  end if;

  return query
  with ranked as (
    select
      accounts.id,
      accounts.code,
      accounts.name,
      accounts.type as account_type,
      accounts.normal_balance,
      accounts.is_active,
      accounts.parent_id,
      accounts.is_active as is_selectable,
      case
        when normalized_query = '' then 50
        when translate(lower(accounts.code), 'áéíóúüñ', 'aeiouun') = normalized_query then 0
        when translate(lower(accounts.name), 'áéíóúüñ', 'aeiouun') = normalized_query then 1
        when translate(lower(accounts.code), 'áéíóúüñ', 'aeiouun') like normalized_query || '%' then 2
        when translate(lower(accounts.name), 'áéíóúüñ', 'aeiouun') like normalized_query || '%' then 3
        else 4
      end as match_rank
    from public.accounting_accounts as accounts
    where (p_include_inactive or accounts.is_active)
      and (
        normalized_query = ''
        or translate(lower(accounts.code), 'áéíóúüñ', 'aeiouun') like '%' || normalized_query || '%'
        or translate(lower(accounts.name), 'áéíóúüñ', 'aeiouun') like '%' || normalized_query || '%'
      )
  )
  select
    ranked.id,
    ranked.code,
    ranked.name,
    ranked.account_type,
    ranked.normal_balance,
    ranked.is_active,
    ranked.parent_id,
    ranked.is_selectable,
    ranked.match_rank,
    count(*) over() as total_count
  from ranked
  order by ranked.match_rank, ranked.code, ranked.name, ranked.id
  offset safe_offset
  limit safe_limit;
end;
$$;

revoke all on function public.search_accounting_accounts_v1(text, integer, integer, boolean) from public, anon;
grant execute on function public.search_accounting_accounts_v1(text, integer, integer, boolean) to authenticated;

comment on function public.search_accounting_accounts_v1(text, integer, integer, boolean) is
  'Permission-checked, bounded account search ordered by exact, prefix, then partial code/name matches.';

create or replace function public.search_purchase_products_v1(
  p_query text default null,
  p_limit integer default 25,
  p_offset integer default 0,
  p_include_inactive boolean default false
)
returns table (
  id uuid,
  sku text,
  internal_code text,
  name text,
  brand text,
  unit text,
  status text,
  is_active boolean,
  available_stock integer,
  cost_price numeric(12, 2),
  match_rank integer,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  normalized_query text := translate(
    lower(btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g'))),
    'áéíóúüñ',
    'aeiouun'
  );
  safe_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  safe_offset integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
begin
  if auth.uid() is null or not (
    public.has_permission('purchases:read')
    or public.has_permission('purchases:manage')
  ) then
    raise exception 'No tienes permiso para buscar productos de compras.' using errcode = '42501';
  end if;

  return query
  with ranked as (
    select
      products.id,
      products.sku,
      products.internal_code,
      products.name,
      products.brand,
      null::text as unit,
      products.status::text as status,
      products.active as is_active,
      products.available_stock,
      products.cost_price,
      case
        when normalized_query = '' then 50
        when translate(lower(products.sku), 'áéíóúüñ', 'aeiouun') = normalized_query then 0
        when translate(lower(coalesce(products.internal_code, '')), 'áéíóúüñ', 'aeiouun') = normalized_query then 1
        when translate(lower(products.name), 'áéíóúüñ', 'aeiouun') = normalized_query then 2
        when translate(lower(products.sku), 'áéíóúüñ', 'aeiouun') like normalized_query || '%' then 3
        when translate(lower(coalesce(products.internal_code, '')), 'áéíóúüñ', 'aeiouun') like normalized_query || '%' then 4
        when translate(lower(products.name), 'áéíóúüñ', 'aeiouun') like normalized_query || '%' then 5
        when translate(lower(products.brand), 'áéíóúüñ', 'aeiouun') like normalized_query || '%' then 6
        else 7
      end as match_rank
    from public.products
    where (
        p_include_inactive
        or (products.active and products.status = 'active')
      )
      and (
        normalized_query = ''
        or translate(lower(products.sku), 'áéíóúüñ', 'aeiouun') like '%' || normalized_query || '%'
        or translate(lower(coalesce(products.internal_code, '')), 'áéíóúüñ', 'aeiouun') like '%' || normalized_query || '%'
        or translate(lower(products.name), 'áéíóúüñ', 'aeiouun') like '%' || normalized_query || '%'
        or translate(lower(products.brand), 'áéíóúüñ', 'aeiouun') like '%' || normalized_query || '%'
      )
  )
  select
    ranked.id,
    ranked.sku,
    ranked.internal_code,
    ranked.name,
    ranked.brand,
    ranked.unit,
    ranked.status,
    ranked.is_active,
    ranked.available_stock,
    ranked.cost_price,
    ranked.match_rank,
    count(*) over() as total_count
  from ranked
  order by ranked.match_rank, ranked.name, ranked.sku, ranked.id
  offset safe_offset
  limit safe_limit;
end;
$$;

revoke all on function public.search_purchase_products_v1(text, integer, integer, boolean) from public, anon;
grant execute on function public.search_purchase_products_v1(text, integer, integer, boolean) to authenticated;

comment on function public.search_purchase_products_v1(text, integer, integer, boolean) is
  'Purchase-only product search. Cost is returned only after purchases permission is verified inside SQL.';

create or replace function public.search_inventory_products_v1(
  p_query text default null,
  p_limit integer default 25,
  p_offset integer default 0,
  p_include_inactive boolean default false
)
returns table (
  id uuid,
  sku text,
  internal_code text,
  name text,
  brand text,
  category_name text,
  status text,
  is_active boolean,
  stock integer,
  reserved_stock integer,
  available_stock integer,
  min_stock integer,
  auto_disabled_by_stock boolean,
  match_rank integer,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  normalized_query text := translate(
    lower(btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g'))),
    'áéíóúüñ',
    'aeiouun'
  );
  safe_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  safe_offset integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
begin
  if auth.uid() is null or not (
    public.has_permission('inventory:read')
    or public.has_permission('inventory:manage')
  ) then
    raise exception 'No tienes permiso para buscar productos de inventario.' using errcode = '42501';
  end if;

  return query
  with ranked as (
    select
      products.id,
      products.sku,
      products.internal_code,
      products.name,
      products.brand,
      categories.name as category_name,
      products.status::text as status,
      products.active as is_active,
      products.stock,
      products.reserved_stock,
      products.available_stock,
      products.min_stock,
      products.auto_disabled_by_stock,
      case
        when normalized_query = '' then 50
        when translate(lower(products.sku), 'áéíóúüñ', 'aeiouun') = normalized_query then 0
        when translate(lower(coalesce(products.internal_code, '')), 'áéíóúüñ', 'aeiouun') = normalized_query then 1
        when translate(lower(products.name), 'áéíóúüñ', 'aeiouun') = normalized_query then 2
        when translate(lower(products.sku), 'áéíóúüñ', 'aeiouun') like normalized_query || '%' then 3
        when translate(lower(coalesce(products.internal_code, '')), 'áéíóúüñ', 'aeiouun') like normalized_query || '%' then 4
        when translate(lower(products.name), 'áéíóúüñ', 'aeiouun') like normalized_query || '%' then 5
        when translate(lower(products.brand), 'áéíóúüñ', 'aeiouun') like normalized_query || '%' then 6
        else 7
      end as match_rank
    from public.products
    left join public.categories on categories.id = products.category_id
    where (
        p_include_inactive
        or (products.active and products.status = 'active')
      )
      and (
        normalized_query = ''
        or translate(lower(products.sku), 'áéíóúüñ', 'aeiouun') like '%' || normalized_query || '%'
        or translate(lower(coalesce(products.internal_code, '')), 'áéíóúüñ', 'aeiouun') like '%' || normalized_query || '%'
        or translate(lower(products.name), 'áéíóúüñ', 'aeiouun') like '%' || normalized_query || '%'
        or translate(lower(products.brand), 'áéíóúüñ', 'aeiouun') like '%' || normalized_query || '%'
      )
  )
  select
    ranked.id,
    ranked.sku,
    ranked.internal_code,
    ranked.name,
    ranked.brand,
    ranked.category_name,
    ranked.status,
    ranked.is_active,
    ranked.stock,
    ranked.reserved_stock,
    ranked.available_stock,
    ranked.min_stock,
    ranked.auto_disabled_by_stock,
    ranked.match_rank,
    count(*) over() as total_count
  from ranked
  order by ranked.match_rank, ranked.name, ranked.sku, ranked.id
  offset safe_offset
  limit safe_limit;
end;
$$;

revoke all on function public.search_inventory_products_v1(text, integer, integer, boolean) from public, anon;
grant execute on function public.search_inventory_products_v1(text, integer, integer, boolean) to authenticated;

comment on function public.search_inventory_products_v1(text, integer, integer, boolean) is
  'Inventory-only product search with stock fields and no product cost.';
