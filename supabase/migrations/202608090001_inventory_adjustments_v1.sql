-- Inventory adjustments V1: atomic multi-product documents, immutable history and full reversal.
-- Prospective only: this migration never changes product quantities, reservations, costs or accounting entries.

do $$
begin
  if exists (select 1 from public.products where stock < coalesce(reserved_stock, 0)) then
    raise exception using errcode = '23514', message = 'INVENTORY_STOCK_RESERVATION_PRECHECK_FAILED';
  end if;
end;
$$;

alter table public.products
  drop constraint if exists products_stock_not_below_reserved_stock,
  add constraint products_stock_not_below_reserved_stock
  check (stock >= reserved_stock);

revoke truncate on public.inventory_movements from anon, authenticated;

alter table public.inventory_movements
  add column if not exists reserved_before integer,
  add column if not exists reserved_after integer,
  add column if not exists available_before integer,
  add column if not exists available_after integer,
  add column if not exists effective_date date;

create sequence if not exists public.inventory_adjustment_number_seq;
revoke all on sequence public.inventory_adjustment_number_seq from public, anon, authenticated;
grant usage, select on sequence public.inventory_adjustment_number_seq to service_role;

create table public.inventory_adjustments (
  id uuid primary key default gen_random_uuid(),
  adjustment_number text not null unique,
  status text not null default 'draft' check (status in ('draft', 'confirmed', 'cancelled', 'reversed')),
  request_key uuid not null unique,
  version integer not null default 1 check (version > 0),
  effective_date date not null,
  reference text,
  notes text,
  created_by uuid not null references public.users(id) on delete restrict,
  confirmed_by uuid references public.users(id) on delete restrict,
  cancelled_by uuid references public.users(id) on delete restrict,
  reversed_by uuid references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  reversed_at timestamptz,
  reversal_of_id uuid references public.inventory_adjustments(id) on delete restrict,
  accounting_status text not null default 'not_required' check (
    accounting_status in ('not_required', 'pending_mapping', 'blocked_invalid_cost', 'ready_for_draft', 'draft_created', 'posted', 'reversal_pending', 'reversed')
  ),
  constraint inventory_adjustments_reference_length check (reference is null or char_length(reference) <= 160),
  constraint inventory_adjustments_notes_length check (notes is null or char_length(notes) <= 2000),
  constraint inventory_adjustments_state_shape check (
    (status = 'draft' and confirmed_at is null and cancelled_at is null)
    or (status = 'cancelled' and confirmed_at is null and cancelled_at is not null)
    or (status = 'confirmed' and confirmed_at is not null and cancelled_at is null)
    or (status = 'reversed' and confirmed_at is not null and reversed_at is not null and cancelled_at is null)
  )
);

create unique index inventory_adjustments_reversal_once_idx
  on public.inventory_adjustments(reversal_of_id) where reversal_of_id is not null;
create index inventory_adjustments_effective_date_idx on public.inventory_adjustments(effective_date desc);
create index inventory_adjustments_status_created_idx on public.inventory_adjustments(status, created_at desc);
create index inventory_adjustments_created_by_idx on public.inventory_adjustments(created_by, created_at desc);

create table public.inventory_adjustment_lines (
  id uuid primary key default gen_random_uuid(),
  adjustment_id uuid not null references public.inventory_adjustments(id) on delete restrict,
  product_id uuid not null references public.products(id) on delete restrict,
  direction text not null check (direction in ('increase', 'decrease')),
  quantity integer not null check (quantity between 1 and 1000000),
  reason_code text not null check (reason_code in (
    'physical_count_surplus', 'recovery', 'physical_count_shortage',
    'damage_or_shrinkage', 'loss', 'operational_error', 'other'
  )),
  reason_detail text,
  unit_cost_override numeric(12,2),
  expected_stock integer not null check (expected_stock >= 0),
  expected_reserved_stock integer not null check (expected_reserved_stock >= 0),
  expected_available_stock integer not null check (expected_available_stock >= 0),
  product_sku_snapshot text,
  product_name_snapshot text,
  stock_before integer,
  reserved_before integer,
  available_before integer,
  stock_after integer,
  reserved_after integer,
  available_after integer,
  unit_cost_snapshot numeric(12,2),
  total_cost_snapshot numeric(14,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (adjustment_id, product_id),
  constraint inventory_adjustment_lines_reason_detail_length check (reason_detail is null or char_length(reason_detail) <= 240),
  constraint inventory_adjustment_lines_other_detail check (reason_code <> 'other' or char_length(trim(coalesce(reason_detail, ''))) > 0),
  constraint inventory_adjustment_lines_direction_reason check (
    (direction = 'increase' and reason_code in ('physical_count_surplus', 'recovery', 'operational_error', 'other'))
    or (direction = 'decrease' and reason_code in ('physical_count_shortage', 'damage_or_shrinkage', 'loss', 'operational_error', 'other'))
  ),
  constraint inventory_adjustment_lines_override_cost check (unit_cost_override is null or unit_cost_override > 0)
);

create index inventory_adjustment_lines_adjustment_idx on public.inventory_adjustment_lines(adjustment_id);
create index inventory_adjustment_lines_product_idx on public.inventory_adjustment_lines(product_id);

alter table public.inventory_adjustments enable row level security;
alter table public.inventory_adjustment_lines enable row level security;
revoke all on public.inventory_adjustments, public.inventory_adjustment_lines from public, anon, authenticated;
grant select, insert, update, delete on public.inventory_adjustments, public.inventory_adjustment_lines to service_role;

create policy "Authorized inventory adjustment readers"
  on public.inventory_adjustments for select
  using (public.has_permission('inventory:adjust_read'));
create policy "Authorized inventory adjustment line readers"
  on public.inventory_adjustment_lines for select
  using (public.has_permission('inventory:adjust_read'));

update public.roles
set permissions = (
  select jsonb_agg(permission order by permission)
  from (
    select distinct permission
    from jsonb_array_elements_text(
      coalesce(public.roles.permissions, '[]'::jsonb)
      || '["inventory:adjust_read","inventory:adjust_create","inventory:adjust_confirm"]'::jsonb
      || case when name in ('technical_owner','business_owner','admin') then '["inventory:adjust_reverse"]'::jsonb else '[]'::jsonb end
      || case when name in ('technical_owner','business_owner','admin','contadora') then '["inventory:cost_read"]'::jsonb else '[]'::jsonb end
    ) expanded(permission)
  ) deduplicated
), updated_at = now()
where name in ('technical_owner','business_owner','admin','bodega','contadora');

create or replace function public.inventory_adjustment_number_v1(p_date date)
returns text
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  select 'AJ-' || to_char(p_date, 'YYYYMMDD') || '-' || lpad(nextval('public.inventory_adjustment_number_seq')::text, 6, '0');
$$;

create or replace function public.inventory_adjustment_authorized_v1(p_permission text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role() = 'service_role', false) or public.has_permission(p_permission);
$$;

create or replace function public.guard_inventory_adjustment_header_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_setting('app.inventory_adjustment_internal', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'INVENTORY_ADJUSTMENT_IMMUTABLE';
  end if;
  if old.status <> 'draft' or new.status <> 'draft' then
    raise exception using errcode = '42501', message = 'INVENTORY_ADJUSTMENT_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger inventory_adjustments_immutable_guard
before update or delete on public.inventory_adjustments
for each row execute function public.guard_inventory_adjustment_header_v1();

create or replace function public.guard_inventory_adjustment_line_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare parent_status text;
begin
  if current_setting('app.inventory_adjustment_internal', true) = 'on' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  select status into parent_status from public.inventory_adjustments where id = coalesce(new.adjustment_id, old.adjustment_id);
  if parent_status <> 'draft' then
    raise exception using errcode = '42501', message = 'INVENTORY_ADJUSTMENT_IMMUTABLE';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger inventory_adjustment_lines_immutable_guard
before update or delete on public.inventory_adjustment_lines
for each row execute function public.guard_inventory_adjustment_line_v1();

create or replace function public.guard_inventory_adjustment_movement_v1()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if old.reference_type = 'inventory_adjustment' then
    raise exception using errcode = '42501', message = 'INVENTORY_ADJUSTMENT_MOVEMENT_IMMUTABLE';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger inventory_adjustment_movements_append_only
before update or delete on public.inventory_movements
for each row execute function public.guard_inventory_adjustment_movement_v1();

create or replace function public.replace_inventory_adjustment_lines_v1(p_adjustment_id uuid, p_lines jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare item jsonb; product_row public.products%rowtype; actor_can_cost boolean;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVENTORY_ADJUSTMENT_INVALID_LINES';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_lines) x
    where jsonb_typeof(x) <> 'object'
      or nullif(x->>'product_id','') is null
      or (x->>'product_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or x->>'direction' not in ('increase','decrease')
      or coalesce(x->>'quantity','') !~ '^[0-9]+$'
      or (x->>'quantity')::numeric not between 1 and 1000000
  ) then raise exception using errcode = '22023', message = 'INVENTORY_ADJUSTMENT_INVALID_LINES'; end if;
  if (select count(*) from jsonb_array_elements(p_lines)) <>
     (select count(distinct (x->>'product_id')::uuid) from jsonb_array_elements(p_lines) x) then
    raise exception using errcode = '23505', message = 'INVENTORY_ADJUSTMENT_DUPLICATE_PRODUCT';
  end if;
  actor_can_cost := public.inventory_adjustment_authorized_v1('inventory:cost_read');
  perform set_config('app.inventory_adjustment_internal', 'on', true);
  delete from public.inventory_adjustment_lines where adjustment_id = p_adjustment_id;
  for item in select value from jsonb_array_elements(p_lines) order by (value->>'product_id')::uuid loop
    select * into product_row from public.products where id = (item->>'product_id')::uuid;
    if not found then raise exception using errcode = 'P0002', message = 'INVENTORY_ADJUSTMENT_PRODUCT_NOT_FOUND'; end if;
    if item->>'reason_code' is null or not (
      (item->>'direction' = 'increase' and item->>'reason_code' in ('physical_count_surplus','recovery','operational_error','other'))
      or (item->>'direction' = 'decrease' and item->>'reason_code' in ('physical_count_shortage','damage_or_shrinkage','loss','operational_error','other'))
    ) then raise exception using errcode = '22023', message = 'INVENTORY_ADJUSTMENT_INVALID_REASON'; end if;
    if item->>'reason_code' = 'other' and char_length(trim(coalesce(item->>'reason_detail',''))) = 0 then
      raise exception using errcode = '22023', message = 'INVENTORY_ADJUSTMENT_REASON_DETAIL_REQUIRED';
    end if;
    if char_length(trim(coalesce(item->>'reason_detail',''))) > 240 then
      raise exception using errcode = '22023', message = 'INVENTORY_ADJUSTMENT_REASON_DETAIL_TOO_LONG';
    end if;
    if item ? 'unit_cost' and nullif(item->>'unit_cost','') is not null and not actor_can_cost then
      raise exception using errcode = '42501', message = 'INVENTORY_ADJUSTMENT_COST_FORBIDDEN';
    end if;
    if item->>'direction' = 'decrease' and nullif(item->>'unit_cost','') is not null then
      raise exception using errcode = '22023', message = 'INVENTORY_ADJUSTMENT_DECREASE_COST_SERVER_ONLY';
    end if;
    insert into public.inventory_adjustment_lines(
      adjustment_id, product_id, direction, quantity, reason_code, reason_detail, unit_cost_override,
      expected_stock, expected_reserved_stock, expected_available_stock
    ) values (
      p_adjustment_id, product_row.id, item->>'direction', (item->>'quantity')::integer, item->>'reason_code',
      nullif(left(trim(coalesce(item->>'reason_detail','')),240),''),
      case when item->>'direction'='increase' and nullif(item->>'unit_cost','') is not null then round((item->>'unit_cost')::numeric,2) else null end,
      product_row.stock, product_row.reserved_stock, product_row.available_stock
    );
  end loop;
  perform set_config('app.inventory_adjustment_internal', 'off', true);
end;
$$;

create or replace function public.create_inventory_adjustment_v1(
  p_request_key uuid, p_effective_date date, p_reference text, p_notes text, p_lines jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare actor_id uuid := auth.uid(); existing_id uuid; existing_actor_id uuid; next_id uuid := gen_random_uuid(); today_hn date := (now() at time zone 'America/Tegucigalpa')::date;
begin
  if actor_id is null or not public.inventory_adjustment_authorized_v1('inventory:adjust_create') then
    raise exception using errcode = '42501', message = 'INVENTORY_ADJUSTMENT_FORBIDDEN';
  end if;
  select id, created_by into existing_id, existing_actor_id from public.inventory_adjustments where request_key = p_request_key;
  if found then
    if existing_actor_id <> actor_id then raise exception using errcode='42501',message='INVENTORY_ADJUSTMENT_IDEMPOTENCY_FORBIDDEN'; end if;
    return existing_id;
  end if;
  if coalesce(p_effective_date,today_hn) <> today_hn then raise exception using errcode='22023', message='INVENTORY_ADJUSTMENT_EFFECTIVE_DATE_NOT_ALLOWED'; end if;
  if char_length(trim(coalesce(p_reference,''))) > 160 or char_length(trim(coalesce(p_notes,''))) > 2000 then
    raise exception using errcode='22023', message='INVENTORY_ADJUSTMENT_TEXT_TOO_LONG';
  end if;
  perform set_config('app.inventory_adjustment_internal', 'on', true);
  insert into public.inventory_adjustments(id, adjustment_number, request_key, effective_date, reference, notes, created_by)
  values(next_id, public.inventory_adjustment_number_v1(today_hn), p_request_key, today_hn,
    nullif(trim(coalesce(p_reference,'')),''), nullif(trim(coalesce(p_notes,'')),''), actor_id);
  perform public.replace_inventory_adjustment_lines_v1(next_id, p_lines);
  perform set_config('app.inventory_adjustment_internal', 'off', true);
  insert into public.audit_logs(user_id,actor_role,table_name,record_id,action,new_data)
  values(actor_id,public.current_actor_role(),'inventory_adjustments',next_id,'inventory.adjustment.created',
    jsonb_build_object('adjustment_id',next_id,'line_count',jsonb_array_length(p_lines),'effective_date',today_hn,'request_key',p_request_key));
  return next_id;
end;
$$;

create or replace function public.update_inventory_adjustment_draft_v1(
  p_adjustment_id uuid, p_expected_version integer, p_effective_date date, p_reference text, p_notes text, p_lines jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare actor_id uuid:=auth.uid(); row_value public.inventory_adjustments%rowtype; today_hn date := (now() at time zone 'America/Tegucigalpa')::date;
begin
  if actor_id is null or not public.inventory_adjustment_authorized_v1('inventory:adjust_create') then raise exception using errcode='42501',message='INVENTORY_ADJUSTMENT_FORBIDDEN'; end if;
  select * into row_value from public.inventory_adjustments where id=p_adjustment_id for update;
  if not found then raise exception using errcode='P0002',message='INVENTORY_ADJUSTMENT_NOT_FOUND'; end if;
  if row_value.status <> 'draft' then raise exception using errcode='55000',message='INVENTORY_ADJUSTMENT_IMMUTABLE'; end if;
  if row_value.version <> p_expected_version then raise exception using errcode='PT409',message='INVENTORY_ADJUSTMENT_VERSION_CONFLICT'; end if;
  if coalesce(p_effective_date,today_hn) <> today_hn then raise exception using errcode='22023',message='INVENTORY_ADJUSTMENT_EFFECTIVE_DATE_NOT_ALLOWED'; end if;
  if char_length(trim(coalesce(p_reference,''))) > 160 or char_length(trim(coalesce(p_notes,''))) > 2000 then raise exception using errcode='22023',message='INVENTORY_ADJUSTMENT_TEXT_TOO_LONG'; end if;
  perform set_config('app.inventory_adjustment_internal','on',true);
  update public.inventory_adjustments set effective_date=today_hn,reference=nullif(trim(coalesce(p_reference,'')),''),notes=nullif(trim(coalesce(p_notes,'')),''),version=version+1,updated_at=now() where id=p_adjustment_id;
  perform public.replace_inventory_adjustment_lines_v1(p_adjustment_id,p_lines);
  perform set_config('app.inventory_adjustment_internal','off',true);
  insert into public.audit_logs(user_id,actor_role,table_name,record_id,action,new_data)
  values(actor_id,public.current_actor_role(),'inventory_adjustments',p_adjustment_id,'inventory.adjustment.updated',jsonb_build_object('version',p_expected_version+1,'line_count',jsonb_array_length(p_lines)));
  return p_expected_version+1;
end;
$$;

create or replace function public.cancel_inventory_adjustment_v1(p_adjustment_id uuid, p_expected_version integer)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare actor_id uuid:=auth.uid(); row_value public.inventory_adjustments%rowtype;
begin
  if actor_id is null or not public.inventory_adjustment_authorized_v1('inventory:adjust_create') then raise exception using errcode='42501',message='INVENTORY_ADJUSTMENT_FORBIDDEN'; end if;
  select * into row_value from public.inventory_adjustments where id=p_adjustment_id for update;
  if not found then raise exception using errcode='P0002',message='INVENTORY_ADJUSTMENT_NOT_FOUND'; end if;
  if row_value.status <> 'draft' then raise exception using errcode='55000',message='INVENTORY_ADJUSTMENT_IMMUTABLE'; end if;
  if row_value.version <> p_expected_version then raise exception using errcode='PT409',message='INVENTORY_ADJUSTMENT_VERSION_CONFLICT'; end if;
  perform set_config('app.inventory_adjustment_internal','on',true);
  update public.inventory_adjustments set status='cancelled',cancelled_by=actor_id,cancelled_at=now(),version=version+1,updated_at=now() where id=p_adjustment_id;
  perform set_config('app.inventory_adjustment_internal','off',true);
  insert into public.audit_logs(user_id,actor_role,table_name,record_id,action,new_data)
  values(actor_id,public.current_actor_role(),'inventory_adjustments',p_adjustment_id,'inventory.adjustment.cancelled',jsonb_build_object('adjustment_number',row_value.adjustment_number));
end;
$$;

create or replace function public.confirm_inventory_adjustment_v1(
  p_adjustment_id uuid, p_expected_version integer, p_request_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid:=auth.uid(); header public.inventory_adjustments%rowtype; line_row record; product_row record;
  stock_after_value integer; delta_value integer; unit_cost_value numeric(12,2); movement_id uuid;
  line_count integer; today_hn date := (now() at time zone 'America/Tegucigalpa')::date;
begin
  if actor_id is null or not public.inventory_adjustment_authorized_v1('inventory:adjust_confirm') then
    raise exception using errcode='42501',message='INVENTORY_ADJUSTMENT_FORBIDDEN';
  end if;
  select * into header from public.inventory_adjustments where id=p_adjustment_id for update;
  if not found then raise exception using errcode='P0002',message='INVENTORY_ADJUSTMENT_NOT_FOUND'; end if;
  if header.request_key <> p_request_key then raise exception using errcode='22023',message='INVENTORY_ADJUSTMENT_REQUEST_KEY_MISMATCH'; end if;
  if header.status in ('confirmed','reversed') then return header.id; end if;
  if header.status <> 'draft' then raise exception using errcode='55000',message='INVENTORY_ADJUSTMENT_NOT_CONFIRMABLE'; end if;
  if header.version <> p_expected_version then raise exception using errcode='PT409',message='INVENTORY_ADJUSTMENT_VERSION_CONFLICT'; end if;
  if header.effective_date <> today_hn then raise exception using errcode='22023',message='INVENTORY_ADJUSTMENT_EFFECTIVE_DATE_NOT_ALLOWED'; end if;
  if exists (select 1 from public.accounting_periods ap where header.effective_date between ap.start_date and ap.end_date and ap.status='closed') then
    raise exception using errcode='55000',message='INVENTORY_ADJUSTMENT_CLOSED_PERIOD';
  end if;
  select count(*) into line_count from public.inventory_adjustment_lines where adjustment_id=header.id;
  if line_count not between 1 and 100 then raise exception using errcode='22023',message='INVENTORY_ADJUSTMENT_INVALID_LINES'; end if;

  -- PostgreSQL acquires every product row lock in UUID order, matching POS, Checkout and Purchases.
  perform p.id
  from public.products p join public.inventory_adjustment_lines l on l.product_id=p.id
  where l.adjustment_id=header.id order by p.id for update of p;
  if (select count(*) from public.products p join public.inventory_adjustment_lines l on l.product_id=p.id where l.adjustment_id=header.id) <> line_count then
    raise exception using errcode='P0002',message='INVENTORY_ADJUSTMENT_PRODUCT_NOT_FOUND';
  end if;

  perform set_config('app.inventory_adjustment_internal','on',true);
  for line_row in select * from public.inventory_adjustment_lines where adjustment_id=header.id order by product_id loop
    select id,sku,name,stock,reserved_stock,available_stock,active,cost_price into product_row
    from public.products where id=line_row.product_id;
    if product_row.stock <> line_row.expected_stock or product_row.reserved_stock <> line_row.expected_reserved_stock then
      raise exception using errcode='PT409',message='INVENTORY_ADJUSTMENT_STOCK_CONFLICT';
    end if;
    delta_value := case when line_row.direction='increase' then line_row.quantity else -line_row.quantity end;
    stock_after_value := product_row.stock + delta_value;
    if stock_after_value < product_row.reserved_stock then
      raise exception using errcode='23514',message='INVENTORY_ADJUSTMENT_RESERVED_STOCK_CONFLICT';
    end if;
    unit_cost_value := round(case when line_row.direction='increase' then coalesce(line_row.unit_cost_override,product_row.cost_price) else product_row.cost_price end,2);
    if unit_cost_value is null or unit_cost_value <= 0 then
      raise exception using errcode='23514',message='INVENTORY_ADJUSTMENT_INVALID_COST';
    end if;
    update public.inventory_adjustment_lines set
      product_sku_snapshot=product_row.sku,product_name_snapshot=product_row.name,
      stock_before=product_row.stock,reserved_before=product_row.reserved_stock,available_before=product_row.available_stock,
      stock_after=stock_after_value,reserved_after=product_row.reserved_stock,
      available_after=greatest(stock_after_value-product_row.reserved_stock,0),
      unit_cost_snapshot=unit_cost_value,total_cost_snapshot=round(line_row.quantity*unit_cost_value,2),updated_at=now()
    where id=line_row.id;
    update public.products set stock=stock_after_value,updated_at=now() where id=product_row.id;
    insert into public.inventory_movements(
      product_id,user_id,movement_type,quantity,stock_before,stock_after,reference_type,reference_id,
      unit_cost_snapshot,total_cost_snapshot,cost_source,cost_captured_at,notes,
      reserved_before,reserved_after,available_before,available_after,effective_date
    ) values(
      product_row.id,actor_id,'adjustment',delta_value,product_row.stock,stock_after_value,'inventory_adjustment',header.id,
      unit_cost_value,round(line_row.quantity*unit_cost_value,2),'inventory_adjustment_snapshot',now(),
      left('Ajuste '||header.adjustment_number||' - '||line_row.reason_code,500),
      product_row.reserved_stock,product_row.reserved_stock,product_row.available_stock,greatest(stock_after_value-product_row.reserved_stock,0),header.effective_date
    ) returning id into movement_id;
  end loop;
  update public.inventory_adjustments set status='confirmed',confirmed_by=actor_id,confirmed_at=now(),
    accounting_status='pending_mapping',version=version+1,updated_at=now() where id=header.id;
  perform set_config('app.inventory_adjustment_internal','off',true);
  insert into public.audit_logs(user_id,actor_role,table_name,record_id,action,new_data)
  select actor_id,public.current_actor_role(),'inventory_adjustments',header.id,'inventory.adjustment.confirmed',
    jsonb_build_object('adjustment_id',header.id,'adjustment_number',header.adjustment_number,'line_count',line_count,
      'effective_date',header.effective_date,'request_key',header.request_key,'reasons',
      (select jsonb_agg(distinct reason_code) from public.inventory_adjustment_lines where adjustment_id=header.id),'accounting_status','pending_mapping');
  return header.id;
end;
$$;

create or replace function public.reverse_inventory_adjustment_v1(p_adjustment_id uuid, p_request_key uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid:=auth.uid(); original public.inventory_adjustments%rowtype; existing_id uuid; reversal_id uuid:=gen_random_uuid();
  reversal_number text; line_row record; product_row record; delta_value integer; stock_after_value integer; movement_id uuid;
  today_hn date := (now() at time zone 'America/Tegucigalpa')::date;
begin
  if actor_id is null or not public.inventory_adjustment_authorized_v1('inventory:adjust_reverse') then raise exception using errcode='42501',message='INVENTORY_ADJUSTMENT_REVERSE_FORBIDDEN'; end if;
  select id into existing_id from public.inventory_adjustments where request_key=p_request_key and reversal_of_id=p_adjustment_id;
  if found then return existing_id; end if;
  select * into original from public.inventory_adjustments where id=p_adjustment_id for update;
  if not found then raise exception using errcode='P0002',message='INVENTORY_ADJUSTMENT_NOT_FOUND'; end if;
  if original.status='reversed' then
    select id into existing_id from public.inventory_adjustments where reversal_of_id=original.id;
    if found then return existing_id; end if;
  end if;
  if original.status <> 'confirmed' or original.reversal_of_id is not null then raise exception using errcode='55000',message='INVENTORY_ADJUSTMENT_NOT_REVERSIBLE'; end if;
  if exists (select 1 from public.accounting_periods ap where today_hn between ap.start_date and ap.end_date and ap.status='closed') then
    raise exception using errcode='55000',message='INVENTORY_ADJUSTMENT_CLOSED_PERIOD';
  end if;
  perform p.id from public.products p join public.inventory_adjustment_lines l on l.product_id=p.id
    where l.adjustment_id=original.id order by p.id for update of p;
  perform set_config('app.inventory_adjustment_internal','on',true);
  reversal_number:=public.inventory_adjustment_number_v1(today_hn);
  insert into public.inventory_adjustments(id,adjustment_number,status,request_key,version,effective_date,reference,notes,created_by,
    confirmed_by,created_at,updated_at,confirmed_at,reversal_of_id,accounting_status)
  values(reversal_id,reversal_number,'confirmed',p_request_key,1,today_hn,'Reversión de '||original.adjustment_number,
    'Reversión completa e inmutable.',actor_id,actor_id,now(),now(),now(),original.id,'pending_mapping');
  for line_row in select * from public.inventory_adjustment_lines where adjustment_id=original.id order by product_id loop
    select id,sku,name,stock,reserved_stock,available_stock,cost_price into product_row from public.products where id=line_row.product_id;
    delta_value:=case when line_row.direction='increase' then -line_row.quantity else line_row.quantity end;
    stock_after_value:=product_row.stock+delta_value;
    if stock_after_value < product_row.reserved_stock then raise exception using errcode='23514',message='INVENTORY_ADJUSTMENT_REVERSAL_RESERVED_CONFLICT'; end if;
    insert into public.inventory_adjustment_lines(
      adjustment_id,product_id,direction,quantity,reason_code,reason_detail,
      expected_stock,expected_reserved_stock,expected_available_stock,product_sku_snapshot,product_name_snapshot,
      stock_before,reserved_before,available_before,stock_after,reserved_after,available_after,unit_cost_snapshot,total_cost_snapshot
    ) values(
      reversal_id,product_row.id,case when line_row.direction='increase' then 'decrease' else 'increase' end,line_row.quantity,
      'operational_error','Reversión de '||original.adjustment_number,
      product_row.stock,product_row.reserved_stock,product_row.available_stock,line_row.product_sku_snapshot,line_row.product_name_snapshot,
      product_row.stock,product_row.reserved_stock,product_row.available_stock,stock_after_value,product_row.reserved_stock,
      greatest(stock_after_value-product_row.reserved_stock,0),line_row.unit_cost_snapshot,line_row.total_cost_snapshot
    );
    update public.products set stock=stock_after_value,updated_at=now() where id=product_row.id;
    insert into public.inventory_movements(
      product_id,user_id,movement_type,quantity,stock_before,stock_after,reference_type,reference_id,
      unit_cost_snapshot,total_cost_snapshot,cost_source,cost_captured_at,notes,
      reserved_before,reserved_after,available_before,available_after,effective_date
    ) values(
      product_row.id,actor_id,'adjustment',delta_value,product_row.stock,stock_after_value,'inventory_adjustment',reversal_id,
      line_row.unit_cost_snapshot,line_row.total_cost_snapshot,'inventory_adjustment_reversal_snapshot',now(),
      left('Reversión '||reversal_number||' de '||original.adjustment_number,500),product_row.reserved_stock,product_row.reserved_stock,
      product_row.available_stock,greatest(stock_after_value-product_row.reserved_stock,0),today_hn
    ) returning id into movement_id;
  end loop;
  update public.inventory_adjustments set status='reversed',reversed_by=actor_id,reversed_at=now(),
    accounting_status=case when accounting_status='pending_mapping' then 'reversal_pending' else accounting_status end,
    version=version+1,updated_at=now() where id=original.id;
  perform set_config('app.inventory_adjustment_internal','off',true);
  insert into public.audit_logs(user_id,actor_role,table_name,record_id,action,old_data,new_data)
  values(actor_id,public.current_actor_role(),'inventory_adjustments',original.id,'inventory.adjustment.reversed',
    jsonb_build_object('status','confirmed','adjustment_number',original.adjustment_number),
    jsonb_build_object('status','reversed','reversal_id',reversal_id,'reversal_number',reversal_number,'request_key',p_request_key));
  return reversal_id;
end;
$$;

create or replace function public.search_inventory_adjustment_products_v1(p_query text default null, p_limit integer default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare can_cost boolean;
begin
  if not public.inventory_adjustment_authorized_v1('inventory:adjust_read') then raise exception using errcode='42501',message='INVENTORY_ADJUSTMENT_FORBIDDEN'; end if;
  can_cost:=public.inventory_adjustment_authorized_v1('inventory:cost_read');
  return coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id',p.id,'sku',p.sku,'internal_code',p.internal_code,'name',p.name,'brand',p.brand,'active',p.active,'status',p.status,
    'stock',p.stock,'reserved_stock',p.reserved_stock,'available_stock',p.available_stock,
    'cost_price',case when can_cost then p.cost_price else null end
  )) order by p.name,p.id)
  from (select * from public.products where coalesce(trim(p_query),'')='' or sku ilike '%'||trim(p_query)||'%' or
    coalesce(internal_code,'') ilike '%'||trim(p_query)||'%' or name ilike '%'||trim(p_query)||'%' or brand ilike '%'||trim(p_query)||'%'
    order by name,id limit least(greatest(coalesce(p_limit,25),1),25)) p),'[]'::jsonb);
end;
$$;

create or replace function public.get_inventory_adjustment_v1(p_adjustment_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare can_cost boolean; result jsonb;
begin
  if not public.inventory_adjustment_authorized_v1('inventory:adjust_read') then raise exception using errcode='42501',message='INVENTORY_ADJUSTMENT_FORBIDDEN'; end if;
  can_cost:=public.inventory_adjustment_authorized_v1('inventory:cost_read');
  select jsonb_strip_nulls(jsonb_build_object(
    'id',a.id,'adjustment_number',a.adjustment_number,'status',a.status,'request_key',a.request_key,'version',a.version,
    'effective_date',a.effective_date,'reference',a.reference,'notes',a.notes,'accounting_status',a.accounting_status,
    'created_at',a.created_at,'confirmed_at',a.confirmed_at,'cancelled_at',a.cancelled_at,'reversed_at',a.reversed_at,
    'reversal_of_id',a.reversal_of_id,'created_by',a.created_by,'created_by_name',coalesce(u.full_name,u.email),
    'total_cost',case when can_cost then (select coalesce(sum(l.total_cost_snapshot),0) from public.inventory_adjustment_lines l where l.adjustment_id=a.id) else null end,
    'lines',(select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'id',l.id,'product_id',l.product_id,'direction',l.direction,'quantity',l.quantity,'reason_code',l.reason_code,'reason_detail',l.reason_detail,
      'product_sku_snapshot',coalesce(l.product_sku_snapshot,p.sku),'product_name_snapshot',coalesce(l.product_name_snapshot,p.name),
      'stock_before',coalesce(l.stock_before,l.expected_stock),'reserved_before',coalesce(l.reserved_before,l.expected_reserved_stock),
      'available_before',coalesce(l.available_before,l.expected_available_stock),'stock_after',l.stock_after,'reserved_after',l.reserved_after,
      'available_after',l.available_after,'active',p.active,
      'unit_cost_snapshot',case when can_cost then coalesce(l.unit_cost_snapshot,l.unit_cost_override,p.cost_price) else null end,
      'total_cost_snapshot',case when can_cost then l.total_cost_snapshot else null end
    )) order by coalesce(l.product_name_snapshot,p.name),l.id),'[]'::jsonb)
      from public.inventory_adjustment_lines l join public.products p on p.id=l.product_id where l.adjustment_id=a.id)
  )) into result
  from public.inventory_adjustments a left join public.users u on u.id=a.created_by where a.id=p_adjustment_id;
  if result is null then raise exception using errcode='P0002',message='INVENTORY_ADJUSTMENT_NOT_FOUND'; end if;
  return result;
end;
$$;

create or replace function public.list_inventory_adjustments_v1(
  p_query text default null, p_status text default null, p_from date default null, p_to date default null,
  p_limit integer default 50, p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare can_cost boolean; result jsonb;
begin
  if not public.inventory_adjustment_authorized_v1('inventory:adjust_read') then raise exception using errcode='42501',message='INVENTORY_ADJUSTMENT_FORBIDDEN'; end if;
  can_cost:=public.inventory_adjustment_authorized_v1('inventory:cost_read');
  with filtered as (
    select a.*,coalesce(u.full_name,u.email,'Usuario') actor_name,
      count(l.id)::integer line_count,
      sum(case when l.direction='increase' then l.quantity else 0 end)::integer increase_quantity,
      sum(case when l.direction='decrease' then l.quantity else 0 end)::integer decrease_quantity,
      sum(coalesce(l.total_cost_snapshot,0)) total_cost
    from public.inventory_adjustments a left join public.users u on u.id=a.created_by
    left join public.inventory_adjustment_lines l on l.adjustment_id=a.id
    where (coalesce(trim(p_query),'')='' or a.adjustment_number ilike '%'||trim(p_query)||'%' or coalesce(a.reference,'') ilike '%'||trim(p_query)||'%' or coalesce(u.full_name,u.email,'') ilike '%'||trim(p_query)||'%')
      and (p_status is null or a.status=p_status) and (p_from is null or a.effective_date>=p_from) and (p_to is null or a.effective_date<=p_to)
    group by a.id,u.full_name,u.email
  ), page_rows as (select * from filtered order by created_at desc,id desc limit least(greatest(coalesce(p_limit,50),1),100) offset greatest(coalesce(p_offset,0),0))
  select jsonb_build_object('total',(select count(*) from filtered),'items',coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id',id,'adjustment_number',adjustment_number,'status',status,'version',version,'effective_date',effective_date,'reference',reference,
    'created_at',created_at,'confirmed_at',confirmed_at,'actor_name',actor_name,'line_count',line_count,
    'type',case when increase_quantity>0 and decrease_quantity>0 then 'mixed' when increase_quantity>0 then 'increase' else 'decrease' end,
    'increase_quantity',increase_quantity,'decrease_quantity',decrease_quantity,'accounting_status',accounting_status,
    'total_cost',case when can_cost then total_cost else null end,'reversal_of_id',reversal_of_id
  )) order by created_at desc,id desc) from page_rows),'[]'::jsonb)) into result;
  return result;
end;
$$;

revoke all on function public.inventory_adjustment_number_v1(date) from public, anon, authenticated;
revoke all on function public.inventory_adjustment_authorized_v1(text) from public, anon, authenticated;
revoke all on function public.replace_inventory_adjustment_lines_v1(uuid,jsonb) from public, anon, authenticated;
revoke all on function public.create_inventory_adjustment_v1(uuid,date,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.update_inventory_adjustment_draft_v1(uuid,integer,date,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.cancel_inventory_adjustment_v1(uuid,integer) from public, anon, authenticated;
revoke all on function public.confirm_inventory_adjustment_v1(uuid,integer,uuid) from public, anon, authenticated;
revoke all on function public.reverse_inventory_adjustment_v1(uuid,uuid) from public, anon, authenticated;
revoke all on function public.search_inventory_adjustment_products_v1(text,integer) from public, anon, authenticated;
revoke all on function public.get_inventory_adjustment_v1(uuid) from public, anon, authenticated;
revoke all on function public.list_inventory_adjustments_v1(text,text,date,date,integer,integer) from public, anon, authenticated;

grant execute on function public.create_inventory_adjustment_v1(uuid,date,text,text,jsonb) to authenticated, service_role;
grant execute on function public.update_inventory_adjustment_draft_v1(uuid,integer,date,text,text,jsonb) to authenticated, service_role;
grant execute on function public.cancel_inventory_adjustment_v1(uuid,integer) to authenticated, service_role;
grant execute on function public.confirm_inventory_adjustment_v1(uuid,integer,uuid) to authenticated, service_role;
grant execute on function public.reverse_inventory_adjustment_v1(uuid,uuid) to authenticated, service_role;
grant execute on function public.search_inventory_adjustment_products_v1(text,integer) to authenticated, service_role;
grant execute on function public.get_inventory_adjustment_v1(uuid) to authenticated, service_role;
grant execute on function public.list_inventory_adjustments_v1(text,text,date,date,integer,integer) to authenticated, service_role;

comment on table public.inventory_adjustments is 'Versioned inventory adjustment documents; confirmed rows are immutable.';
comment on table public.inventory_adjustment_lines is 'Server-authoritative stock, reservation, availability and cost snapshots for adjustment lines.';
comment on function public.confirm_inventory_adjustment_v1(uuid,integer,uuid) is 'Atomically locks products in UUID order, validates reservations and confirms exactly once.';
comment on function public.reverse_inventory_adjustment_v1(uuid,uuid) is 'Creates one complete inverse document and opposite movements; never edits original lines.';
