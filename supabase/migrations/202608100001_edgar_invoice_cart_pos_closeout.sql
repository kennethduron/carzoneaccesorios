-- Edgar controlled rollout: prospective fiscal snapshots, stable POS cart order,
-- admin customer merge permission and immediate POS delivery behind a kill switch.
-- Historical fiscal/economic rows are intentionally not backfilled.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Prospective document snapshots only. Existing rows remain null in these fields.
alter table public.orders
  add column if not exists fiscal_customer_city text,
  add column if not exists fiscal_customer_business_name text,
  add column if not exists delivered_at timestamptz,
  add column if not exists delivered_by uuid references public.users(id) on delete set null;

alter table public.invoices
  add column if not exists customer_city text,
  add column if not exists customer_business_name text;

comment on column public.orders.fiscal_customer_city is
  'Prospective fiscal city snapshot. Null on historical orders is meaningful and must not be reconstructed from the live customer.';
comment on column public.orders.fiscal_customer_business_name is
  'Prospective fiscal company snapshot, independent from the customer name. Historical rows are not backfilled.';
comment on column public.invoices.customer_city is
  'Prospective city copied from the order fiscal snapshot. Historical invoices are not backfilled.';
comment on column public.invoices.customer_business_name is
  'Prospective company copied from the order fiscal snapshot. Historical invoices are not backfilled.';
comment on column public.orders.delivered_at is
  'Server-side delivery timestamp. Historical delivered orders remain null when canonical evidence is unavailable.';
comment on column public.orders.delivered_by is
  'Commercial actor who completed delivery; ON DELETE SET NULL preserves the historical order.';

create index if not exists orders_delivered_at_idx
  on public.orders(delivered_at desc) where delivered_at is not null;

-- Stable order for POS draft lines. This is a non-economic draft-only backfill.
alter table public.pos_sale_draft_items
  add column if not exists line_position integer;

with positions as (
  select id,
    row_number() over (partition by draft_id order by created_at, id)::integer as line_position
  from public.pos_sale_draft_items
)
update public.pos_sale_draft_items item
set line_position = positions.line_position
from positions
where positions.id = item.id and item.line_position is null;

alter table public.pos_sale_draft_items
  alter column line_position set not null;

alter table public.pos_sale_draft_items
  add constraint pos_sale_draft_items_line_position_positive
    check (line_position > 0),
  add constraint pos_sale_draft_items_draft_line_position_key
    unique (draft_id, line_position) deferrable initially immediate;

comment on column public.pos_sale_draft_items.line_position is
  'One-based user-selected cart order. Save RPC input ordinality is authoritative.';

-- Preserve the certified payload builder and decorate only its item order.
alter function public.build_pos_sale_draft_payload_pre_charges_v1(uuid)
  rename to build_pos_sale_draft_payload_pre_line_position_v1;

create function public.build_pos_sale_draft_payload_pre_charges_v1(p_draft_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select base.payload || jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(
        item.value || jsonb_build_object('linePosition', line.line_position)
        order by line.line_position, line.id
      )
      from jsonb_array_elements(coalesce(base.payload->'items', '[]'::jsonb)) item(value)
      join public.pos_sale_draft_items line
        on line.id = (item.value->>'itemId')::uuid
       and line.draft_id = p_draft_id
    ), '[]'::jsonb)
  )
  from (
    select public.build_pos_sale_draft_payload_pre_line_position_v1(p_draft_id) as payload
  ) base
  where base.payload is not null
$$;

revoke all on function public.build_pos_sale_draft_payload_pre_line_position_v1(uuid)
  from public, anon, authenticated;
revoke all on function public.build_pos_sale_draft_payload_pre_charges_v1(uuid)
  from public, anon, authenticated;

-- The input-order map is transaction-local. The existing certified save remains
-- responsible for validation, CAS, idempotency, pricing and calculations.
create or replace function public.assign_pos_draft_line_position_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  positions_text text := nullif(current_setting('app.pos_line_positions_v1', true), '');
  positions jsonb;
  mapped_position integer;
begin
  if positions_text is not null then
    positions := positions_text::jsonb;
    mapped_position := nullif(positions->>new.product_id::text, '')::integer;
  end if;

  new.line_position := coalesce(
    mapped_position,
    new.line_position,
    (select coalesce(max(existing.line_position), 0) + 1
     from public.pos_sale_draft_items existing
     where existing.draft_id = new.draft_id)
  );
  return new;
end;
$$;

drop trigger if exists pos_sale_draft_items_assign_line_position
  on public.pos_sale_draft_items;
create trigger pos_sale_draft_items_assign_line_position
before insert on public.pos_sale_draft_items
for each row execute function public.assign_pos_draft_line_position_v1();

revoke all on function public.assign_pos_draft_line_position_v1()
  from public, anon, authenticated;

alter function public.save_pos_sale_draft_v1(
  uuid, uuid, bigint, uuid, integer, jsonb, text, text, text, text,
  numeric, numeric, numeric
) rename to save_pos_sale_draft_pre_line_position_v1;

create function public.save_pos_sale_draft_v1(
  p_request_key uuid,
  p_draft_id uuid,
  p_expected_version bigint,
  p_customer_id uuid,
  p_expected_customer_commercial_version integer,
  p_items jsonb,
  p_delivery_mode text default 'store_immediate',
  p_delivery_address text default null,
  p_delivery_notes text default null,
  p_internal_notes text default null,
  p_delivery_charge numeric default 0,
  p_cash_on_delivery_charge numeric default 0,
  p_other_charges numeric default 0
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  previous_positions text := current_setting('app.pos_line_positions_v1', true);
  requested_positions jsonb;
  saved jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception using errcode = '22023', message = 'El carrito no tiene un formato valido.';
  end if;

  select coalesce(jsonb_object_agg(
    element.value->>'productId', element.line_position
    order by element.line_position
  ), '{}'::jsonb)
  into requested_positions
  from jsonb_array_elements(p_items) with ordinality
    as element(value, line_position);

  perform set_config('app.pos_line_positions_v1', requested_positions::text, true);
  saved := public.save_pos_sale_draft_pre_line_position_v1(
    p_request_key,
    p_draft_id,
    p_expected_version,
    p_customer_id,
    p_expected_customer_commercial_version,
    p_items,
    p_delivery_mode,
    p_delivery_address,
    p_delivery_notes,
    p_internal_notes,
    p_delivery_charge,
    p_cash_on_delivery_charge,
    p_other_charges
  );
  perform set_config('app.pos_line_positions_v1', coalesce(previous_positions, ''), true);
  return saved;
exception when others then
  perform set_config('app.pos_line_positions_v1', coalesce(previous_positions, ''), true);
  raise;
end;
$$;

revoke all on function public.save_pos_sale_draft_pre_line_position_v1(
  uuid, uuid, bigint, uuid, integer, jsonb, text, text, text, text,
  numeric, numeric, numeric
) from public, anon, authenticated;
revoke all on function public.save_pos_sale_draft_v1(
  uuid, uuid, bigint, uuid, integer, jsonb, text, text, text, text,
  numeric, numeric, numeric
) from public, anon;
grant execute on function public.save_pos_sale_draft_v1(
  uuid, uuid, bigint, uuid, integer, jsonb, text, text, text, text,
  numeric, numeric, numeric
) to authenticated;

-- Admin receives only the already-canonical merge permission. The merge RPC,
-- permission checks, locks, hashes and invariants remain unchanged.
update public.roles role
set permissions = (
  select coalesce(jsonb_agg(permission order by permission), '[]'::jsonb)
  from (
    select distinct value as permission
    from jsonb_array_elements_text(
      coalesce(role.permissions, '[]'::jsonb) || '["customers:merge"]'::jsonb
    )
  ) permissions
), updated_at = now()
where role.name = 'admin';

-- Extend the domain flag table without changing the existing overdue guard.
alter table public.pos_feature_flags
  drop constraint pos_feature_flags_known_key;
alter table public.pos_feature_flags
  add constraint pos_feature_flags_known_key check (
    key in ('pos_credit_overdue_override_v1', 'pos_immediate_delivery_v1')
  );

insert into public.pos_feature_flags(key, enabled, reason)
values (
  'pos_immediate_delivery_v1',
  false,
  'POS immediate delivery V1 installed disabled for controlled rollout.'
)
on conflict (key) do nothing;

create or replace function public.pos_immediate_delivery_enabled_v1()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select enabled from public.pos_feature_flags
    where key = 'pos_immediate_delivery_v1'
  ), false)
$$;

revoke all on function public.pos_immediate_delivery_enabled_v1()
  from public, anon;
grant execute on function public.pos_immediate_delivery_enabled_v1()
  to authenticated, service_role;

create or replace function public.set_pos_immediate_delivery_v1(
  p_enabled boolean,
  p_reason text
)
returns table (
  feature_key text,
  enabled boolean,
  version integer,
  enabled_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := case
    when auth.uid() is null then 'service_role'
    else public.current_actor_role()
  end;
  clean_reason text := nullif(left(trim(coalesce(p_reason, '')), 500), '');
  saved public.pos_feature_flags%rowtype;
begin
  if not coalesce(auth.role() = 'service_role', false)
    and (actor_id is null or actor_role not in ('technical_owner', 'business_owner', 'admin')) then
    raise exception using errcode = '42501', message = 'POS_IMMEDIATE_DELIVERY_FORBIDDEN';
  end if;
  if clean_reason is null or char_length(clean_reason) < 10 then
    raise exception using errcode = '22023', message = 'POS_IMMEDIATE_DELIVERY_REASON_REQUIRED';
  end if;

  update public.pos_feature_flags flag
  set enabled = p_enabled,
      version = flag.version + 1,
      reason = clean_reason,
      enabled_at = case when p_enabled then now() else null end,
      updated_at = now(),
      updated_by = actor_id
  where flag.key = 'pos_immediate_delivery_v1'
  returning * into saved;

  insert into public.audit_logs(
    user_id, actor_role, table_name, record_id, action, old_data, new_data
  ) values (
    actor_id, actor_role, 'pos_feature_flags', null,
    'pos.immediate_delivery.feature_flag_changed', null,
    jsonb_build_object(
      'key', saved.key,
      'enabled', saved.enabled,
      'version', saved.version,
      'reason', saved.reason
    )
  );

  feature_key := saved.key;
  enabled := saved.enabled;
  version := saved.version;
  enabled_at := saved.enabled_at;
  updated_at := saved.updated_at;
  return next;
end;
$$;

revoke all on function public.set_pos_immediate_delivery_v1(boolean, text)
  from public, anon;
grant execute on function public.set_pos_immediate_delivery_v1(boolean, text)
  to authenticated, service_role;

-- This trigger runs inside confirm_pos_sale_v1's existing transaction. It only
-- changes POS logistics and prospective customer snapshots; all economic work
-- remains in the certified confirmation core.
create or replace function public.apply_pos_order_closeout_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  draft_customer_id uuid;
  draft_status text;
  customer_record public.customers%rowtype;
begin
  if new.source::text <> 'pos' or new.pos_draft_id is null then
    return new;
  end if;

  select draft.customer_id, draft.status
  into draft_customer_id, draft_status
  from public.pos_sale_drafts draft
  where draft.id = new.pos_draft_id;

  if draft_customer_id is null
    or draft_customer_id is distinct from new.customer_id
    or draft_status <> 'active' then
    return new;
  end if;

  select * into strict customer_record
  from public.customers customer
  where customer.id = new.customer_id;

  new.fiscal_customer_name := customer_record.contact_name;
  new.fiscal_customer_business_name := nullif(trim(coalesce(customer_record.business_name, '')), '');
  new.fiscal_customer_city := nullif(trim(coalesce(customer_record.city, '')), '');
  new.fiscal_customer_address := nullif(trim(coalesce(customer_record.address, '')), '');

  if public.pos_immediate_delivery_enabled_v1() and new.created_by is not null then
    new.status := 'entregado';
    new.tracking_status := 'entregado';
    new.delivered_at := now();
    new.delivered_by := new.created_by;
  end if;

  return new;
end;
$$;

drop trigger if exists orders_apply_pos_closeout_before_insert on public.orders;
create trigger orders_apply_pos_closeout_before_insert
before insert on public.orders
for each row execute function public.apply_pos_order_closeout_v1();

revoke all on function public.apply_pos_order_closeout_v1()
  from public, anon, authenticated;

-- Copy only immutable order snapshots into newly issued invoices.
create or replace function public.apply_order_customer_snapshot_to_invoice_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select order_row.fiscal_customer_city,
         order_row.fiscal_customer_business_name
  into new.customer_city, new.customer_business_name
  from public.orders order_row
  where order_row.id = new.order_id;
  return new;
end;
$$;

drop trigger if exists invoices_apply_order_customer_snapshot_before_insert
  on public.invoices;
create trigger invoices_apply_order_customer_snapshot_before_insert
before insert on public.invoices
for each row execute function public.apply_order_customer_snapshot_to_invoice_v1();

revoke all on function public.apply_order_customer_snapshot_to_invoice_v1()
  from public, anon, authenticated;

create or replace function public.audit_pos_immediate_delivery_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.source::text = 'pos'
    and new.pos_draft_id is not null
    and new.status::text in ('entregado', 'delivered')
    and new.delivered_at is not null then
    perform public.write_audit_log(
      'orders', new.id, 'pos.sale.confirmed_immediate_delivery', null,
      jsonb_build_object(
        'order_id', new.id,
        'pos_draft_id', new.pos_draft_id,
        'status', new.status,
        'tracking_status', new.tracking_status,
        'delivered_at', new.delivered_at,
        'delivered_by', new.delivered_by,
        'source', new.source,
        'economic_effects_added', false
      )
    );
  end if;
  return new;
end;
$$;

drop trigger if exists orders_audit_pos_immediate_delivery_after_insert
  on public.orders;
create trigger orders_audit_pos_immediate_delivery_after_insert
after insert on public.orders
for each row execute function public.audit_pos_immediate_delivery_v1();

revoke all on function public.audit_pos_immediate_delivery_v1()
  from public, anon, authenticated;

commit;
