-- Sales & commercial management Phase 3: seller workspace and immutable
-- commission ledger. This migration is prospective and intentionally performs
-- no historical commission backfill.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- RBAC
-- ---------------------------------------------------------------------------

update public.roles role
set permissions = (
  select coalesce(jsonb_agg(permission order by permission), '[]'::jsonb)
  from (
    select distinct value as permission
    from jsonb_array_elements_text(
      coalesce(role.permissions, '[]'::jsonb)
      || '["sales:seller_dashboard:read_own","commissions:read_own","commissions:read_all","commissions:rules:manage","commissions:adjust"]'::jsonb
    )
  ) allowed
), updated_at = now()
where role.name in ('technical_owner','business_owner','admin');

update public.roles role
set permissions = (
  select coalesce(jsonb_agg(permission order by permission), '[]'::jsonb)
  from (
    select distinct value as permission
    from jsonb_array_elements_text(
      coalesce(role.permissions, '[]'::jsonb)
      || '["sales:seller_dashboard:read_own","commissions:read_own"]'::jsonb
    )
  ) allowed
), updated_at = now()
where role.name = 'vendedor';

create or replace function public.commission_permission_allowed(permission_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
    and permission_key in (
      'sales:seller_dashboard:read_own','commissions:read_own',
      'commissions:read_all','commissions:rules:manage','commissions:adjust'
    )
    and public.current_actor_role() in ('technical_owner','business_owner','admin','vendedor')
    and public.has_permission(permission_key);
$$;
revoke all on function public.commission_permission_allowed(text) from public, anon;
grant execute on function public.commission_permission_allowed(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Durable, versioned model
-- ---------------------------------------------------------------------------

create table public.sales_commission_rules (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  seller_user_id uuid not null references public.users(id) on delete restrict,
  version integer not null check (version > 0),
  rule_type text not null check (rule_type in ('PERCENTAGE','FIXED_AMOUNT')),
  rule_value numeric(14,4) not null check (rule_value > 0),
  effective_from timestamptz not null,
  effective_to timestamptz,
  reason text not null check (char_length(trim(reason)) between 10 and 500),
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint sales_commission_rules_percentage_limit check (
    rule_type <> 'PERCENTAGE' or rule_value <= 100
  ),
  constraint sales_commission_rules_effective_range check (
    effective_to is null or effective_to > effective_from
  ),
  unique (seller_user_id, version)
);

create table public.sales_commission_entries (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  seller_id uuid not null references public.users(id) on delete restrict,
  seller_display_name_snapshot text not null,
  rule_id uuid not null references public.sales_commission_rules(id) on delete restrict,
  rule_version_snapshot integer not null,
  rule_type_snapshot text not null check (rule_type_snapshot in ('PERCENTAGE','FIXED_AMOUNT')),
  rule_value_snapshot numeric(14,4) not null check (rule_value_snapshot > 0),
  eligible_base_amount numeric(14,2) not null check (eligible_base_amount >= 0),
  collectible_sale_total_snapshot numeric(14,2) not null check (collectible_sale_total_snapshot > 0),
  potential_amount numeric(14,2) not null check (potential_amount >= 0),
  system_earned_amount numeric(14,2) not null default 0 check (system_earned_amount >= 0),
  adjustment_net_amount numeric(14,2) not null default 0,
  earned_amount numeric(14,2) not null default 0 check (earned_amount >= 0),
  reversed_amount numeric(14,2) not null default 0 check (reversed_amount >= 0),
  status text not null default 'ACCRUED'
    check (status in ('ACCRUED','PARTIALLY_EARNED','EARNED','VOIDED','REVERSED')),
  attribution_revision integer not null default 1 check (attribution_revision > 0),
  original_entry_id uuid references public.sales_commission_entries(id) on delete restrict,
  superseded_at timestamptz,
  superseded_by_entry_id uuid references public.sales_commission_entries(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sales_commission_entries_amount_bounds check (
    system_earned_amount <= potential_amount
    and earned_amount <= potential_amount
    and earned_amount = round(greatest(least(system_earned_amount + adjustment_net_amount, potential_amount), 0), 2)
  ),
  constraint sales_commission_entries_superseded_shape check (
    (superseded_at is null and superseded_by_entry_id is null)
    or (superseded_at is not null)
  ),
  unique (order_id, attribution_revision)
);

create unique index sales_commission_entries_active_order_idx
  on public.sales_commission_entries(order_id) where superseded_at is null;

create table public.sales_commission_events (
  id bigint generated always as identity primary key,
  commission_entry_id uuid not null references public.sales_commission_entries(id) on delete restrict,
  seller_id uuid not null references public.users(id) on delete restrict,
  event_type text not null check (event_type in (
    'ACCRUAL_CREATED','EARNING_INCREASED','EARNING_REDUCED','VOIDED','REVERSED',
    'MANUAL_ADJUSTMENT','SELLER_REASSIGNMENT_OUT','SELLER_REASSIGNMENT_IN'
  )),
  amount_delta numeric(14,2) not null,
  earned_after numeric(14,2) not null check (earned_after >= 0),
  source_type text not null,
  source_id text,
  reason text,
  actor_user_id uuid references public.users(id) on delete restrict,
  actor_role text not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create index sales_commission_rules_seller_effective_idx
  on public.sales_commission_rules(seller_user_id, effective_from desc, version desc);
create unique index sales_commission_rules_one_open_ended_idx
  on public.sales_commission_rules(seller_user_id) where effective_to is null;
create index sales_commission_entries_seller_date_idx
  on public.sales_commission_entries(seller_id, created_at desc, id desc);
create index sales_commission_entries_seller_status_date_idx
  on public.sales_commission_entries(seller_id, status, created_at desc, id desc);
create index sales_commission_entries_rule_idx
  on public.sales_commission_entries(rule_id, created_at desc);
create index sales_commission_events_entry_date_idx
  on public.sales_commission_events(commission_entry_id, created_at, id);
create index sales_commission_events_seller_date_idx
  on public.sales_commission_events(seller_id, created_at desc, id desc);
create index if not exists orders_source_seller_created_idx
  on public.orders(source, seller_id, created_at desc, id desc) where seller_id is not null;

comment on table public.sales_commission_rules is
  'Immutable, explicit per-seller commission rule versions. No global default.';
comment on table public.sales_commission_entries is
  'Prospective per-sale commission snapshots. Superseded attribution revisions remain durable.';
comment on table public.sales_commission_events is
  'Append-only commission ledger. Payout and settlement are intentionally outside Phase 3.';

alter table public.sales_commission_rules enable row level security;
alter table public.sales_commission_entries enable row level security;
alter table public.sales_commission_events enable row level security;

revoke all on public.sales_commission_rules, public.sales_commission_entries,
  public.sales_commission_events from public, anon, authenticated;
grant select, insert, update on public.sales_commission_rules,
  public.sales_commission_entries to service_role;
grant select, insert on public.sales_commission_events to service_role;

create policy commission_rules_read_elevated
  on public.sales_commission_rules for select
  using (public.commission_permission_allowed('commissions:read_all'));
create policy commission_rules_read_own
  on public.sales_commission_rules for select
  using (seller_user_id = auth.uid() and public.commission_permission_allowed('commissions:read_own'));
create policy commission_entries_read_elevated
  on public.sales_commission_entries for select
  using (public.commission_permission_allowed('commissions:read_all'));
create policy commission_entries_read_own
  on public.sales_commission_entries for select
  using (seller_id = auth.uid() and public.commission_permission_allowed('commissions:read_own'));
create policy commission_events_read_elevated
  on public.sales_commission_events for select
  using (public.commission_permission_allowed('commissions:read_all'));
create policy commission_events_read_own
  on public.sales_commission_events for select
  using (seller_id = auth.uid() and public.commission_permission_allowed('commissions:read_own'));

grant select on public.sales_commission_rules, public.sales_commission_entries,
  public.sales_commission_events to authenticated;

create or replace function public.prevent_commission_ledger_mutation_v1()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_setting('app.commission_internal', true) <> 'on' then
    raise exception using errcode='42501', message='COMMISSION_LEDGER_IMMUTABLE';
  end if;
  if tg_table_name = 'sales_commission_rules' and tg_op = 'UPDATE' then
    if new.seller_user_id is distinct from old.seller_user_id
      or new.version is distinct from old.version
      or new.rule_type is distinct from old.rule_type
      or new.rule_value is distinct from old.rule_value
      or new.effective_from is distinct from old.effective_from
      or new.reason is distinct from old.reason
      or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at
      or old.effective_to is not null
      or new.effective_to is null then
      raise exception using errcode='42501', message='COMMISSION_RULE_IMMUTABLE';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger sales_commission_rules_immutable
before update or delete on public.sales_commission_rules
for each row execute function public.prevent_commission_ledger_mutation_v1();
create trigger sales_commission_entries_guarded
before update or delete on public.sales_commission_entries
for each row execute function public.prevent_commission_ledger_mutation_v1();
create trigger sales_commission_events_append_only
before update or delete on public.sales_commission_events
for each row execute function public.prevent_commission_ledger_mutation_v1();
revoke all on function public.prevent_commission_ledger_mutation_v1() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Authoritative monetary helpers
-- ---------------------------------------------------------------------------

create or replace function public.commission_net_valid_collected_v1(p_order_id uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select round(coalesce(
    case when exists(select 1 from public.accounts_receivable ar where ar.order_id=p_order_id)
      then (select coalesce(sum(arp.amount),0) from public.accounts_receivable_payments arp
        where arp.order_id=p_order_id and arp.voided_at is null)
      else (select coalesce(sum(p.amount),0) from public.payments p
        where p.order_id=p_order_id
          and coalesce(p.payment_status::text,p.status::text) in ('approved','confirmed','paid'))
    end, 0), 2);
$$;
revoke all on function public.commission_net_valid_collected_v1(uuid) from public, anon, authenticated;

create or replace function public.commission_status_v1(
  p_earned numeric, p_potential numeric, p_invalidated boolean default false
) returns text language sql immutable set search_path = public as $$
  select case
    when p_invalidated and p_earned > 0 then 'REVERSED'
    when p_invalidated then 'VOIDED'
    when p_earned <= 0 then 'ACCRUED'
    when p_earned >= p_potential then 'EARNED'
    else 'PARTIALLY_EARNED'
  end;
$$;
revoke all on function public.commission_status_v1(numeric,numeric,boolean) from public, anon, authenticated;

create or replace function public.reconcile_sales_commission_for_order_v1(
  p_order_id uuid, p_source_type text, p_source_id text, p_actor_user_id uuid default null
) returns uuid language plpgsql security definer
set search_path=public set timezone='America/Tegucigalpa' as $$
declare entry_record public.sales_commission_entries%rowtype;
  collected numeric(14,2); target_system numeric(14,2); target_earned numeric(14,2);
  delta numeric(14,2); next_status text; event_type text; key_value text;
begin
  select * into entry_record from public.sales_commission_entries
  where order_id=p_order_id and superseded_at is null for update;
  if entry_record.id is null or entry_record.status in ('VOIDED','REVERSED') then return null; end if;
  collected := least(public.commission_net_valid_collected_v1(p_order_id), entry_record.collectible_sale_total_snapshot);
  target_system := case
    when collected >= entry_record.collectible_sale_total_snapshot then entry_record.potential_amount
    else round(entry_record.potential_amount * collected / entry_record.collectible_sale_total_snapshot, 2)
  end;
  target_earned := round(greatest(least(target_system + entry_record.adjustment_net_amount,
    entry_record.potential_amount),0),2);
  delta := round(target_earned-entry_record.earned_amount,2);
  if delta = 0 and target_system = entry_record.system_earned_amount then return entry_record.id; end if;
  next_status := public.commission_status_v1(target_earned,entry_record.potential_amount,false);
  key_value := 'reconcile:'||p_source_type||':'||coalesce(p_source_id,'none')||':'||p_order_id||':'||target_system;
  event_type := case when delta >= 0 then 'EARNING_INCREASED' else 'EARNING_REDUCED' end;
  perform set_config('app.commission_internal','on',true);
  update public.sales_commission_entries set system_earned_amount=target_system,
    earned_amount=target_earned,status=next_status,updated_at=now() where id=entry_record.id;
  if delta <> 0 then
    insert into public.sales_commission_events(
      commission_entry_id,seller_id,event_type,amount_delta,earned_after,
      source_type,source_id,reason,actor_user_id,actor_role,idempotency_key,metadata
    ) values(entry_record.id,entry_record.seller_id,event_type,delta,target_earned,
      p_source_type,p_source_id,'Conciliacion proporcional con cobros validos.',
      p_actor_user_id,coalesce(public.current_actor_role(),'system'),key_value,
      jsonb_build_object('collectedAmount',collected,'collectibleTotal',entry_record.collectible_sale_total_snapshot,
        'systemEarned',target_system,'adjustmentNet',entry_record.adjustment_net_amount))
    on conflict(idempotency_key) do nothing;
  end if;
  return entry_record.id;
end;
$$;
revoke all on function public.reconcile_sales_commission_for_order_v1(uuid,text,text,uuid)
  from public, anon, authenticated;

create or replace function public.create_commission_for_confirmed_order_v1(
  p_order_id uuid, p_attribution_revision integer default 1,
  p_original_entry_id uuid default null, p_event_type text default 'ACCRUAL_CREATED',
  p_reason text default 'Comision creada al confirmar la venta.'
) returns uuid language plpgsql security definer
set search_path=public set timezone='America/Tegucigalpa' as $$
declare order_record public.orders%rowtype; rule_record public.sales_commission_rules%rowtype;
  existing_id uuid; new_entry_id uuid; eligible_base numeric(14,2); potential numeric(14,2);
begin
  perform pg_advisory_xact_lock(hashtextextended('commission-order:'||p_order_id::text,0));
  select * into order_record from public.orders where id=p_order_id for update;
  if order_record.id is null or order_record.seller_id is null
    or order_record.confirmed_at is null
    or order_record.status::text in ('cancelado','cancelled') then return null; end if;
  select id into existing_id from public.sales_commission_entries
    where order_id=p_order_id and superseded_at is null;
  if existing_id is not null then return existing_id; end if;
  select * into rule_record from public.sales_commission_rules rule
    where rule.seller_user_id=order_record.seller_id
      and rule.effective_from<=order_record.confirmed_at
      and (rule.effective_to is null or order_record.confirmed_at<rule.effective_to)
    order by rule.effective_from desc,rule.version desc limit 1;
  if rule_record.id is null then return null; end if;
  select round(coalesce(sum(coalesce(item.taxable_base_snapshot,0)+coalesce(item.exempt_amount_snapshot,0)),0),2)
    into eligible_base from public.order_items item where item.order_id=p_order_id;
  if eligible_base<=0 or round(coalesce(order_record.total,0),2)<=0 then return null; end if;
  potential := case when rule_record.rule_type='PERCENTAGE'
    then round(eligible_base*rule_record.rule_value/100,2)
    else round(rule_record.rule_value,2) end;
  perform set_config('app.commission_internal','on',true);
  insert into public.sales_commission_entries(
    order_id,seller_id,seller_display_name_snapshot,rule_id,rule_version_snapshot,
    rule_type_snapshot,rule_value_snapshot,eligible_base_amount,
    collectible_sale_total_snapshot,potential_amount,attribution_revision,original_entry_id
  ) values(p_order_id,order_record.seller_id,
    coalesce(order_record.seller_display_name_snapshot,public.pos_actor_display_name_v1(order_record.seller_id),'Vendedor'),
    rule_record.id,rule_record.version,rule_record.rule_type,rule_record.rule_value,
    eligible_base,round(order_record.total,2),potential,p_attribution_revision,p_original_entry_id)
  returning id into new_entry_id;
  insert into public.sales_commission_events(
    commission_entry_id,seller_id,event_type,amount_delta,earned_after,source_type,
    source_id,reason,actor_user_id,actor_role,idempotency_key,metadata
  ) values(new_entry_id,order_record.seller_id,p_event_type,0,0,'order',p_order_id::text,
    p_reason,auth.uid(),coalesce(public.current_actor_role(),'system'),
    'accrual:'||new_entry_id::text,
    jsonb_build_object('eligibleBase',eligible_base,'collectibleTotal',round(order_record.total,2),
      'potential',potential,'ruleVersion',rule_record.version));
  perform public.reconcile_sales_commission_for_order_v1(
    p_order_id,'order_confirmation',p_order_id::text,auth.uid());
  return new_entry_id;
end;
$$;
revoke all on function public.create_commission_for_confirmed_order_v1(uuid,integer,uuid,text,text)
  from public, anon, authenticated;

create or replace function public.invalidate_sales_commission_for_order_v1(
  p_order_id uuid, p_reason text default 'Venta anulada.', p_actor uuid default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare entry_record public.sales_commission_entries%rowtype; event_kind text; key_value text;
begin
  select * into entry_record from public.sales_commission_entries
    where order_id=p_order_id and superseded_at is null for update;
  if entry_record.id is null or entry_record.status in ('VOIDED','REVERSED') then return entry_record.id; end if;
  event_kind:=case when entry_record.earned_amount>0 then 'REVERSED' else 'VOIDED' end;
  key_value:='invalidate:'||p_order_id::text||':'||event_kind;
  perform set_config('app.commission_internal','on',true);
  update public.sales_commission_entries set
    reversed_amount=reversed_amount+earned_amount,system_earned_amount=0,
    adjustment_net_amount=0,earned_amount=0,status=event_kind,updated_at=now()
  where id=entry_record.id;
  insert into public.sales_commission_events(
    commission_entry_id,seller_id,event_type,amount_delta,earned_after,source_type,
    source_id,reason,actor_user_id,actor_role,idempotency_key
  ) values(entry_record.id,entry_record.seller_id,event_kind,-entry_record.earned_amount,0,
    'sale_cancellation',p_order_id::text,p_reason,p_actor,
    coalesce(public.current_actor_role(),'system'),key_value)
  on conflict(idempotency_key) do nothing;
  return entry_record.id;
end;
$$;
revoke all on function public.invalidate_sales_commission_for_order_v1(uuid,text,uuid)
  from public, anon, authenticated;

create or replace function public.reassign_sales_commission_for_order_v1(
  p_order_id uuid, p_reason text, p_actor uuid default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare old_entry public.sales_commission_entries%rowtype; order_record public.orders%rowtype;
  new_id uuid; next_revision integer; reason_value text:=coalesce(nullif(trim(p_reason),''),'Correccion auditada de vendedor.');
begin
  perform pg_advisory_xact_lock(hashtextextended('commission-order:'||p_order_id::text,0));
  select * into order_record from public.orders where id=p_order_id;
  select * into old_entry from public.sales_commission_entries
    where order_id=p_order_id and superseded_at is null for update;
  if old_entry.id is null then
    return public.create_commission_for_confirmed_order_v1(p_order_id,1,null,
      'SELLER_REASSIGNMENT_IN',reason_value);
  end if;
  if old_entry.seller_id=order_record.seller_id then return old_entry.id; end if;
  next_revision:=old_entry.attribution_revision+1;
  perform set_config('app.commission_internal','on',true);
  update public.sales_commission_entries set reversed_amount=reversed_amount+earned_amount,
    system_earned_amount=0,adjustment_net_amount=0,earned_amount=0,
    status=case when earned_amount>0 then 'REVERSED' else 'VOIDED' end,
    superseded_at=now(),updated_at=now() where id=old_entry.id;
  insert into public.sales_commission_events(
    commission_entry_id,seller_id,event_type,amount_delta,earned_after,source_type,
    source_id,reason,actor_user_id,actor_role,idempotency_key,metadata
  ) values(old_entry.id,old_entry.seller_id,'SELLER_REASSIGNMENT_OUT',-old_entry.earned_amount,0,
    'seller_reassignment',p_order_id::text,reason_value,p_actor,
    coalesce(public.current_actor_role(),'system'),
    'seller-reassignment-out:'||old_entry.id::text||':'||next_revision,
    jsonb_build_object('newSellerId',order_record.seller_id));
  new_id:=public.create_commission_for_confirmed_order_v1(p_order_id,next_revision,
    coalesce(old_entry.original_entry_id,old_entry.id),'SELLER_REASSIGNMENT_IN',reason_value);
  if new_id is not null then
    perform set_config('app.commission_internal','on',true);
    update public.sales_commission_entries set superseded_by_entry_id=new_id,updated_at=now()
      where id=old_entry.id;
  end if;
  return new_id;
end;
$$;
revoke all on function public.reassign_sales_commission_for_order_v1(uuid,text,uuid)
  from public, anon, authenticated;

-- Canonical-source triggers keep retries and all supported payment entry points
-- converged on the same target, rather than incrementing balances blindly.
create or replace function public.commission_on_pos_confirmation_v1()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.status='confirmed' and old.status is distinct from new.status and new.order_id is not null then
    perform public.create_commission_for_confirmed_order_v1(new.order_id);
  end if;
  return new;
end;
$$;
create trigger commission_after_pos_confirmation
after update of status on public.pos_sale_drafts for each row
execute function public.commission_on_pos_confirmation_v1();

create or replace function public.commission_on_payment_change_v1()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  perform public.reconcile_sales_commission_for_order_v1(new.order_id,'payment',new.id::text,auth.uid());
  return new;
end;
$$;
create trigger commission_after_payment_insert_or_update
after insert or update of amount,status,payment_status on public.payments for each row
execute function public.commission_on_payment_change_v1();

create or replace function public.commission_on_receivable_payment_change_v1()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  perform public.reconcile_sales_commission_for_order_v1(
    coalesce(new.order_id,old.order_id),'receivable_payment',coalesce(new.id,old.id)::text,auth.uid());
  return new;
end;
$$;
create trigger commission_after_receivable_payment_insert_or_update
after insert or update of amount,voided_at on public.accounts_receivable_payments for each row
execute function public.commission_on_receivable_payment_change_v1();

create or replace function public.commission_on_order_change_v1()
returns trigger language plpgsql security definer set search_path=public as $$
declare correction_reason text;
begin
  if new.status::text in ('cancelado','cancelled')
    and old.status::text not in ('cancelado','cancelled') then
    perform public.invalidate_sales_commission_for_order_v1(new.id,
      coalesce(new.commercial_reversal_reason,'Venta anulada.'),auth.uid());
  elsif new.seller_id is distinct from old.seller_id then
    correction_reason:=current_setting('app.commission_reassignment_reason',true);
    perform public.reassign_sales_commission_for_order_v1(new.id,correction_reason,auth.uid());
  end if;
  return new;
end;
$$;
create trigger commission_after_order_status_or_seller_change
after update of status,seller_id on public.orders for each row
execute function public.commission_on_order_change_v1();

revoke all on function public.commission_on_pos_confirmation_v1(),
  public.commission_on_payment_change_v1(),public.commission_on_receivable_payment_change_v1(),
  public.commission_on_order_change_v1() from public,anon,authenticated;

-- Preserve the Phase 2 correction contract and pass its required reason to the
-- commission trigger in the same transaction. Abort on source drift.
do $patch_seller_correction$
declare definition text; marker text;
begin
  select pg_get_functiondef('public.correct_pos_order_seller_v1(uuid,uuid,text)'::regprocedure)
    into definition;
  marker:='  perform set_config(''app.pos_seller_correction_actor'',actor_id::text,true);';
  if position(marker in definition)=0 then
    raise exception 'PHASE3_SELLER_CORRECTION_PATCH_SOURCE_DRIFT';
  end if;
  definition:=replace(definition,marker,marker||E'\n'||
    '  perform set_config(''app.commission_reassignment_reason'',clean_reason,true);');
  execute definition;
end;
$patch_seller_correction$;

-- ---------------------------------------------------------------------------
-- Controlled mutations
-- ---------------------------------------------------------------------------

create or replace function public.create_sales_commission_rule_v1(
  p_request_key uuid, p_seller_user_id uuid, p_rule_type text,
  p_rule_value numeric, p_effective_date date, p_reason text
) returns jsonb language plpgsql security definer
set search_path=public set timezone='America/Tegucigalpa' as $$
declare actor_id uuid:=auth.uid(); actor_role text:=public.current_actor_role();
  clean_reason text:=nullif(trim(p_reason),''); normalized_type text:=upper(trim(coalesce(p_rule_type,'')));
  today_hn date:=(now() at time zone 'America/Tegucigalpa')::date;
  start_at timestamptz; previous_rule public.sales_commission_rules%rowtype;
  existing_rule public.sales_commission_rules%rowtype; new_rule public.sales_commission_rules%rowtype;
  next_version integer;
begin
  if actor_id is null or actor_role not in ('technical_owner','business_owner','admin')
    or not public.commission_permission_allowed('commissions:rules:manage') then
    raise exception using errcode='42501',message='COMMISSION_ACCESS_DENIED'; end if;
  if p_request_key is null or p_seller_user_id is null or p_effective_date is null
    or normalized_type not in ('PERCENTAGE','FIXED_AMOUNT')
    or p_rule_value is null or p_rule_value<=0
    or (normalized_type='PERCENTAGE' and p_rule_value>100) then
    raise exception using errcode='22023',message='COMMISSION_RULE_INVALID_VALUE'; end if;
  if clean_reason is null or char_length(clean_reason) not between 10 and 500 then
    raise exception using errcode='22023',message='COMMISSION_RULE_REASON_REQUIRED'; end if;
  if p_effective_date<today_hn then
    raise exception using errcode='22023',message='COMMISSION_RULE_EFFECTIVE_DATE_INVALID'; end if;
  if not exists(select 1 from public.users u join public.roles r on r.id=u.role_id
    where u.id=p_seller_user_id and u.active and r.name='vendedor') then
    raise exception using errcode='22023',message='COMMISSION_SELLER_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('commission-rule:'||p_seller_user_id::text,0));
  select * into existing_rule from public.sales_commission_rules where request_key=p_request_key;
  if existing_rule.id is not null then
    if existing_rule.seller_user_id<>p_seller_user_id or existing_rule.rule_type<>normalized_type
      or existing_rule.rule_value<>p_rule_value or existing_rule.reason<>clean_reason then
      raise exception using errcode='PT409',message='COMMISSION_IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('ruleId',existing_rule.id,'version',existing_rule.version,
      'status',case when existing_rule.effective_from>now() then 'SCHEDULED' else 'ACTIVE' end,
      'idempotentReplay',true);
  end if;
  start_at:=case when p_effective_date=today_hn then now()
    else make_timestamptz(extract(year from p_effective_date)::int,
      extract(month from p_effective_date)::int,extract(day from p_effective_date)::int,
      0,0,0,'America/Tegucigalpa') end;
  if exists(select 1 from public.sales_commission_rules
    where seller_user_id=p_seller_user_id and effective_from>now()) then
    raise exception using errcode='PT409',message='COMMISSION_RULE_FUTURE_ALREADY_EXISTS'; end if;
  select * into previous_rule from public.sales_commission_rules
    where seller_user_id=p_seller_user_id and effective_from<start_at
      and (effective_to is null or effective_to>start_at)
    order by effective_from desc limit 1 for update;
  if exists(select 1 from public.sales_commission_rules
    where seller_user_id=p_seller_user_id and effective_from=start_at) then
    raise exception using errcode='PT409',message='COMMISSION_RULE_OVERLAP'; end if;
  select coalesce(max(version),0)+1 into next_version from public.sales_commission_rules
    where seller_user_id=p_seller_user_id;
  if previous_rule.id is not null then
    perform set_config('app.commission_internal','on',true);
    update public.sales_commission_rules set effective_to=start_at where id=previous_rule.id;
  end if;
  insert into public.sales_commission_rules(request_key,seller_user_id,version,rule_type,
    rule_value,effective_from,reason,created_by)
  values(p_request_key,p_seller_user_id,next_version,normalized_type,p_rule_value,start_at,clean_reason,actor_id)
  returning * into new_rule;
  insert into public.internal_notifications(event_type,notification_type,module,user_id,role_name,
    title,message,severity,audience_roles,metadata,dedupe_key)
  values('commission.rule.created','commission.rule.created','sistema',p_seller_user_id,'vendedor',
    'Nueva regla de comision',case when start_at>now()
      then 'Se programo una nueva regla de comision con vigencia desde '||to_char(p_effective_date,'DD/MM/YYYY')||'.'
      else 'Su nueva regla de comision esta vigente.' end,'info',array['vendedor'],
    jsonb_build_object('ruleId',new_rule.id,'version',new_rule.version,'effectiveFrom',new_rule.effective_from),
    'commission-rule:'||new_rule.id::text);
  perform public.write_audit_log('sales_commission_rules',new_rule.id,'commission.rule.created',
    null,jsonb_build_object('seller_id',p_seller_user_id,'version',new_rule.version,
      'rule_type',new_rule.rule_type,'rule_value',new_rule.rule_value,
      'effective_from',new_rule.effective_from,'reason',clean_reason));
  return jsonb_build_object('ruleId',new_rule.id,'version',new_rule.version,
    'status',case when start_at>now() then 'SCHEDULED' else 'ACTIVE' end,
    'effectiveFrom',new_rule.effective_from,'idempotentReplay',false);
end;
$$;
revoke all on function public.create_sales_commission_rule_v1(uuid,uuid,text,numeric,date,text)
  from public,anon;
grant execute on function public.create_sales_commission_rule_v1(uuid,uuid,text,numeric,date,text)
  to authenticated;

create or replace function public.adjust_sales_commission_v1(
  p_request_key uuid, p_entry_id uuid, p_amount_delta numeric, p_reason text
) returns jsonb language plpgsql security definer set search_path=public as $$
declare actor_id uuid:=auth.uid(); actor_role text:=public.current_actor_role();
  entry_record public.sales_commission_entries%rowtype; existing_event public.sales_commission_events%rowtype;
  clean_reason text:=nullif(trim(p_reason),''); delta numeric(14,2):=round(p_amount_delta,2);
  next_earned numeric(14,2); key_value text:='manual-adjustment:'||p_request_key::text;
begin
  if actor_id is null or actor_role not in ('technical_owner','business_owner','admin')
    or not public.commission_permission_allowed('commissions:adjust') then
    raise exception using errcode='42501',message='COMMISSION_ACCESS_DENIED'; end if;
  if p_request_key is null or p_entry_id is null or delta is null or delta=0 then
    raise exception using errcode='22023',message='COMMISSION_ADJUSTMENT_INVALID'; end if;
  if clean_reason is null or char_length(clean_reason) not between 10 and 500 then
    raise exception using errcode='22023',message='COMMISSION_ADJUSTMENT_REASON_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended(key_value,0));
  select * into existing_event from public.sales_commission_events where idempotency_key=key_value;
  if existing_event.id is not null then
    return jsonb_build_object('entryId',existing_event.commission_entry_id,
      'earnedAmount',existing_event.earned_after,'idempotentReplay',true); end if;
  select * into entry_record from public.sales_commission_entries
    where id=p_entry_id and superseded_at is null for update;
  if entry_record.id is null then raise exception using errcode='P0002',message='COMMISSION_NOT_FOUND'; end if;
  if entry_record.status in ('VOIDED','REVERSED') then
    raise exception using errcode='PT409',message='COMMISSION_ADJUSTMENT_INVALID'; end if;
  next_earned:=round(entry_record.earned_amount+delta,2);
  if next_earned<0 or next_earned>entry_record.potential_amount then
    raise exception using errcode='22023',message='COMMISSION_ADJUSTMENT_OUT_OF_RANGE'; end if;
  perform set_config('app.commission_internal','on',true);
  update public.sales_commission_entries set adjustment_net_amount=adjustment_net_amount+delta,
    earned_amount=next_earned,status=public.commission_status_v1(next_earned,potential_amount,false),
    updated_at=now() where id=entry_record.id;
  insert into public.sales_commission_events(commission_entry_id,seller_id,event_type,
    amount_delta,earned_after,source_type,source_id,reason,actor_user_id,actor_role,idempotency_key)
  values(entry_record.id,entry_record.seller_id,'MANUAL_ADJUSTMENT',delta,next_earned,
    'manual_adjustment',p_request_key::text,clean_reason,actor_id,actor_role,key_value);
  insert into public.internal_notifications(event_type,notification_type,module,user_id,role_name,
    title,message,severity,audience_roles,order_id,metadata,dedupe_key)
  values('commission.adjusted','commission.adjusted','sistema',entry_record.seller_id,'vendedor',
    'Comision actualizada','Se registro un ajuste auditado en una de sus comisiones.',
    'info',array['vendedor'],entry_record.order_id,
    jsonb_build_object('entryId',entry_record.id,'amountDelta',delta),key_value);
  perform public.write_audit_log('sales_commission_entries',entry_record.id,'commission.adjusted',
    jsonb_build_object('earned_amount',entry_record.earned_amount),
    jsonb_build_object('earned_amount',next_earned,'amount_delta',delta,'reason',clean_reason));
  return jsonb_build_object('entryId',entry_record.id,'earnedAmount',next_earned,
    'status',public.commission_status_v1(next_earned,entry_record.potential_amount,false),
    'idempotentReplay',false);
end;
$$;
revoke all on function public.adjust_sales_commission_v1(uuid,uuid,numeric,text) from public,anon;
grant execute on function public.adjust_sales_commission_v1(uuid,uuid,numeric,text) to authenticated;

-- ---------------------------------------------------------------------------
-- Bounded read models
-- ---------------------------------------------------------------------------

create or replace function public.commission_rule_json_v1(p_rule_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  select case when rule.id is null then null else jsonb_build_object(
    'ruleId',rule.id,'sellerId',rule.seller_user_id,'version',rule.version,
    'type',rule.rule_type,'value',rule.rule_value,'effectiveFrom',rule.effective_from,
    'effectiveTo',rule.effective_to,'reason',rule.reason,'createdAt',rule.created_at,
    'status',case when rule.effective_from>now() then 'SCHEDULED'
      when rule.effective_to is null or rule.effective_to>now() then 'ACTIVE' else 'FINISHED' end
  ) end from public.sales_commission_rules rule where rule.id=p_rule_id;
$$;
revoke all on function public.commission_rule_json_v1(uuid) from public,anon,authenticated;

create or replace function public.commission_entry_json_v1(p_entry_id uuid, p_include_events boolean default false)
returns jsonb language sql stable security definer set search_path=public as $$
  select case when entry.id is null then null else jsonb_build_object(
    'entryId',entry.id,'orderId',entry.order_id,'sellerId',entry.seller_id,
    'sellerName',entry.seller_display_name_snapshot,'ruleId',entry.rule_id,
    'ruleVersion',entry.rule_version_snapshot,'ruleType',entry.rule_type_snapshot,
    'ruleValue',entry.rule_value_snapshot,'eligibleBase',entry.eligible_base_amount,
    'collectibleTotal',entry.collectible_sale_total_snapshot,'potential',entry.potential_amount,
    'earned',entry.earned_amount,'remaining',greatest(entry.potential_amount-entry.earned_amount,0),
    'reversed',entry.reversed_amount,'status',entry.status,
    'attributionRevision',entry.attribution_revision,'supersededAt',entry.superseded_at,
    'createdAt',entry.created_at,
    'sale',jsonb_build_object('orderNumber',sale.order_number,'confirmedAt',sale.confirmed_at,
      'status',sale.status,'customerName',sale.customer_name,'total',sale.total,
      'specialPriceUsed',exists(select 1 from public.order_items item
        where item.order_id=sale.id and item.price_overridden_by is not null)),
    'collection',jsonb_build_object(
      'collectedAmount',public.commission_net_valid_collected_v1(entry.order_id),
      'ratio',round(least(public.commission_net_valid_collected_v1(entry.order_id)
        / nullif(entry.collectible_sale_total_snapshot,0),1)*100,2)),
    'events',case when p_include_events then coalesce((select jsonb_agg(jsonb_build_object(
      'eventId',event.id,'type',event.event_type,'amountDelta',event.amount_delta,
      'earnedAfter',event.earned_after,'sourceType',event.source_type,'sourceId',event.source_id,
      'reason',event.reason,'createdAt',event.created_at
    ) order by event.created_at,event.id) from public.sales_commission_events event
      where event.commission_entry_id=entry.id),'[]'::jsonb) else '[]'::jsonb end
  ) end
  from public.sales_commission_entries entry
  join public.orders sale on sale.id=entry.order_id where entry.id=p_entry_id;
$$;
revoke all on function public.commission_entry_json_v1(uuid,boolean) from public,anon,authenticated;

create or replace function public.get_my_seller_workspace_v1()
returns jsonb language plpgsql stable security definer
set search_path=public set timezone='America/Tegucigalpa' as $$
declare actor_id uuid:=auth.uid(); actor_name text; today_hn date:=(now() at time zone 'America/Tegucigalpa')::date;
  month_start date:=date_trunc('month',now() at time zone 'America/Tegucigalpa')::date; result jsonb;
begin
  if actor_id is null or public.current_actor_role()<>'vendedor'
    or not public.commission_permission_allowed('sales:seller_dashboard:read_own') then
    raise exception using errcode='42501',message='SELLER_WORKSPACE_ACCESS_DENIED'; end if;
  actor_name:=coalesce(public.pos_actor_display_name_v1(actor_id),'Vendedor');
  with seller_sales as (
    select sale.*,
      public.commission_net_valid_collected_v1(sale.id) collected_amount,
      entry.id commission_entry_id,entry.status commission_status,
      entry.potential_amount,entry.earned_amount,entry.reversed_amount
    from public.orders sale left join public.sales_commission_entries entry
      on entry.order_id=sale.id and entry.superseded_at is null
    where sale.source='pos' and sale.seller_id=actor_id
  ), month_sales as (
    select * from seller_sales where (confirmed_at at time zone 'America/Tegucigalpa')::date>=month_start
  ), current_rule as (
    select id from public.sales_commission_rules where seller_user_id=actor_id
      and effective_from<=now() and (effective_to is null or effective_to>now())
    order by effective_from desc limit 1
  ) select jsonb_build_object(
    'seller',jsonb_build_object('id',actor_id,'name',actor_name),
    'summary',jsonb_build_object(
      'todaySales',(select count(*) from seller_sales where status::text not in ('cancelado','cancelled')
        and (confirmed_at at time zone 'America/Tegucigalpa')::date=today_hn),
      'todaySold',(select coalesce(sum(total),0) from seller_sales where status::text not in ('cancelado','cancelled')
        and (confirmed_at at time zone 'America/Tegucigalpa')::date=today_hn),
      'monthSales',(select count(*) from month_sales where status::text not in ('cancelado','cancelled')),
      'monthSold',(select coalesce(sum(total),0) from month_sales where status::text not in ('cancelado','cancelled')),
      'collected',(select coalesce(sum(collected_amount),0) from month_sales where status::text not in ('cancelado','cancelled')),
      'outstanding',(select coalesce(sum(greatest(total-collected_amount,0)),0) from month_sales where status::text not in ('cancelado','cancelled')),
      'averageTicket',(select coalesce(round(avg(total),2),0) from month_sales where status::text not in ('cancelado','cancelled'))),
    'commission',jsonb_build_object(
      'currentRule',(select public.commission_rule_json_v1(id) from current_rule),
      'potential',(select coalesce(sum(potential_amount),0) from month_sales where commission_entry_id is not null),
      'earned',(select coalesce(sum(earned_amount),0) from month_sales where commission_entry_id is not null),
      'remaining',(select coalesce(sum(greatest(potential_amount-earned_amount,0)),0) from month_sales
        where commission_entry_id is not null and commission_status not in ('VOIDED','REVERSED')),
      'reversed',(select coalesce(sum(reversed_amount),0) from month_sales where commission_entry_id is not null)),
    'drafts',coalesce((select jsonb_agg(jsonb_build_object(
      'draftId',draft.id,'customerName',coalesce(nullif(customer.business_name,''),customer.contact_name),
      'total',draft.grand_total,'itemCount',(select count(*) from public.pos_sale_draft_items item where item.draft_id=draft.id),
      'updatedAt',draft.updated_at,'expiresAt',draft.expires_at
    ) order by draft.updated_at desc) from (select * from public.pos_sale_drafts
      where owner_user_id=actor_id and status='active' and expires_at>now()
      order by updated_at desc limit 3) draft join public.customers customer on customer.id=draft.customer_id),'[]'::jsonb),
    'priceRequests',jsonb_build_object(
      'pending',(select count(*) from public.pos_price_requests where seller_user_id=actor_id and status='pending'),
      'approvedRecently',(select count(*) from public.pos_price_requests where seller_user_id=actor_id
        and status in ('approved','consumed') and requested_at>=now()-interval '30 days'),
      'rejectedRecently',(select count(*) from public.pos_price_requests where seller_user_id=actor_id
        and status='rejected' and requested_at>=now()-interval '30 days'),
      'recent',coalesce((select jsonb_agg(jsonb_build_object('requestId',request.id,
        'productName',request.product_name_snapshot,'sku',request.sku_snapshot,
        'basePrice',request.base_unit_price,'requestedPrice',request.requested_unit_price,
        'status',case when request.status='approved' and request.expires_at<=now() then 'expired' else request.status end,
        'requestedAt',request.requested_at) order by request.requested_at desc)
        from (select * from public.pos_price_requests where seller_user_id=actor_id
          order by requested_at desc limit 3) request),'[]'::jsonb)),
    'recentSales',coalesce((select jsonb_agg(jsonb_build_object(
      'orderId',sale.id,'orderNumber',sale.order_number,'confirmedAt',sale.confirmed_at,
      'customerName',sale.customer_name,'total',sale.total,'status',sale.status,
      'collectedAmount',sale.collected_amount,'commissionStatus',sale.commission_status,
      'commissionEarned',sale.earned_amount
    ) order by sale.confirmed_at desc,sale.id desc) from (select * from seller_sales
      order by confirmed_at desc,id desc limit 5) sale),'[]'::jsonb)
  ) into result;
  return result;
end;
$$;
revoke all on function public.get_my_seller_workspace_v1() from public,anon;
grant execute on function public.get_my_seller_workspace_v1() to authenticated;

create or replace function public.list_my_sales_commissions_v1(
  p_from date,p_to date,p_status text default null,p_query text default null,
  p_limit integer default 20,p_offset integer default 0
) returns jsonb language plpgsql stable security definer
set search_path=public set timezone='America/Tegucigalpa' as $$
declare actor_id uuid:=auth.uid(); result jsonb;
begin
  if actor_id is null or not public.commission_permission_allowed('commissions:read_own') then
    raise exception using errcode='42501',message='SELLER_COMMISSION_ACCESS_DENIED'; end if;
  if p_from is null or p_to is null or p_to<p_from or p_to-p_from>366 then
    raise exception using errcode='22023',message='COMMISSION_DATE_RANGE_INVALID'; end if;
  with filtered as (
    select entry.id,entry.created_at from public.sales_commission_entries entry
    join public.orders sale on sale.id=entry.order_id
    where entry.seller_id=actor_id
      and (sale.confirmed_at at time zone 'America/Tegucigalpa')::date between p_from and p_to
      and (nullif(trim(coalesce(p_status,'')),'') is null or entry.status=p_status)
      and (nullif(trim(coalesce(p_query,'')),'') is null or sale.order_number ilike '%'||trim(p_query)||'%'
        or sale.customer_name ilike '%'||trim(p_query)||'%')
  ), page as (select * from filtered order by created_at desc,id desc
    limit least(greatest(coalesce(p_limit,20),1),50) offset least(greatest(coalesce(p_offset,0),0),10000))
  select jsonb_build_object(
    'results',coalesce((select jsonb_agg(public.commission_entry_json_v1(id,false)
      order by created_at desc,id desc) from page),'[]'::jsonb),
    'total',(select count(*) from filtered),
    'summary',jsonb_build_object(
      'potential',coalesce((select sum(entry.potential_amount) from public.sales_commission_entries entry
        join filtered on filtered.id=entry.id),0),
      'earned',coalesce((select sum(entry.earned_amount) from public.sales_commission_entries entry
        join filtered on filtered.id=entry.id),0),
      'remaining',coalesce((select sum(case when entry.status in ('VOIDED','REVERSED') then 0
        else greatest(entry.potential_amount-entry.earned_amount,0) end)
        from public.sales_commission_entries entry join filtered on filtered.id=entry.id),0),
      'reversed',coalesce((select sum(entry.reversed_amount) from public.sales_commission_entries entry
        join filtered on filtered.id=entry.id),0)),
    'currentRule',(select public.commission_rule_json_v1(rule.id) from public.sales_commission_rules rule
      where rule.seller_user_id=actor_id and rule.effective_from<=now()
        and (rule.effective_to is null or rule.effective_to>now()) order by rule.effective_from desc limit 1)
  ) into result;
  return result;
end;
$$;
revoke all on function public.list_my_sales_commissions_v1(date,date,text,text,integer,integer) from public,anon;
grant execute on function public.list_my_sales_commissions_v1(date,date,text,text,integer,integer) to authenticated;

create or replace function public.get_my_sales_commission_v1(p_entry_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare actor_id uuid:=auth.uid(); result jsonb;
begin
  if actor_id is null or not public.commission_permission_allowed('commissions:read_own') then
    raise exception using errcode='42501',message='SELLER_COMMISSION_ACCESS_DENIED'; end if;
  if not exists(select 1 from public.sales_commission_entries where id=p_entry_id and seller_id=actor_id) then
    raise exception using errcode='P0002',message='COMMISSION_NOT_FOUND'; end if;
  result:=public.commission_entry_json_v1(p_entry_id,true); return result;
end;
$$;
revoke all on function public.get_my_sales_commission_v1(uuid) from public,anon;
grant execute on function public.get_my_sales_commission_v1(uuid) to authenticated;

create or replace function public.list_sales_commissions_v1(
  p_seller_id uuid default null,p_status text default null,p_rule_type text default null,
  p_from date default null,p_to date default null,p_query text default null,
  p_sort text default 'newest',p_limit integer default 20,p_offset integer default 0
) returns jsonb language plpgsql stable security definer
set search_path=public set timezone='America/Tegucigalpa' as $$
declare result jsonb; from_date date:=coalesce(p_from,date_trunc('month',now() at time zone 'America/Tegucigalpa')::date);
  to_date date:=coalesce(p_to,(now() at time zone 'America/Tegucigalpa')::date);
begin
  if not public.commission_permission_allowed('commissions:read_all')
    or public.current_actor_role() not in ('technical_owner','business_owner','admin') then
    raise exception using errcode='42501',message='COMMISSION_ACCESS_DENIED'; end if;
  if to_date<from_date or to_date-from_date>366 or p_sort not in ('newest','oldest') then
    raise exception using errcode='22023',message='COMMISSION_DATE_RANGE_INVALID'; end if;
  with filtered as (
    select entry.id,entry.created_at from public.sales_commission_entries entry
    join public.orders sale on sale.id=entry.order_id
    where (sale.confirmed_at at time zone 'America/Tegucigalpa')::date between from_date and to_date
      and (p_seller_id is null or entry.seller_id=p_seller_id)
      and (nullif(trim(coalesce(p_status,'')),'') is null or entry.status=p_status)
      and (nullif(trim(coalesce(p_rule_type,'')),'') is null or entry.rule_type_snapshot=p_rule_type)
      and (nullif(trim(coalesce(p_query,'')),'') is null
        or sale.order_number ilike '%'||trim(p_query)||'%'
        or sale.customer_name ilike '%'||trim(p_query)||'%'
        or entry.seller_display_name_snapshot ilike '%'||trim(p_query)||'%')
  ), page as (select * from filtered
    order by case when p_sort='newest' then created_at end desc,
      case when p_sort='oldest' then created_at end asc,id desc
    limit least(greatest(coalesce(p_limit,20),1),50)
    offset least(greatest(coalesce(p_offset,0),0),10000))
  select jsonb_build_object(
    'results',coalesce((select jsonb_agg(public.commission_entry_json_v1(id,false)
      order by case when p_sort='newest' then created_at end desc,
        case when p_sort='oldest' then created_at end asc,id desc) from page),'[]'::jsonb),
    'total',(select count(*) from filtered),
    'summary',jsonb_build_object(
      'potential',coalesce((select sum(entry.potential_amount) from public.sales_commission_entries entry
        join filtered on filtered.id=entry.id),0),
      'earned',coalesce((select sum(entry.earned_amount) from public.sales_commission_entries entry
        join filtered on filtered.id=entry.id),0),
      'remaining',coalesce((select sum(case when entry.status in ('VOIDED','REVERSED') then 0
        else greatest(entry.potential_amount-entry.earned_amount,0) end)
        from public.sales_commission_entries entry join filtered on filtered.id=entry.id),0),
      'reversed',coalesce((select sum(entry.reversed_amount) from public.sales_commission_entries entry
        join filtered on filtered.id=entry.id),0)),
    'from',from_date,'to',to_date
  ) into result;
  return result;
end;
$$;
revoke all on function public.list_sales_commissions_v1(uuid,text,text,date,date,text,text,integer,integer)
  from public,anon;
grant execute on function public.list_sales_commissions_v1(uuid,text,text,date,date,text,text,integer,integer)
  to authenticated;

create or replace function public.get_sales_commission_detail_v1(p_entry_id uuid)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare entry_record public.sales_commission_entries%rowtype; result jsonb;
begin
  if not public.commission_permission_allowed('commissions:read_all')
    or public.current_actor_role() not in ('technical_owner','business_owner','admin') then
    raise exception using errcode='42501',message='COMMISSION_ACCESS_DENIED'; end if;
  select * into entry_record from public.sales_commission_entries where id=p_entry_id;
  if entry_record.id is null then raise exception using errcode='P0002',message='COMMISSION_NOT_FOUND'; end if;
  result:=public.commission_entry_json_v1(p_entry_id,true)||jsonb_build_object(
    'rule',public.commission_rule_json_v1(entry_record.rule_id),
    'payments',case when exists(select 1 from public.accounts_receivable ar where ar.order_id=entry_record.order_id)
      then coalesce((select jsonb_agg(jsonb_build_object('paymentId',payment.id,
        'amount',payment.amount,'method',payment.payment_method,'receivedAt',payment.received_at,
        'voidedAt',payment.voided_at) order by payment.received_at,payment.id)
        from public.accounts_receivable_payments payment where payment.order_id=entry_record.order_id),'[]'::jsonb)
      else coalesce((select jsonb_agg(jsonb_build_object('paymentId',payment.id,
        'amount',payment.amount,'method',payment.payment_method,'receivedAt',payment.paid_at,
        'status',coalesce(payment.payment_status::text,payment.status::text)) order by payment.created_at,payment.id)
        from public.payments payment where payment.order_id=entry_record.order_id),'[]'::jsonb) end);
  return result;
end;
$$;
revoke all on function public.get_sales_commission_detail_v1(uuid) from public,anon;
grant execute on function public.get_sales_commission_detail_v1(uuid) to authenticated;

create or replace function public.list_commission_sellers_v1(
  p_query text default null,p_active text default 'all',p_limit integer default 20,p_offset integer default 0
) returns jsonb language plpgsql stable security definer
set search_path=public set timezone='America/Tegucigalpa' as $$
declare result jsonb; month_start date:=date_trunc('month',now() at time zone 'America/Tegucigalpa')::date;
begin
  if not public.commission_permission_allowed('commissions:read_all')
    or public.current_actor_role() not in ('technical_owner','business_owner','admin') then
    raise exception using errcode='42501',message='COMMISSION_ACCESS_DENIED'; end if;
  if p_active not in ('all','active','inactive') then
    raise exception using errcode='22023',message='COMMISSION_SELLER_FILTER_INVALID'; end if;
  with sellers as (
    select user_record.id,coalesce(nullif(trim(user_record.full_name),''),
      nullif(trim(user_record.username),''),split_part(user_record.email,'@',1),'Vendedor') name,
      user_record.email,user_record.phone,user_record.avatar_url,user_record.active,user_record.created_at
    from public.users user_record join public.roles role on role.id=user_record.role_id
    where role.name='vendedor'
      and (p_active='all' or (p_active='active' and user_record.active)
        or (p_active='inactive' and not user_record.active))
      and (nullif(trim(coalesce(p_query,'')),'') is null
        or user_record.full_name ilike '%'||trim(p_query)||'%'
        or user_record.email ilike '%'||trim(p_query)||'%')
  ), sales as (
    select sale.seller_id,count(*) filter(where sale.status::text not in ('cancelado','cancelled')) sales_count,
      coalesce(sum(sale.total) filter(where sale.status::text not in ('cancelado','cancelled')),0) sold,
      count(*) filter(where sale.status::text in ('cancelado','cancelled')) cancelled
    from public.orders sale where sale.source='pos'
      and (sale.confirmed_at at time zone 'America/Tegucigalpa')::date>=month_start group by sale.seller_id
  ), commissions as (
    select entry.seller_id,coalesce(sum(entry.potential_amount),0) potential,
      coalesce(sum(entry.earned_amount),0) earned,coalesce(sum(entry.reversed_amount),0) reversed
    from public.sales_commission_entries entry join public.orders sale on sale.id=entry.order_id
    where (sale.confirmed_at at time zone 'America/Tegucigalpa')::date>=month_start group by entry.seller_id
  ), rows as (
    select sellers.*,coalesce(sales.sales_count,0) sales_count,coalesce(sales.sold,0) sold,
      coalesce(sales.cancelled,0) cancelled,coalesce(commissions.potential,0) potential,
      coalesce(commissions.earned,0) earned,coalesce(commissions.reversed,0) reversed
    from sellers left join sales on sales.seller_id=sellers.id
    left join commissions on commissions.seller_id=sellers.id
  ), page as (select * from rows order by active desc,sales_count desc,name,id
    limit least(greatest(coalesce(p_limit,20),1),50) offset least(greatest(coalesce(p_offset,0),0),10000))
  select jsonb_build_object('results',coalesce((select jsonb_agg(jsonb_build_object(
    'sellerId',page.id,'name',page.name,'email',page.email,'phone',page.phone,
    'avatarUrl',page.avatar_url,'active',page.active,'sellerSince',page.created_at,
    'salesCount',page.sales_count,'sold',page.sold,'cancelled',page.cancelled,
    'potential',page.potential,'earned',page.earned,'remaining',greatest(page.potential-page.earned,0),
    'reversed',page.reversed) order by page.active desc,page.sales_count desc,page.name) from page),'[]'::jsonb),
    'total',(select count(*) from rows)) into result;
  return result;
end;
$$;
revoke all on function public.list_commission_sellers_v1(text,text,integer,integer) from public,anon;
grant execute on function public.list_commission_sellers_v1(text,text,integer,integer) to authenticated;

create or replace function public.get_seller_commercial_profile_v1(p_seller_id uuid)
returns jsonb language plpgsql stable security definer
set search_path=public set timezone='America/Tegucigalpa' as $$
declare result jsonb; month_start date:=date_trunc('month',now() at time zone 'America/Tegucigalpa')::date;
begin
  if not public.commission_permission_allowed('commissions:read_all')
    or public.current_actor_role() not in ('technical_owner','business_owner','admin') then
    raise exception using errcode='42501',message='COMMISSION_ACCESS_DENIED'; end if;
  if not exists(select 1 from public.users u join public.roles r on r.id=u.role_id
    where u.id=p_seller_id and r.name='vendedor') then
    raise exception using errcode='P0002',message='COMMISSION_SELLER_NOT_FOUND'; end if;
  with seller_sales as (
    select sale.*,public.commission_net_valid_collected_v1(sale.id) collected
    from public.orders sale where sale.source='pos' and sale.seller_id=p_seller_id
      and (sale.confirmed_at at time zone 'America/Tegucigalpa')::date>=month_start
  ), seller_commissions as (
    select entry.* from public.sales_commission_entries entry join public.orders sale on sale.id=entry.order_id
    where entry.seller_id=p_seller_id
      and (sale.confirmed_at at time zone 'America/Tegucigalpa')::date>=month_start
  ) select jsonb_build_object(
    'seller',jsonb_build_object('sellerId',u.id,'name',coalesce(nullif(trim(u.full_name),''),
      nullif(trim(u.username),''),split_part(u.email,'@',1),'Vendedor'),'email',u.email,
      'phone',u.phone,'avatarUrl',u.avatar_url,'active',u.active,'sellerSince',u.created_at),
    'metrics',jsonb_build_object(
      'sales',(select count(*) from seller_sales where status::text not in ('cancelado','cancelled')),
      'sold',(select coalesce(sum(total),0) from seller_sales where status::text not in ('cancelado','cancelled')),
      'collected',(select coalesce(sum(collected),0) from seller_sales where status::text not in ('cancelado','cancelled')),
      'outstanding',(select coalesce(sum(greatest(total-collected,0)),0) from seller_sales where status::text not in ('cancelado','cancelled')),
      'averageTicket',(select coalesce(round(avg(total),2),0) from seller_sales where status::text not in ('cancelado','cancelled')),
      'cancelled',(select count(*) from seller_sales where status::text in ('cancelado','cancelled'))),
    'commission',jsonb_build_object(
      'potential',(select coalesce(sum(potential_amount),0) from seller_commissions),
      'earned',(select coalesce(sum(earned_amount),0) from seller_commissions),
      'remaining',(select coalesce(sum(case when status in ('VOIDED','REVERSED') then 0
        else greatest(potential_amount-earned_amount,0) end),0) from seller_commissions),
      'reversed',(select coalesce(sum(reversed_amount),0) from seller_commissions)),
    'currentRule',(select public.commission_rule_json_v1(rule.id) from public.sales_commission_rules rule
      where rule.seller_user_id=p_seller_id and rule.effective_from<=now()
        and (rule.effective_to is null or rule.effective_to>now()) order by effective_from desc limit 1),
    'scheduledRule',(select public.commission_rule_json_v1(rule.id) from public.sales_commission_rules rule
      where rule.seller_user_id=p_seller_id and rule.effective_from>now() order by effective_from limit 1),
    'ruleHistory',coalesce((select jsonb_agg(public.commission_rule_json_v1(rule.id)
      order by rule.effective_from desc) from (select id,effective_from from public.sales_commission_rules
        where seller_user_id=p_seller_id order by effective_from desc limit 5) rule),'[]'::jsonb),
    'priceRequests',jsonb_build_object(
      'total',(select count(*) from public.pos_price_requests where seller_user_id=p_seller_id),
      'approved',(select count(*) from public.pos_price_requests where seller_user_id=p_seller_id and status in ('approved','consumed')),
      'rejected',(select count(*) from public.pos_price_requests where seller_user_id=p_seller_id and status='rejected'),
      'expiredOrCancelled',(select count(*) from public.pos_price_requests where seller_user_id=p_seller_id and status in ('expired','cancelled','revoked'))),
    'recentSales',coalesce((select jsonb_agg(jsonb_build_object('orderId',sale.id,
      'orderNumber',sale.order_number,'customerName',sale.customer_name,'total',sale.total,
      'status',sale.status,'confirmedAt',sale.confirmed_at,'collectedAmount',sale.collected)
      order by sale.confirmed_at desc,sale.id desc) from (select * from seller_sales
        order by confirmed_at desc,id desc limit 5) sale),'[]'::jsonb),
    'recentActivity',coalesce((select jsonb_agg(jsonb_build_object('eventId',event.id,
      'type',event.event_type,'amountDelta',event.amount_delta,'createdAt',event.created_at,
      'orderId',entry.order_id) order by event.created_at desc,event.id desc)
      from (select * from public.sales_commission_events where seller_id=p_seller_id
        order by created_at desc,id desc limit 6) event
      join public.sales_commission_entries entry on entry.id=event.commission_entry_id),'[]'::jsonb)
  ) into result from public.users u where u.id=p_seller_id;
  return result;
end;
$$;
revoke all on function public.get_seller_commercial_profile_v1(uuid) from public,anon;
grant execute on function public.get_seller_commercial_profile_v1(uuid) to authenticated;

create or replace function public.search_seller_products_v1(
  p_query text default '',p_limit integer default 15,p_offset integer default 0
) returns jsonb language plpgsql stable security definer set search_path=public as $$
declare normalized_query text:=lower(trim(regexp_replace(coalesce(p_query,''),'\s+',' ','g'))); result jsonb;
begin
  if auth.uid() is null or public.current_actor_role()<>'vendedor'
    or not public.pos_permission_allowed('pos:products:search') then
    raise exception using errcode='42501',message='SELLER_PRODUCT_ACCESS_DENIED'; end if;
  if char_length(normalized_query)>120 then
    raise exception using errcode='22023',message='SELLER_PRODUCT_QUERY_INVALID'; end if;
  with matched as (
    select product.id,product.sku,product.internal_code,product.name,product.brand,
      product.retail_price authorized_price,product.tracks_inventory,
      case when product.tracks_inventory then product.available_stock else null end available_stock,
      image.public_url image_url,
      case when normalized_query<>'' and lower(product.sku)=normalized_query then 1
        when normalized_query<>'' and lower(coalesce(product.internal_code,''))=normalized_query then 2
        when normalized_query<>'' and lower(product.name)=normalized_query then 3 else 10 end rank
    from public.products product left join lateral(select public_url from public.product_images
      where product_id=product.id order by is_primary desc,sort_order,created_at limit 1) image on true
    where product.active and product.status::text='active'
      and (normalized_query='' or lower(product.sku) like '%'||normalized_query||'%'
        or lower(coalesce(product.internal_code,'')) like '%'||normalized_query||'%'
        or lower(product.name) like '%'||normalized_query||'%'
        or lower(product.brand) like '%'||normalized_query||'%')
  ), page as (select * from matched order by rank,name,id
    limit least(greatest(coalesce(p_limit,15),1),20) offset least(greatest(coalesce(p_offset,0),0),10000))
  select jsonb_build_object('results',coalesce((select jsonb_agg(jsonb_build_object(
    'productId',page.id,'sku',page.sku,'internalCode',page.internal_code,'name',page.name,
    'brand',page.brand,'authorizedPrice',page.authorized_price,'tracksInventory',page.tracks_inventory,
    'availableStock',page.available_stock,'imageUrl',page.image_url) order by page.rank,page.name,page.id)
    from page),'[]'::jsonb),'total',(select count(*) from matched)) into result;
  return result;
end;
$$;
revoke all on function public.search_seller_products_v1(text,integer,integer) from public,anon;
grant execute on function public.search_seller_products_v1(text,integer,integer) to authenticated;

create or replace function public.get_my_commissions_for_orders_v1(p_order_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare actor_id uuid:=auth.uid(); normalized_ids uuid[]; result jsonb;
begin
  if actor_id is null or not public.commission_permission_allowed('commissions:read_own') then
    raise exception using errcode='42501',message='SELLER_COMMISSION_ACCESS_DENIED'; end if;
  select coalesce(array_agg(distinct value order by value),array[]::uuid[]) into normalized_ids
    from unnest(coalesce(p_order_ids,array[]::uuid[])) value where value is not null;
  if cardinality(normalized_ids)>50 then
    raise exception using errcode='22023',message='COMMISSION_ORDER_QUERY_INVALID'; end if;
  select coalesce(jsonb_object_agg(entry.order_id::text,jsonb_build_object(
    'entryId',entry.id,'status',entry.status,'potential',entry.potential_amount,
    'earned',entry.earned_amount,'remaining',case when entry.status in ('VOIDED','REVERSED') then 0
      else greatest(entry.potential_amount-entry.earned_amount,0) end,
    'reversed',entry.reversed_amount)), '{}'::jsonb) into result
  from public.sales_commission_entries entry
  where entry.order_id=any(normalized_ids) and entry.seller_id=actor_id and entry.superseded_at is null;
  return result;
end;
$$;
revoke all on function public.get_my_commissions_for_orders_v1(uuid[]) from public,anon;
grant execute on function public.get_my_commissions_for_orders_v1(uuid[]) to authenticated;

insert into public.notification_preferences(
  notification_type,module,label,internal_enabled,email_enabled,push_enabled,destination_roles
) values
  ('commission.rule.created','sistema','Nueva regla de comision',true,false,true,array[]::text[]),
  ('commission.adjusted','sistema','Ajuste de comision',true,false,true,array[]::text[])
on conflict(notification_type) do update set label=excluded.label,updated_at=now();

commit;
