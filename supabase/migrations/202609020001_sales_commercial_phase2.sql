-- Sales & commercial management Phase 2: restricted sellers, immutable POS
-- attribution, exceptional-price approvals and server-scoped seller history.
-- Historical POS orders are intentionally not backfilled.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.orders
  add column if not exists seller_display_name_snapshot text;

comment on column public.orders.seller_display_name_snapshot is
  'Prospective immutable display snapshot of the seller assigned at POS confirmation. Historical nulls are intentional.';

alter table public.pos_idempotency_requests
  drop constraint if exists pos_idempotency_actor_role_check;
alter table public.pos_idempotency_requests
  add constraint pos_idempotency_actor_role_check
  check (actor_role in ('technical_owner', 'business_owner', 'admin', 'vendedor'));

create table public.pos_price_requests (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  payload_hash text not null,
  seller_user_id uuid not null references public.users(id) on delete restrict,
  seller_display_name_snapshot text not null,
  draft_id uuid not null references public.pos_sale_drafts(id) on delete restrict,
  draft_version bigint not null,
  draft_item_id uuid not null,
  customer_id uuid not null references public.customers(id) on delete restrict,
  customer_commercial_version integer not null,
  product_id uuid not null references public.products(id) on delete restrict,
  product_sales_version bigint not null,
  product_name_snapshot text not null,
  sku_snapshot text not null,
  quantity integer not null check (quantity > 0),
  base_unit_price numeric(12,2) not null check (base_unit_price > 0),
  requested_unit_price numeric(12,2) not null check (requested_unit_price > 0),
  reason text not null check (char_length(trim(reason)) between 5 and 500),
  status text not null default 'pending'
    check (status in ('pending','approved','rejected','cancelled','consumed','revoked','expired')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references public.users(id) on delete restrict,
  decision_reason text,
  expires_at timestamptz,
  consumed_at timestamptz,
  consumed_by uuid references public.users(id) on delete restrict,
  consumed_order_id uuid references public.orders(id) on delete restrict,
  updated_at timestamptz not null default now(),
  constraint pos_price_requests_payload_hash_check check (payload_hash ~ '^[0-9a-f]{64}$'),
  constraint pos_price_requests_different_price_check check (requested_unit_price <> base_unit_price),
  constraint pos_price_requests_state_shape_check check (
    (status = 'pending' and decided_at is null and decided_by is null and expires_at is null and consumed_at is null)
    or (status = 'approved' and decided_at is not null and decided_by is not null and expires_at is not null and consumed_at is null)
    or (status in ('rejected','revoked') and decided_at is not null and decided_by is not null and consumed_at is null)
    or (status in ('cancelled','expired') and consumed_at is null)
    or (status = 'consumed' and decided_at is not null and decided_by is not null and expires_at is not null
      and consumed_at is not null and consumed_by is not null and consumed_order_id is not null)
  )
);

create unique index pos_price_requests_one_open_binding_idx
  on public.pos_price_requests(seller_user_id, draft_id, product_id)
  where status in ('pending','approved');
create index pos_price_requests_status_requested_idx
  on public.pos_price_requests(status, requested_at desc);
create index pos_price_requests_seller_requested_idx
  on public.pos_price_requests(seller_user_id, requested_at desc);
create index pos_price_requests_draft_idx
  on public.pos_price_requests(draft_id, product_id, status);

create table public.pos_price_request_events (
  id bigint generated always as identity primary key,
  request_id uuid not null references public.pos_price_requests(id) on delete restrict,
  event_type text not null check (event_type in ('requested','approved','rejected','cancelled','rebound','consumed','revoked','expired')),
  actor_user_id uuid references public.users(id) on delete restrict,
  actor_role text not null,
  from_status text,
  to_status text not null,
  reason text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);
create index pos_price_request_events_request_created_idx
  on public.pos_price_request_events(request_id, created_at, id);

create table public.pos_seller_attribution_events (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete restrict,
  event_type text not null check (event_type in ('assigned','corrected')),
  previous_seller_user_id uuid references public.users(id) on delete restrict,
  previous_seller_display_name_snapshot text,
  seller_user_id uuid not null references public.users(id) on delete restrict,
  seller_display_name_snapshot text not null,
  actor_user_id uuid not null references public.users(id) on delete restrict,
  actor_role text not null,
  reason text not null,
  created_at timestamptz not null default now()
);
create index pos_seller_attribution_events_order_created_idx
  on public.pos_seller_attribution_events(order_id, created_at, id);

alter table public.pos_price_requests enable row level security;
alter table public.pos_price_request_events enable row level security;
alter table public.pos_seller_attribution_events enable row level security;
revoke all on public.pos_price_requests, public.pos_price_request_events,
  public.pos_seller_attribution_events from public, anon, authenticated;
grant select, insert, update on public.pos_price_requests to service_role;
grant select, insert on public.pos_price_request_events,
  public.pos_seller_attribution_events to service_role;

create or replace function public.prevent_pos_commercial_event_mutation_v1()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception using errcode = '42501', message = 'POS_APPEND_ONLY_EVENT';
end;
$$;
create trigger pos_price_request_events_append_only
before update or delete on public.pos_price_request_events
for each row execute function public.prevent_pos_commercial_event_mutation_v1();
create trigger pos_seller_attribution_events_append_only
before update or delete on public.pos_seller_attribution_events
for each row execute function public.prevent_pos_commercial_event_mutation_v1();
revoke all on function public.prevent_pos_commercial_event_mutation_v1() from public, anon, authenticated;

-- Keep application and database RBAC aligned. Sellers receive only the
-- commercial workflow permissions; broad legacy customer/order/CRM grants go.
insert into public.roles(name,description,permissions)
select 'admin','Administrador del negocio con autoridad comercial elevada.',permissions
from public.roles where name='business_owner'
on conflict (name) do nothing;

insert into public.roles(name,description,permissions) values(
  'vendedor','Vendedor operativo con POS, clientes básicos, solicitudes de precio y ventas propias.',
  '[]'::jsonb
) on conflict (name) do nothing;

update public.roles role
set permissions = (
  select coalesce(jsonb_agg(permission order by permission), '[]'::jsonb)
  from (
    select distinct value as permission
    from jsonb_array_elements_text(coalesce(role.permissions, '[]'::jsonb)
      || '["pos:price_request","pos:price_approvals:read","pos:price_approvals:decide","pos:sales:read_own","pos:seller_attribution:correct","pos:customers:write_basic"]'::jsonb)
  ) allowed
), updated_at = now()
where role.name in ('technical_owner','business_owner','admin');

update public.roles role
set permissions = '["admin:access","products:read","pos:create_sale","pos:access","pos:customers:search","pos:customers:create","pos:customers:update","pos:customers:write_basic","pos:drafts:create","pos:drafts:read","pos:drafts:edit_own","pos:drafts:abandon","pos:products:search","pos:price_request","pos:confirm_sale","pos:reprint_documents","pos:sales:read_own","customers:read_commercial","customers:read_credit","notifications:read"]'::jsonb,
    updated_at = now()
where role.name = 'vendedor';

create or replace function public.pos_permission_allowed(permission_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
    and permission_key in (
      'pos:create_sale','pos:apply_discount','pos:access',
      'pos:customers:search','pos:customers:create','pos:customers:update','pos:customers:write_basic',
      'customers:read_commercial','customers:read_credit',
      'pos:drafts:create','pos:drafts:read','pos:drafts:edit_own','pos:drafts:edit_any','pos:drafts:abandon',
      'pos:products:search','pos:price_override','pos:price_request',
      'pos:price_approvals:read','pos:price_approvals:decide','pos:sales:read_own',
      'pos:seller_attribution:correct','pos:confirm_sale','pos:reprint_documents'
    )
    and public.current_actor_role() in ('technical_owner','business_owner','admin','vendedor')
    and public.has_permission(permission_key);
$$;
revoke all on function public.pos_permission_allowed(text) from public, anon;
grant execute on function public.pos_permission_allowed(text) to authenticated;

create or replace function public.pos_actor_display_name_v1(target_user_id uuid)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(nullif(trim(full_name), ''), nullif(trim(username), ''),
    nullif(split_part(email, '@', 1), ''), 'Usuario')
  from public.users where id = target_user_id and active
$$;
revoke all on function public.pos_actor_display_name_v1(uuid) from public, anon, authenticated;

create or replace function public.assign_pos_seller_attribution_v1()
returns trigger language plpgsql security definer set search_path = public as $$
declare actor_id uuid := auth.uid(); actor_name text;
begin
  if new.source <> 'pos' then return new; end if;
  if actor_id is null then
    raise exception using errcode = '42501', message = 'POS_SELLER_ATTRIBUTION_REQUIRED';
  end if;
  actor_name := public.pos_actor_display_name_v1(actor_id);
  if actor_name is null then
    raise exception using errcode = '42501', message = 'POS_SELLER_INACTIVE';
  end if;
  new.seller_id := actor_id;
  new.seller_display_name_snapshot := actor_name;
  return new;
end;
$$;
drop trigger if exists assign_pos_seller_attribution_on_insert on public.orders;
create trigger assign_pos_seller_attribution_on_insert
before insert on public.orders for each row execute function public.assign_pos_seller_attribution_v1();
revoke all on function public.assign_pos_seller_attribution_v1() from public, anon, authenticated;

create or replace function public.record_pos_seller_assignment_v1()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'pos' then
    insert into public.pos_seller_attribution_events(
      order_id,event_type,seller_user_id,seller_display_name_snapshot,
      actor_user_id,actor_role,reason
    ) values (new.id,'assigned',new.seller_id,new.seller_display_name_snapshot,
      new.created_by,public.current_actor_role(),'Asignacion automatica al confirmar venta POS.');
  end if;
  return new;
end;
$$;
drop trigger if exists record_pos_seller_assignment_on_insert on public.orders;
create trigger record_pos_seller_assignment_on_insert
after insert on public.orders for each row execute function public.record_pos_seller_assignment_v1();
revoke all on function public.record_pos_seller_assignment_v1() from public, anon, authenticated;

create or replace function public.protect_pos_seller_attribution_v1()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.seller_id is distinct from old.seller_id
    or new.seller_display_name_snapshot is distinct from old.seller_display_name_snapshot then
    if current_setting('app.pos_seller_correction_actor', true) is distinct from coalesce(auth.uid()::text, '') then
      raise exception using errcode='42501',message='POS_SELLER_ATTRIBUTION_IMMUTABLE';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists protect_pos_seller_attribution_on_update on public.orders;
create trigger protect_pos_seller_attribution_on_update
before update of seller_id,seller_display_name_snapshot on public.orders
for each row execute function public.protect_pos_seller_attribution_v1();
revoke all on function public.protect_pos_seller_attribution_v1() from public,anon,authenticated;

create or replace function public.correct_pos_order_seller_v1(
  p_order_id uuid, p_seller_user_id uuid, p_reason text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare actor_id uuid := auth.uid(); actor_role text := public.current_actor_role();
  order_record public.orders%rowtype; seller_name text; clean_reason text := nullif(trim(p_reason), '');
begin
  if actor_id is null or actor_role not in ('technical_owner','business_owner','admin')
    or not public.pos_permission_allowed('pos:seller_attribution:correct') then
    raise exception using errcode = '42501', message = 'POS_SELLER_CORRECTION_FORBIDDEN';
  end if;
  if clean_reason is null or char_length(clean_reason) not between 10 and 500 then
    raise exception using errcode = '22023', message = 'POS_SELLER_CORRECTION_REASON_REQUIRED';
  end if;
  select * into order_record from public.orders where id = p_order_id for update;
  if order_record.id is null or order_record.source <> 'pos' then
    raise exception using errcode = 'P0002', message = 'POS_ORDER_NOT_FOUND';
  end if;
  seller_name := public.pos_actor_display_name_v1(p_seller_user_id);
  if seller_name is null or not exists (
    select 1 from public.users u join public.roles r on r.id=u.role_id
    where u.id=p_seller_user_id and u.active and r.name in ('technical_owner','business_owner','admin','vendedor')
  ) then raise exception using errcode = '22023', message = 'POS_SELLER_INVALID'; end if;
  if order_record.seller_id = p_seller_user_id then
    return jsonb_build_object('orderId',p_order_id,'sellerId',p_seller_user_id,'sellerName',seller_name,'changed',false);
  end if;
  perform set_config('app.pos_seller_correction_actor',actor_id::text,true);
  update public.orders set seller_id=p_seller_user_id,
    seller_display_name_snapshot=seller_name, updated_at=now() where id=p_order_id;
  insert into public.pos_seller_attribution_events(
    order_id,event_type,previous_seller_user_id,previous_seller_display_name_snapshot,
    seller_user_id,seller_display_name_snapshot,actor_user_id,actor_role,reason
  ) values (p_order_id,'corrected',order_record.seller_id,order_record.seller_display_name_snapshot,
    p_seller_user_id,seller_name,actor_id,actor_role,clean_reason);
  perform public.write_audit_log('orders',p_order_id,'pos.seller.corrected',
    jsonb_build_object('seller_id',order_record.seller_id,'seller_name',order_record.seller_display_name_snapshot),
    jsonb_build_object('seller_id',p_seller_user_id,'seller_name',seller_name,'reason',clean_reason));
  return jsonb_build_object('orderId',p_order_id,'sellerId',p_seller_user_id,'sellerName',seller_name,'changed',true);
end;
$$;
revoke all on function public.correct_pos_order_seller_v1(uuid,uuid,text) from public, anon;
grant execute on function public.correct_pos_order_seller_v1(uuid,uuid,text) to authenticated;

create or replace function public.build_pos_price_request_payload_v1(p_request_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'requestId', request.id,
    'requestKey', request.request_key,
    'sellerId', request.seller_user_id,
    'sellerName', request.seller_display_name_snapshot,
    'draftId', request.draft_id,
    'draftVersion', request.draft_version,
    'itemId', request.draft_item_id,
    'customerId', request.customer_id,
    'customerName', coalesce(nullif(customer.business_name,''), customer.contact_name),
    'customerCommercialVersion', request.customer_commercial_version,
    'productId', request.product_id,
    'productSalesVersion', request.product_sales_version,
    'productName', request.product_name_snapshot,
    'sku', request.sku_snapshot,
    'quantity', request.quantity,
    'baseUnitPrice', request.base_unit_price,
    'requestedUnitPrice', request.requested_unit_price,
    'difference', round(request.requested_unit_price-request.base_unit_price,2),
    'variationPercent', round(((request.requested_unit_price-request.base_unit_price)/request.base_unit_price)*100,2),
    'reason', request.reason,
    'status', case when request.status='approved' and request.expires_at<=now() then 'expired' else request.status end,
    'requestedAt', request.requested_at,
    'decidedAt', request.decided_at,
    'decidedBy', request.decided_by,
    'decisionReason', request.decision_reason,
    'expiresAt', request.expires_at,
    'consumedAt', request.consumed_at,
    'consumedOrderId', request.consumed_order_id,
    'events', coalesce((select jsonb_agg(jsonb_build_object(
      'id',event.id,'type',event.event_type,'fromStatus',event.from_status,
      'toStatus',event.to_status,'reason',event.reason,'createdAt',event.created_at
    ) order by event.created_at,event.id) from public.pos_price_request_events event
      where event.request_id=request.id),'[]'::jsonb)
  )
  from public.pos_price_requests request
  join public.customers customer on customer.id=request.customer_id
  where request.id=p_request_id
$$;
revoke all on function public.build_pos_price_request_payload_v1(uuid) from public, anon, authenticated;

create or replace function public.expire_pos_price_requests_v1()
returns integer language plpgsql security definer set search_path = public as $$
declare expired_count integer;
begin
  with expired as (
    update public.pos_price_requests request
    set status='expired', updated_at=now()
    where request.status='approved' and request.expires_at<=now()
    returning request.id
  ), events as (
    insert into public.pos_price_request_events(
      request_id,event_type,actor_user_id,actor_role,from_status,to_status,reason
    ) select id,'expired',null,'system','approved','expired','La autorizacion alcanzo su vigencia de 30 minutos.'
      from expired returning 1
  ) select count(*) into expired_count from events;
  return expired_count;
end;
$$;
revoke all on function public.expire_pos_price_requests_v1() from public, anon, authenticated;

create or replace function public.create_pos_price_request_v1(
  p_request_key uuid,
  p_draft_id uuid,
  p_expected_draft_version bigint,
  p_draft_item_id uuid,
  p_requested_unit_price numeric,
  p_reason text
) returns jsonb language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare actor_id uuid := auth.uid(); actor_role text := public.current_actor_role();
  actor_name text; clean_reason text := nullif(trim(p_reason),''); requested_price numeric(12,2);
  draft_record public.pos_sale_drafts%rowtype; item_record public.pos_sale_draft_items%rowtype;
  product_record public.products%rowtype; existing public.pos_price_requests%rowtype;
  payload_hash text; created_id uuid;
begin
  if actor_id is null or actor_role <> 'vendedor'
    or not public.pos_permission_allowed('pos:price_request') then
    raise exception using errcode='42501', message='POS_PRICE_REQUEST_FORBIDDEN';
  end if;
  if p_request_key is null or p_request_key='00000000-0000-0000-0000-000000000000'::uuid
    or p_draft_id is null or p_draft_item_id is null or p_expected_draft_version is null then
    raise exception using errcode='22023', message='POS_PRICE_REQUEST_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pos:price-request:'||p_request_key::text,0));
  requested_price := round(p_requested_unit_price,2);
  if requested_price<=0 or clean_reason is null or char_length(clean_reason) not between 5 and 500 then
    raise exception using errcode='22023', message='POS_PRICE_REQUEST_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('pos:draft:'||p_draft_id::text,0));
  select * into draft_record from public.pos_sale_drafts where id=p_draft_id for update;
  if draft_record.id is null or draft_record.owner_user_id<>actor_id then
    raise exception using errcode='42501', message='POS_PRICE_REQUEST_FORBIDDEN';
  end if;
  if draft_record.status<>'active' or draft_record.expires_at<=now()
    or draft_record.version<>p_expected_draft_version then
    raise exception using errcode='PT409', message='POS_DRAFT_CHANGED';
  end if;
  select * into item_record from public.pos_sale_draft_items
    where id=p_draft_item_id and draft_id=p_draft_id for update;
  if item_record.id is null or item_record.price_overridden then
    raise exception using errcode='PT409', message='POS_PRICE_REQUEST_ITEM_CHANGED';
  end if;
  select * into product_record from public.products where id=item_record.product_id for share;
  if product_record.id is null or not product_record.active or product_record.status<>'active'
    or product_record.product_sales_version<>item_record.product_sales_version
    or item_record.final_unit_price<>item_record.base_unit_price then
    raise exception using errcode='PT409', message='POS_PRICE_CHANGED';
  end if;
  if requested_price=item_record.base_unit_price then
    raise exception using errcode='22023', message='POS_PRICE_REQUEST_SAME_PRICE';
  end if;
  -- Fail closed without returning cost or margin information to the seller.
  if product_record.cost_price is null or product_record.cost_price<=0
    or requested_price<product_record.cost_price then
    raise exception using errcode='22023', message='POS_REQUESTED_PRICE_NOT_PERMITTED';
  end if;
  actor_name := public.pos_actor_display_name_v1(actor_id);
  payload_hash := encode(digest(convert_to(jsonb_build_object(
    'draft_id',p_draft_id,'draft_version',p_expected_draft_version,'item_id',p_draft_item_id,
    'customer_id',draft_record.customer_id,'customer_version',draft_record.customer_commercial_version,
    'product_id',item_record.product_id,'product_version',item_record.product_sales_version,
    'quantity',item_record.quantity,'base_price',item_record.base_unit_price,
    'requested_price',requested_price,'reason',clean_reason
  )::text,'UTF8'),'sha256'),'hex');
  select * into existing from public.pos_price_requests where request_key=p_request_key;
  if existing.id is not null then
    if existing.seller_user_id<>actor_id or existing.payload_hash<>payload_hash then
      raise exception using errcode='PT409', message='POS_REQUEST_KEY_CONFLICT';
    end if;
    return public.build_pos_price_request_payload_v1(existing.id)||jsonb_build_object('idempotentReplay',true);
  end if;
  if exists (select 1 from public.pos_price_requests r where r.seller_user_id=actor_id
    and r.draft_id=p_draft_id and r.product_id=item_record.product_id
    and r.status in ('pending','approved')) then
    raise exception using errcode='PT409', message='POS_PRICE_REQUEST_ALREADY_OPEN';
  end if;
  insert into public.pos_price_requests(
    request_key,payload_hash,seller_user_id,seller_display_name_snapshot,draft_id,draft_version,
    draft_item_id,customer_id,customer_commercial_version,product_id,product_sales_version,
    product_name_snapshot,sku_snapshot,
    quantity,base_unit_price,requested_unit_price,reason
  ) values (p_request_key,payload_hash,actor_id,actor_name,p_draft_id,p_expected_draft_version,
    p_draft_item_id,draft_record.customer_id,draft_record.customer_commercial_version,
    item_record.product_id,item_record.product_sales_version,item_record.product_name_snapshot,
    item_record.sku_snapshot,item_record.quantity,
    item_record.base_unit_price,requested_price,clean_reason) returning id into created_id;
  insert into public.pos_price_request_events(
    request_id,event_type,actor_user_id,actor_role,from_status,to_status,reason
  ) values (created_id,'requested',actor_id,actor_role,null,'pending',clean_reason);
  perform public.write_audit_log('pos_price_requests',created_id,'pos.price_request.created',null,
    jsonb_build_object('seller_id',actor_id,'draft_id',p_draft_id,'product_id',item_record.product_id,
      'quantity',item_record.quantity,'base_unit_price',item_record.base_unit_price,
      'requested_unit_price',requested_price));
  return public.build_pos_price_request_payload_v1(created_id)||jsonb_build_object('idempotentReplay',false);
end;
$$;
revoke all on function public.create_pos_price_request_v1(uuid,uuid,bigint,uuid,numeric,text) from public, anon;
grant execute on function public.create_pos_price_request_v1(uuid,uuid,bigint,uuid,numeric,text) to authenticated;

create or replace function public.get_pos_price_request_v1(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare request_record public.pos_price_requests%rowtype; actor_id uuid:=auth.uid();
begin
  if actor_id is null then raise exception using errcode='42501',message='POS_PRICE_REQUEST_FORBIDDEN'; end if;
  perform public.expire_pos_price_requests_v1();
  select * into request_record from public.pos_price_requests where id=p_request_id;
  if request_record.id is null then raise exception using errcode='P0002',message='POS_PRICE_REQUEST_NOT_FOUND'; end if;
  if request_record.seller_user_id<>actor_id
    and not public.pos_permission_allowed('pos:price_approvals:read') then
    raise exception using errcode='42501',message='POS_PRICE_REQUEST_FORBIDDEN';
  end if;
  return public.build_pos_price_request_payload_v1(p_request_id);
end;
$$;
revoke all on function public.get_pos_price_request_v1(uuid) from public, anon;
grant execute on function public.get_pos_price_request_v1(uuid) to authenticated;

create or replace function public.list_pos_price_requests_v1(
  p_status text default 'pending', p_query text default null,
  p_seller_user_id uuid default null, p_from date default null, p_to date default null,
  p_sort text default 'newest', p_limit integer default 50, p_offset integer default 0
) returns jsonb language plpgsql security definer set search_path = public as $$
declare actor_id uuid:=auth.uid(); elevated boolean; result jsonb;
begin
  if actor_id is null then raise exception using errcode='42501',message='POS_PRICE_REQUEST_FORBIDDEN'; end if;
  elevated:=public.pos_permission_allowed('pos:price_approvals:read');
  if not elevated and not public.pos_permission_allowed('pos:price_request') then
    raise exception using errcode='42501',message='POS_PRICE_REQUEST_FORBIDDEN';
  end if;
  if p_sort not in ('newest','oldest') or (p_from is not null and p_to is not null and p_to<p_from) then
    raise exception using errcode='22023',message='POS_PRICE_REQUEST_FILTER_INVALID';
  end if;
  if not elevated and p_seller_user_id is not null and p_seller_user_id<>actor_id then
    raise exception using errcode='42501',message='POS_PRICE_REQUEST_FORBIDDEN';
  end if;
  perform public.expire_pos_price_requests_v1();
  with filtered as (
    select request.id,request.status,request.requested_at
    from public.pos_price_requests request
    where (elevated or request.seller_user_id=actor_id)
      and (p_seller_user_id is null or request.seller_user_id=p_seller_user_id)
      and (p_from is null or request.requested_at::date>=p_from)
      and (p_to is null or request.requested_at::date<=p_to)
      and (p_status is null or p_status='' or request.status=p_status)
      and (nullif(trim(coalesce(p_query,'')),'') is null
        or request.seller_display_name_snapshot ilike '%'||trim(p_query)||'%'
        or request.product_name_snapshot ilike '%'||trim(p_query)||'%'
        or request.sku_snapshot ilike '%'||trim(p_query)||'%')
  ), page as (
    select * from filtered order by
      case when p_sort='oldest' then requested_at end asc,
      case when p_sort='newest' then requested_at end desc,
      id desc
    limit least(greatest(coalesce(p_limit,50),1),100)
    offset least(greatest(coalesce(p_offset,0),0),10000)
  ) select jsonb_build_object(
    'results',coalesce((select jsonb_agg(public.build_pos_price_request_payload_v1(page.id)
      order by case when p_sort='oldest' then page.requested_at end asc,
        case when p_sort='newest' then page.requested_at end desc,page.id desc) from page),'[]'::jsonb),
    'total',(select count(*) from filtered),
    'sellers',coalesce((select jsonb_agg(jsonb_build_object('id',seller.seller_user_id,'name',seller.seller_display_name_snapshot)
      order by seller.seller_display_name_snapshot)
      from (select distinct on (r.seller_user_id) r.seller_user_id,r.seller_display_name_snapshot
        from public.pos_price_requests r
        where (elevated or r.seller_user_id=actor_id)
        order by r.seller_user_id,r.requested_at desc) seller),'[]'::jsonb),
    'counts',jsonb_build_object(
      'pending',(select count(*) from public.pos_price_requests r where (elevated or r.seller_user_id=actor_id) and r.status='pending'),
      'approvedToday',(select count(*) from public.pos_price_requests r where (elevated or r.seller_user_id=actor_id) and r.status in ('approved','consumed') and r.decided_at::date=current_date),
      'rejectedToday',(select count(*) from public.pos_price_requests r where (elevated or r.seller_user_id=actor_id) and r.status='rejected' and r.decided_at::date=current_date)
    )
  ) into result;
  return result;
end;
$$;
revoke all on function public.list_pos_price_requests_v1(text,text,uuid,date,date,text,integer,integer) from public, anon;
grant execute on function public.list_pos_price_requests_v1(text,text,uuid,date,date,text,integer,integer) to authenticated;

create or replace function public.decide_pos_price_request_v1(
  p_request_id uuid, p_action text, p_reason text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare actor_id uuid:=auth.uid(); actor_role text:=public.current_actor_role();
  request_record public.pos_price_requests%rowtype; clean_reason text:=nullif(trim(p_reason),'');
  next_status text; event_name text;
begin
  if actor_id is null or actor_role not in ('technical_owner','business_owner','admin')
    or not public.pos_permission_allowed('pos:price_approvals:decide') then
    raise exception using errcode='42501',message='POS_PRICE_DECISION_FORBIDDEN';
  end if;
  perform public.expire_pos_price_requests_v1();
  select * into request_record from public.pos_price_requests where id=p_request_id for update;
  if request_record.id is null then raise exception using errcode='P0002',message='POS_PRICE_REQUEST_NOT_FOUND'; end if;
  if request_record.seller_user_id=actor_id then
    raise exception using errcode='42501',message='POS_PRICE_SELF_APPROVAL_FORBIDDEN';
  end if;
  if p_action in ('approve','reject') and request_record.status<>'pending' then
    raise exception using errcode='PT409',message='POS_PRICE_REQUEST_ALREADY_DECIDED';
  elsif p_action='revoke' and request_record.status<>'approved' then
    raise exception using errcode='PT409',message='POS_PRICE_REQUEST_NOT_REVOCABLE';
  elsif p_action not in ('approve','reject','revoke') then
    raise exception using errcode='22023',message='POS_PRICE_DECISION_INVALID';
  end if;
  if p_action in ('reject','revoke') and (clean_reason is null or char_length(clean_reason) not between 5 and 500) then
    raise exception using errcode='22023',message='POS_PRICE_DECISION_REASON_REQUIRED';
  end if;
  -- Approval revalidates cost without ever returning cost or margin data.
  if p_action='approve' and not exists (
    select 1 from public.products product where product.id=request_record.product_id
      and product.active and product.status='active'
      and product.product_sales_version=request_record.product_sales_version
      and product.cost_price is not null and product.cost_price>0
      and request_record.requested_unit_price>=product.cost_price
  ) then raise exception using errcode='PT409',message='POS_REQUESTED_PRICE_NOT_PERMITTED'; end if;
  next_status:=case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'revoked' end;
  event_name:=case p_action when 'approve' then 'approved' when 'reject' then 'rejected' else 'revoked' end;
  update public.pos_price_requests set status=next_status,decided_at=now(),decided_by=actor_id,
    decision_reason=clean_reason,expires_at=case
      when p_action='approve' then now()+interval '30 minutes'
      when p_action='revoke' then request_record.expires_at
      else null end,
    updated_at=now() where id=p_request_id;
  insert into public.pos_price_request_events(
    request_id,event_type,actor_user_id,actor_role,from_status,to_status,reason,
    metadata
  ) values (p_request_id,event_name,actor_id,actor_role,request_record.status,next_status,clean_reason,
    case when p_action='approve' then jsonb_build_object('validForSeconds',1800) else '{}'::jsonb end);
  perform public.write_audit_log('pos_price_requests',p_request_id,'pos.price_request.'||event_name,
    jsonb_build_object('status',request_record.status),
    jsonb_build_object('status',next_status,'decision_reason',clean_reason,'actor_id',actor_id));
  return public.build_pos_price_request_payload_v1(p_request_id);
end;
$$;
revoke all on function public.decide_pos_price_request_v1(uuid,text,text) from public, anon;
grant execute on function public.decide_pos_price_request_v1(uuid,text,text) to authenticated;

create or replace function public.cancel_pos_price_request_v1(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor_id uuid:=auth.uid(); request_record public.pos_price_requests%rowtype;
begin
  select * into request_record from public.pos_price_requests where id=p_request_id for update;
  if request_record.id is null then raise exception using errcode='P0002',message='POS_PRICE_REQUEST_NOT_FOUND'; end if;
  if request_record.seller_user_id<>actor_id or request_record.status<>'pending' then
    raise exception using errcode='42501',message='POS_PRICE_REQUEST_NOT_CANCELLABLE'; end if;
  update public.pos_price_requests set status='cancelled',updated_at=now() where id=p_request_id;
  insert into public.pos_price_request_events(request_id,event_type,actor_user_id,actor_role,from_status,to_status,reason)
    values(p_request_id,'cancelled',actor_id,public.current_actor_role(),'pending','cancelled','Cancelada por el vendedor.');
  return public.build_pos_price_request_payload_v1(p_request_id);
end;
$$;
revoke all on function public.cancel_pos_price_request_v1(uuid) from public, anon;
grant execute on function public.cancel_pos_price_request_v1(uuid) to authenticated;

-- Called only from confirm_pos_sale_v1 after that function has locked the draft,
-- customer and products. It applies approved prices in the same transaction;
-- consumption occurs later as each order line is inserted.
create or replace function public.apply_pos_price_approvals_for_confirmation_v1(
  p_draft_id uuid, p_expected_draft_version bigint, p_approval_ids jsonb
) returns void language plpgsql security definer
set search_path = public, extensions, pg_temp as $$
declare actor_id uuid:=auth.uid(); actor_role text:=public.current_actor_role();
  approval_id uuid; request_record public.pos_price_requests%rowtype;
  item_record public.pos_sale_draft_items%rowtype; product_record public.products%rowtype;
  draft_record public.pos_sale_drafts%rowtype; tax_rate numeric:=0.15;
  calculation_lines jsonb:='[]'::jsonb; calculated jsonb;
begin
  if actor_role<>'vendedor' then return; end if;
  if p_approval_ids is null or jsonb_typeof(p_approval_ids)<>'array'
    or jsonb_array_length(p_approval_ids)>200 then
    raise exception using errcode='22023',message='POS_PRICE_APPROVAL_REQUIRED'; end if;
  select * into draft_record from public.pos_sale_drafts where id=p_draft_id;
  select coalesce(settings.tax_rate,0.15) into tax_rate
    from public.company_settings settings order by settings.created_at limit 1;
  for approval_id in select value::uuid from jsonb_array_elements_text(p_approval_ids) order by value
  loop
    select * into request_record from public.pos_price_requests where id=approval_id for update;
    if request_record.id is null or request_record.status<>'approved' or request_record.expires_at<=now()
      or request_record.seller_user_id<>actor_id or request_record.draft_id<>p_draft_id
      or request_record.customer_id<>draft_record.customer_id
      or request_record.customer_commercial_version<>draft_record.customer_commercial_version then
      raise exception using errcode='PT409',message='POS_PRICE_APPROVAL_INVALID'; end if;
    select * into item_record from public.pos_sale_draft_items
      where draft_id=p_draft_id and product_id=request_record.product_id for update;
    select * into product_record from public.products where id=request_record.product_id;
    if item_record.id is null or item_record.quantity<>request_record.quantity
      or item_record.base_unit_price<>request_record.base_unit_price
      or item_record.product_sales_version<>request_record.product_sales_version
      or product_record.product_sales_version<>request_record.product_sales_version
      or product_record.cost_price is null or product_record.cost_price<=0
      or request_record.requested_unit_price<product_record.cost_price then
      raise exception using errcode='PT409',message='POS_PRICE_APPROVAL_INVALID'; end if;
    if request_record.draft_item_id<>item_record.id or request_record.draft_version<>p_expected_draft_version then
      update public.pos_price_requests set draft_item_id=item_record.id,draft_version=p_expected_draft_version,
        updated_at=now() where id=approval_id;
      insert into public.pos_price_request_events(request_id,event_type,actor_user_id,actor_role,
        from_status,to_status,reason,metadata)
      values(approval_id,'rebound',actor_id,actor_role,'approved','approved',
        'La linea equivalente fue guardada nuevamente sin cambiar las condiciones autorizadas.',
        jsonb_build_object('itemId',item_record.id,'draftVersion',p_expected_draft_version));
    end if;
    update public.pos_sale_draft_items set final_unit_price=request_record.requested_unit_price,
      price_overridden=true,price_override_reason=request_record.reason,
      price_overridden_by=actor_id,price_overridden_at=now(),
      cost_floor_validated=true,cost_validated_at=now(),validation_status='valid',
      line_merchandise_gross=round(quantity*request_record.requested_unit_price,2),
      line_taxable_base=case when tax_category_snapshot='standard' and tax_rate_snapshot>0
        then round(round(quantity*request_record.requested_unit_price,2)/(1+tax_rate_snapshot),2) else 0 end,
      line_tax_amount=case when tax_category_snapshot='standard' and tax_rate_snapshot>0
        then round(quantity*request_record.requested_unit_price,2)-round(round(quantity*request_record.requested_unit_price,2)/(1+tax_rate_snapshot),2) else 0 end,
      line_exempt_amount=case when tax_category_snapshot='exempt' then round(quantity*request_record.requested_unit_price,2) else 0 end
    where id=item_record.id;
  end loop;
  -- Every seller override must be represented in the submitted approval set.
  if exists(select 1 from public.pos_sale_draft_items item where item.draft_id=p_draft_id
    and item.price_overridden and not exists(select 1 from jsonb_array_elements_text(p_approval_ids) value
      join public.pos_price_requests request on request.id=value::uuid
      where request.product_id=item.product_id)) then
    raise exception using errcode='42501',message='POS_PRICE_APPROVAL_REQUIRED'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('product_id',item.product_id,'quantity',item.quantity,
    'unit_price',item.final_unit_price,'tax_category',item.tax_category_snapshot) order by item.product_id),'[]'::jsonb)
    into calculation_lines from public.pos_sale_draft_items item where item.draft_id=p_draft_id;
  calculated:=public.calculate_pos_draft_financials_v2(calculation_lines,tax_rate,
    draft_record.shipping_fee,draft_record.cod_fee,
    round(draft_record.additional_charge+draft_record.other_charge,2),'HNL');
  update public.pos_sale_drafts set
    merchandise_gross=(calculated->>'merchandise_total')::numeric,
    taxable_gross=(calculated->>'taxable_gross')::numeric,
    exempt_gross=(calculated->>'exempt_total')::numeric,
    taxable_base=(calculated->>'taxable_base')::numeric,
    tax_amount=(calculated->>'tax_total')::numeric,
    grand_total=(calculated->>'total')::numeric,
    updated_at=now() where id=p_draft_id;
end;
$$;
revoke all on function public.apply_pos_price_approvals_for_confirmation_v1(uuid,bigint,jsonb)
  from public, anon, authenticated;

create or replace function public.consume_pos_price_approval_on_order_item_v1()
returns trigger language plpgsql security definer set search_path = public as $$
declare actor_id uuid:=auth.uid(); actor_role text:=public.current_actor_role();
  order_record public.orders%rowtype; request_record public.pos_price_requests%rowtype;
begin
  if actor_role<>'vendedor' or new.price_overridden_by is null then return new; end if;
  select * into order_record from public.orders where id=new.order_id;
  select * into request_record from public.pos_price_requests request
    where request.seller_user_id=actor_id and request.draft_id=order_record.pos_draft_id
      and request.product_id=new.product_id and request.quantity=new.quantity
      and request.requested_unit_price=new.unit_price and request.status='approved'
      and request.expires_at>now() order by request.requested_at desc limit 1 for update;
  if request_record.id is null then
    raise exception using errcode='42501',message='POS_PRICE_APPROVAL_INVALID'; end if;
  update public.pos_price_requests set status='consumed',consumed_at=now(),consumed_by=actor_id,
    consumed_order_id=new.order_id,updated_at=now() where id=request_record.id and status='approved';
  if not found then raise exception using errcode='PT409',message='POS_PRICE_APPROVAL_ALREADY_USED'; end if;
  insert into public.pos_price_request_events(request_id,event_type,actor_user_id,actor_role,
    from_status,to_status,reason,metadata)
  values(request_record.id,'consumed',actor_id,actor_role,'approved','consumed',
    'Autorizacion consumida atomicamente al confirmar la venta.',jsonb_build_object('orderId',new.order_id));
  return new;
end;
$$;
drop trigger if exists consume_pos_price_approval_on_order_item on public.order_items;
create trigger consume_pos_price_approval_on_order_item
before insert on public.order_items for each row execute function public.consume_pos_price_approval_on_order_item_v1();
revoke all on function public.consume_pos_price_approval_on_order_item_v1() from public, anon, authenticated;

create or replace function public.invalidate_changed_pos_price_requests_v1()
returns trigger language plpgsql security definer set search_path=public as $$
declare request_record public.pos_price_requests%rowtype;
begin
  if new.status<>'active' then return new; end if;
  for request_record in
    select * from public.pos_price_requests request
    where request.draft_id=new.id and request.status in ('pending','approved')
      and not exists (
        select 1 from public.pos_sale_draft_items item
        where item.draft_id=new.id and item.product_id=request.product_id
          and item.quantity=request.quantity
          and item.base_unit_price=request.base_unit_price
          and item.product_sales_version=request.product_sales_version
          and new.customer_id=request.customer_id
          and new.customer_commercial_version=request.customer_commercial_version
      ) for update
  loop
    update public.pos_price_requests set status='cancelled',updated_at=now()
      where id=request_record.id;
    insert into public.pos_price_request_events(
      request_id,event_type,actor_user_id,actor_role,from_status,to_status,reason
    ) values(request_record.id,'cancelled',auth.uid(),coalesce(public.current_actor_role(),'system'),
      request_record.status,'cancelled','Las condiciones vinculadas de la venta cambiaron.');
  end loop;
  return new;
end;
$$;
drop trigger if exists invalidate_changed_price_requests_on_draft_update on public.pos_sale_drafts;
create trigger invalidate_changed_price_requests_on_draft_update
after update on public.pos_sale_drafts for each row
execute function public.invalidate_changed_pos_price_requests_v1();
revoke all on function public.invalidate_changed_pos_price_requests_v1() from public,anon,authenticated;

-- The canonical confirmation remains intact except for two fail-closed hooks:
-- sellers pass the role gate, and approved prices are applied after the canonical
-- customer lock but before line validation. Abort if upstream source ever drifts.
do $patch_confirmation$
declare definition text; role_marker text; apply_marker text;
begin
  select pg_get_functiondef('public.confirm_pos_sale_v1(uuid,uuid,bigint,date,jsonb)'::regprocedure)
    into definition;
  role_marker:='actor_role not in (''technical_owner'',''business_owner'',''admin'')';
  apply_marker:='  if not exists (select 1 from public.pos_sale_draft_items where draft_id = p_draft_id) then';
  if position(role_marker in definition)=0 or position(apply_marker in definition)=0 then
    raise exception 'PHASE2_CONFIRMATION_PATCH_SOURCE_DRIFT';
  end if;
  definition:=replace(definition,role_marker,
    'actor_role not in (''technical_owner'',''business_owner'',''admin'',''vendedor'')');
  definition:=replace(definition,apply_marker,
    '  perform public.apply_pos_price_approvals_for_confirmation_v1(p_draft_id, p_expected_draft_version, coalesce(p_payment_payload->''price_override_request_ids'', ''[]''::jsonb));'||E'\n'||
    '  select * into draft_record from public.pos_sale_drafts where id = p_draft_id;'||E'\n'||apply_marker);
  execute definition;
end;
$patch_confirmation$;

create or replace function public.list_my_pos_sales_v1(
  p_from date, p_to date, p_status text default null, p_payment_method text default null,
  p_query text default null, p_limit integer default 20, p_offset integer default 0
) returns jsonb language plpgsql security definer
set search_path = public set timezone='America/Tegucigalpa' as $$
declare actor_id uuid:=auth.uid(); result jsonb; range_days integer;
begin
  if actor_id is null or not public.pos_permission_allowed('pos:sales:read_own') then
    raise exception using errcode='42501',message='POS_MY_SALES_FORBIDDEN'; end if;
  if p_from is null or p_to is null or p_to<p_from then
    raise exception using errcode='22023',message='POS_MY_SALES_DATE_INVALID'; end if;
  range_days:=p_to-p_from;
  if range_days>366 then raise exception using errcode='22023',message='POS_MY_SALES_RANGE_TOO_LARGE'; end if;
  with scoped as (
    select order_record.*,
      invoice.id invoice_id,invoice.invoice_number,invoice.status::text invoice_status,
      coalesce((select sum(payment.amount) from public.payments payment
        where payment.order_id=order_record.id and payment.status::text='approved'),0)
      +coalesce(receivable.original_amount-receivable.balance_due,0) collected_amount,
      receivable.balance_due,receivable.status receivable_status
    from public.orders order_record
    left join public.invoices invoice on invoice.order_id=order_record.id
    left join public.accounts_receivable receivable on receivable.order_id=order_record.id
    where order_record.source='pos' and order_record.seller_id=actor_id
      and (order_record.created_at at time zone 'America/Tegucigalpa')::date between p_from and p_to
  ), filtered as (
    select * from scoped sale where
      (nullif(trim(coalesce(p_status,'')),'') is null or sale.status::text=p_status)
      and (nullif(trim(coalesce(p_payment_method,'')),'') is null or sale.payment_method::text=p_payment_method)
      and (nullif(trim(coalesce(p_query,'')),'') is null
        or sale.order_number ilike '%'||trim(p_query)||'%'
        or sale.customer_name ilike '%'||trim(p_query)||'%'
        or sale.invoice_number ilike '%'||trim(p_query)||'%')
  ), page as (
    select * from filtered order by created_at desc,id desc
    limit least(greatest(coalesce(p_limit,20),1),100)
    offset least(greatest(coalesce(p_offset,0),0),10000)
  ) select jsonb_build_object(
    'results',coalesce((select jsonb_agg(jsonb_build_object(
      'orderId',page.id,'orderNumber',page.order_number,'createdAt',page.created_at,
      'customerName',page.customer_name,'total',page.total,
      'paymentMethod',page.payment_method,'status',page.status,
      'invoiceId',page.invoice_id,'invoiceNumber',page.invoice_number,
      'invoiceStatus',page.invoice_status,'collectedAmount',page.collected_amount,
      'balanceDue',coalesce(page.balance_due,0),'receivableStatus',page.receivable_status,
      'sellerName',page.seller_display_name_snapshot
    ) order by page.created_at desc,page.id desc) from page),'[]'::jsonb),
    'total',(select count(*) from filtered),
    'summary',jsonb_build_object(
      'salesCount',(select count(*) from scoped sale where sale.status::text not in ('cancelado','cancelled')),
      'soldAmount',(select coalesce(sum(sale.total),0) from scoped sale where sale.status::text not in ('cancelado','cancelled')),
      'collectedAmount',(select coalesce(sum(sale.collected_amount),0) from scoped sale where sale.status::text not in ('cancelado','cancelled')),
      'pendingAmount',(select coalesce(sum(greatest(sale.total-sale.collected_amount,0)),0) from scoped sale where sale.status::text not in ('cancelado','cancelled')),
      'deliveredCount',(select count(*) from scoped sale where sale.status::text in ('entregado','delivered')),
      'pendingCount',(select count(*) from scoped sale where sale.status::text not in ('entregado','delivered','cancelado','cancelled')),
      'cancelledCount',(select count(*) from scoped sale where sale.status::text in ('cancelado','cancelled'))
    ),'from',p_from,'to',p_to
  ) into result;
  return result;
end;
$$;
revoke all on function public.list_my_pos_sales_v1(date,date,text,text,text,integer,integer) from public, anon;
grant execute on function public.list_my_pos_sales_v1(date,date,text,text,text,integer,integer) to authenticated;

create or replace function public.get_my_pos_sale_detail_v1(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare actor_id uuid:=auth.uid(); result jsonb;
begin
  if actor_id is null or not public.pos_permission_allowed('pos:sales:read_own') then
    raise exception using errcode='42501',message='POS_MY_SALES_FORBIDDEN'; end if;
  select jsonb_build_object(
    'orderId',sale.id,'orderNumber',sale.order_number,'createdAt',sale.created_at,
    'status',sale.status,'customerName',sale.customer_name,'total',sale.total,
    'subtotal',sale.subtotal,'tax',sale.tax,'paymentMethod',sale.payment_method,
    'sellerName',sale.seller_display_name_snapshot,
    'invoice',case when invoice.id is null then null else jsonb_build_object(
      'invoiceId',invoice.id,'invoiceNumber',invoice.invoice_number,'status',invoice.status,
      'issuedAt',invoice.issued_at,'total',invoice.total) end,
    'collection',jsonb_build_object(
      'collectedAmount',coalesce((select sum(payment.amount) from public.payments payment
        where payment.order_id=sale.id and payment.status::text='approved'),0)
        +coalesce(receivable.original_amount-receivable.balance_due,0),
      'balanceDue',coalesce(receivable.balance_due,0),
      'status',coalesce(receivable.status,case when exists(select 1 from public.payments payment
        where payment.order_id=sale.id and payment.status::text='approved') then 'paid' else 'pending' end)),
    'items',coalesce((select jsonb_agg(jsonb_build_object(
      'itemId',item.id,'productId',item.product_id,'sku',item.sku,
      'productName',item.product_name,'quantity',item.quantity,'unitPrice',item.unit_price,
      'lineTotal',item.line_total,'priceAuthorized',item.price_overridden_by is not null
    ) order by item.created_at,item.id) from public.order_items item where item.order_id=sale.id),'[]'::jsonb)
  ) into result
  from public.orders sale
  left join public.invoices invoice on invoice.order_id=sale.id
  left join public.accounts_receivable receivable on receivable.order_id=sale.id
  where sale.id=p_order_id and sale.source='pos' and sale.seller_id=actor_id;
  if result is null then raise exception using errcode='P0002',message='POS_MY_SALE_NOT_FOUND'; end if;
  return result;
end;
$$;
revoke all on function public.get_my_pos_sale_detail_v1(uuid) from public, anon;
grant execute on function public.get_my_pos_sale_detail_v1(uuid) to authenticated;

insert into public.notification_preferences(
  notification_type,module,label,internal_enabled,email_enabled,push_enabled,destination_roles
) values
  ('pos.price_request.created','pedidos','Precio especial solicitado',true,true,true,array['technical_owner','business_owner','admin']),
  ('pos.price_request.approved','pedidos','Precio especial aprobado',true,true,true,array[]::text[]),
  ('pos.price_request.rejected','pedidos','Precio especial rechazado',true,true,true,array[]::text[]),
  ('pos.price_request.revoked','pedidos','Precio especial revocado',true,true,true,array[]::text[])
on conflict (notification_type) do update set
  module=excluded.module,label=excluded.label,updated_at=now();

create or replace function public.save_pos_basic_customer_v1(
  p_request_key uuid, p_customer_id uuid, p_expected_commercial_version integer,
  p_contact_name text, p_phone text, p_email text, p_business_name text,
  p_tax_id text, p_address text, p_city text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare current_customer public.customers%rowtype;
begin
  if not public.pos_permission_allowed('pos:customers:write_basic') then
    raise exception using errcode='42501',message='POS_BASIC_CUSTOMER_FORBIDDEN'; end if;
  if p_customer_id is null then
    return public.create_pos_customer_v1(p_request_key,p_contact_name,p_phone,p_email,
      p_business_name,p_tax_id,p_address,p_city,null);
  end if;
  select * into current_customer from public.customers where id=p_customer_id;
  if current_customer.id is null then raise exception using errcode='P0002',message='POS_CUSTOMER_NOT_FOUND'; end if;
  return public.update_pos_customer_v1(p_request_key,p_customer_id,p_expected_commercial_version,
    p_contact_name,p_phone,p_email,p_business_name,p_tax_id,p_address,p_city,
    current_customer.commercial_notes);
end;
$$;
revoke all on function public.save_pos_basic_customer_v1(uuid,uuid,integer,text,text,text,text,text,text,text) from public,anon;
grant execute on function public.save_pos_basic_customer_v1(uuid,uuid,integer,text,text,text,text,text,text,text) to authenticated;

comment on table public.pos_price_requests is
  'Exact seller/draft/customer/line/product commercial binding for a one-use exceptional POS price.';
comment on table public.pos_price_request_events is
  'Append-only lifecycle for price authorization requests. Approval lasts exactly 30 minutes.';
comment on function public.apply_pos_price_approvals_for_confirmation_v1(uuid,bigint,jsonb) is
  'Internal same-transaction application. Never grants a seller direct price override authority.';

create policy pos_seller_read_own_order
  on public.orders for select
  using (source='pos' and seller_id=auth.uid() and public.has_permission('pos:sales:read_own'));
create policy pos_seller_read_own_invoice
  on public.invoices for select
  using (public.has_permission('pos:sales:read_own') and exists(
    select 1 from public.orders sale where sale.id=invoices.order_id
      and sale.source='pos' and sale.seller_id=auth.uid()));
create policy pos_seller_read_own_invoice_items
  on public.invoice_items for select
  using (public.has_permission('pos:sales:read_own') and exists(
    select 1 from public.invoices invoice join public.orders sale on sale.id=invoice.order_id
    where invoice.id=invoice_items.invoice_id and sale.source='pos' and sale.seller_id=auth.uid()));
create policy pos_seller_read_own_payments
  on public.payments for select
  using (public.has_permission('pos:sales:read_own') and exists(
    select 1 from public.orders sale where sale.id=payments.order_id
      and sale.source='pos' and sale.seller_id=auth.uid()));

commit;
