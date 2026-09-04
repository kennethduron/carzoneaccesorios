-- Phase 4: reusable commission policies, atomic bulk assignment and audited
-- server-authoritative commercial reporting. Additive only; no historical
-- commission or seller backfill is performed.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

update public.roles role
set permissions = (
  select coalesce(jsonb_agg(value order by value), '[]'::jsonb)
  from (select distinct value from jsonb_array_elements_text(coalesce(role.permissions,'[]'::jsonb)
    || '["commissions:policies:manage","commercial:reports:read","commercial:reports:generate"]'::jsonb)) permission
), updated_at = now()
where role.name in ('technical_owner','business_owner','admin');

create or replace function public.commercial_phase4_permission_allowed(permission_key text)
returns boolean language sql stable security definer set search_path=public as $$
  select auth.uid() is not null
    and public.current_actor_role() in ('technical_owner','business_owner','admin')
    and permission_key in ('commissions:policies:manage','commercial:reports:read','commercial:reports:generate')
    and public.has_permission(permission_key)
$$;
revoke all on function public.commercial_phase4_permission_allowed(text) from public,anon;
grant execute on function public.commercial_phase4_permission_allowed(text) to authenticated;

create table public.sales_commission_policies (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  name text not null check (char_length(trim(name)) between 3 and 100),
  rule_type text not null check (rule_type in ('PERCENTAGE','FIXED_AMOUNT')),
  rule_value numeric(14,4) not null check (rule_value > 0),
  base_contract text not null default 'ELIGIBLE_MERCHANDISE_BEFORE_TAX'
    check (base_contract = 'ELIGIBLE_MERCHANDISE_BEFORE_TAX'),
  conditions jsonb not null default '{}'::jsonb check (jsonb_typeof(conditions)='object'),
  description text not null default '' check (char_length(description) <= 500),
  active boolean not null default true,
  duplicated_from uuid references public.sales_commission_policies(id) on delete restrict,
  created_by uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  deactivated_by uuid references public.users(id) on delete restrict,
  deactivated_at timestamptz,
  deactivation_reason text,
  constraint sales_commission_policy_percentage_limit check (rule_type <> 'PERCENTAGE' or rule_value <= 100),
  constraint sales_commission_policy_deactivation_shape check (
    (active and deactivated_by is null and deactivated_at is null and deactivation_reason is null)
    or (not active and deactivated_by is not null and deactivated_at is not null
      and char_length(trim(deactivation_reason)) between 10 and 500)
  )
);

create table public.sales_commission_policy_events (
  id bigint generated always as identity primary key,
  policy_id uuid not null references public.sales_commission_policies(id) on delete restrict,
  event_type text not null check (event_type in ('CREATED','DUPLICATED','DEACTIVATED','BULK_ASSIGNED')),
  actor_user_id uuid not null references public.users(id) on delete restrict,
  reason text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create table public.sales_commission_assignment_operations (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  policy_id uuid not null references public.sales_commission_policies(id) on delete restrict,
  effective_date date not null,
  reason text not null check (char_length(trim(reason)) between 10 and 500),
  preview_token text not null check (preview_token ~ '^[0-9a-f]{64}$'),
  selected_count integer not null check (selected_count between 1 and 50),
  created_count integer not null check (created_count >= 0),
  no_op_count integer not null check (no_op_count >= 0),
  actor_user_id uuid not null references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint sales_commission_assignment_counts check (created_count + no_op_count = selected_count)
);

create table public.sales_commission_assignment_items (
  id bigint generated always as identity primary key,
  operation_id uuid not null references public.sales_commission_assignment_operations(id) on delete restrict,
  seller_user_id uuid not null references public.users(id) on delete restrict,
  outcome text not null check (outcome in ('CREATED','NO_OP')),
  previous_rule_id uuid references public.sales_commission_rules(id) on delete restrict,
  created_rule_id uuid references public.sales_commission_rules(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique(operation_id,seller_user_id)
);

alter table public.sales_commission_rules
  add column policy_id uuid references public.sales_commission_policies(id) on delete restrict,
  add column assignment_operation_id uuid references public.sales_commission_assignment_operations(id) on delete restrict;

create index sales_commission_policies_active_created_idx on public.sales_commission_policies(active,created_at desc,id);
create index sales_commission_policy_events_policy_idx on public.sales_commission_policy_events(policy_id,created_at,id);
create index sales_commission_assignment_policy_idx on public.sales_commission_assignment_operations(policy_id,created_at desc,id);
create index sales_commission_assignment_seller_idx on public.sales_commission_assignment_items(seller_user_id,created_at desc,id);
create index sales_commission_rules_policy_idx on public.sales_commission_rules(policy_id,effective_from desc) where policy_id is not null;

create table public.commercial_report_configurations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete restrict,
  name text not null check (char_length(trim(name)) between 3 and 100),
  report_type text not null check (report_type in ('SELLER_SALES','COMMISSIONS','SPECIAL_PRICES','OUTSTANDING_SALES','CUSTOMER_TYPES','PAYMENT_METHODS','COMMERCIAL_SUMMARY')),
  format text not null check (format in ('PDF','XLSX')),
  normalized_filters jsonb not null check (jsonb_typeof(normalized_filters)='object'),
  included_sections jsonb not null default '[]'::jsonb check (jsonb_typeof(included_sections)='array'),
  included_columns jsonb not null default '[]'::jsonb check (jsonb_typeof(included_columns)='array'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_user_id,name)
);

create table public.commercial_report_generations (
  id uuid primary key default gen_random_uuid(),
  request_key uuid not null unique,
  actor_user_id uuid not null references public.users(id) on delete restrict,
  configuration_id uuid references public.commercial_report_configurations(id) on delete set null,
  report_type text not null check (report_type in ('SELLER_SALES','COMMISSIONS','SPECIAL_PRICES','OUTSTANDING_SALES','CUSTOMER_TYPES','PAYMENT_METHODS','COMMERCIAL_SUMMARY')),
  format text not null check (format in ('PDF','XLSX')),
  report_name text not null check (char_length(trim(report_name)) between 3 and 120),
  normalized_filters jsonb not null check (jsonb_typeof(normalized_filters)='object'),
  included_sections jsonb not null default '[]'::jsonb check (jsonb_typeof(included_sections)='array'),
  included_columns jsonb not null default '[]'::jsonb check (jsonb_typeof(included_columns)='array'),
  status text not null default 'PENDING' check (status in ('PENDING','READY','FAILED')),
  row_count integer not null default 0 check (row_count >= 0),
  report_snapshot jsonb check (report_snapshot is null or jsonb_typeof(report_snapshot)='object'),
  snapshot_hash text,
  error_category text,
  error_message text,
  created_at timestamptz not null default now(),
  generated_at timestamptz,
  constraint commercial_report_generation_state check (
    (status='PENDING' and generated_at is null and report_snapshot is null and error_category is null)
    or (status='READY' and generated_at is not null and report_snapshot is not null and snapshot_hash ~ '^[0-9a-f]{64}$' and error_category is null)
    or (status='FAILED' and generated_at is not null and report_snapshot is null and error_category is not null)
  )
);

create table public.commercial_report_generation_events (
  id bigint generated always as identity primary key,
  generation_id uuid not null references public.commercial_report_generations(id) on delete restrict,
  event_type text not null check (event_type in ('REQUESTED','READY','FAILED','DOWNLOADED')),
  actor_user_id uuid not null references public.users(id) on delete restrict,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata)='object'),
  created_at timestamptz not null default now()
);

create index commercial_report_configs_owner_idx on public.commercial_report_configurations(owner_user_id,created_at desc,id);
create index commercial_report_generations_actor_idx on public.commercial_report_generations(actor_user_id,created_at desc,id);
create index commercial_report_generations_status_idx on public.commercial_report_generations(status,created_at desc,id);
create index commercial_report_events_generation_idx on public.commercial_report_generation_events(generation_id,created_at,id);

alter table public.sales_commission_policies enable row level security;
alter table public.sales_commission_policy_events enable row level security;
alter table public.sales_commission_assignment_operations enable row level security;
alter table public.sales_commission_assignment_items enable row level security;
alter table public.commercial_report_configurations enable row level security;
alter table public.commercial_report_generations enable row level security;
alter table public.commercial_report_generation_events enable row level security;

revoke all on public.sales_commission_policies,public.sales_commission_policy_events,
  public.sales_commission_assignment_operations,public.sales_commission_assignment_items,
  public.commercial_report_configurations,public.commercial_report_generations,
  public.commercial_report_generation_events from public,anon,authenticated;
grant select,insert,update on public.sales_commission_policies,public.sales_commission_policy_events,
  public.sales_commission_assignment_operations,public.sales_commission_assignment_items,
  public.commercial_report_configurations,public.commercial_report_generations,
  public.commercial_report_generation_events to service_role;

create policy phase4_policy_read on public.sales_commission_policies for select using (public.commercial_phase4_permission_allowed('commissions:policies:manage'));
create policy phase4_policy_event_read on public.sales_commission_policy_events for select using (public.commercial_phase4_permission_allowed('commissions:policies:manage'));
create policy phase4_assignment_read on public.sales_commission_assignment_operations for select using (public.commercial_phase4_permission_allowed('commissions:policies:manage'));
create policy phase4_assignment_item_read on public.sales_commission_assignment_items for select using (public.commercial_phase4_permission_allowed('commissions:policies:manage'));
create policy phase4_config_owner_read on public.commercial_report_configurations for select using (owner_user_id=auth.uid() and public.commercial_phase4_permission_allowed('commercial:reports:read'));
create policy phase4_generation_read on public.commercial_report_generations for select using (public.commercial_phase4_permission_allowed('commercial:reports:read'));
create policy phase4_generation_event_read on public.commercial_report_generation_events for select using (public.commercial_phase4_permission_allowed('commercial:reports:read'));
grant select on public.sales_commission_policies,public.sales_commission_policy_events,
  public.sales_commission_assignment_operations,public.sales_commission_assignment_items,
  public.commercial_report_configurations,public.commercial_report_generations,
  public.commercial_report_generation_events to authenticated;

create or replace function public.prevent_phase4_audit_mutation_v1()
returns trigger language plpgsql set search_path=public as $$
begin
  if current_setting('app.phase4_internal',true)<>'on' then
    raise exception using errcode='42501',message='PHASE4_AUDIT_IMMUTABLE';
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger phase4_policy_events_append_only before update or delete on public.sales_commission_policy_events for each row execute function public.prevent_phase4_audit_mutation_v1();
create trigger phase4_assignment_operations_append_only before update or delete on public.sales_commission_assignment_operations for each row execute function public.prevent_phase4_audit_mutation_v1();
create trigger phase4_assignment_items_append_only before update or delete on public.sales_commission_assignment_items for each row execute function public.prevent_phase4_audit_mutation_v1();
create trigger phase4_generation_events_append_only before update or delete on public.commercial_report_generation_events for each row execute function public.prevent_phase4_audit_mutation_v1();
create trigger phase4_report_generation_guarded before update or delete on public.commercial_report_generations for each row execute function public.prevent_phase4_audit_mutation_v1();
revoke all on function public.prevent_phase4_audit_mutation_v1() from public,anon,authenticated;

create or replace function public.prevent_commission_policy_rewrite_v1()
returns trigger language plpgsql set search_path=public as $$
begin
  if tg_op='DELETE' then raise exception using errcode='42501',message='COMMISSION_POLICY_IMMUTABLE'; end if;
  if new.name is distinct from old.name or new.rule_type is distinct from old.rule_type
    or new.rule_value is distinct from old.rule_value or new.base_contract is distinct from old.base_contract
    or new.conditions is distinct from old.conditions or new.description is distinct from old.description
    or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at
    or old.active=false or new.active=true then
    raise exception using errcode='42501',message='COMMISSION_POLICY_IMMUTABLE';
  end if;
  return new;
end $$;
create trigger sales_commission_policies_immutable before update or delete on public.sales_commission_policies for each row execute function public.prevent_commission_policy_rewrite_v1();
revoke all on function public.prevent_commission_policy_rewrite_v1() from public,anon,authenticated;

create or replace function public.phase4_policy_json_v1(p_policy_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  select jsonb_build_object('policyId',p.id,'name',p.name,'type',p.rule_type,'value',p.rule_value,
    'description',p.description,'baseContract',p.base_contract,'active',p.active,'createdAt',p.created_at,
    'createdByName',coalesce(u.full_name,u.username,split_part(u.email,'@',1),'Usuario'),
    'usageCount',(select count(distinct r.seller_user_id) from public.sales_commission_rules r where r.policy_id=p.id),
    'lastAppliedAt',(select max(r.created_at) from public.sales_commission_rules r where r.policy_id=p.id))
  from public.sales_commission_policies p join public.users u on u.id=p.created_by where p.id=p_policy_id
$$;
revoke all on function public.phase4_policy_json_v1(uuid) from public,anon,authenticated;

create or replace function public.create_commission_policy_v1(p_request_key uuid,p_name text,p_rule_type text,p_rule_value numeric,p_description text default '')
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); result public.sales_commission_policies%rowtype; clean_name text:=trim(coalesce(p_name,'')); clean_type text:=upper(trim(coalesce(p_rule_type,'')));
begin
  if not public.commercial_phase4_permission_allowed('commissions:policies:manage') then raise exception using errcode='42501',message='PHASE4_ACCESS_DENIED'; end if;
  if p_request_key is null or char_length(clean_name) not between 3 and 100 or clean_type not in ('PERCENTAGE','FIXED_AMOUNT') or p_rule_value<=0 or (clean_type='PERCENTAGE' and p_rule_value>100) or char_length(coalesce(p_description,''))>500 then raise exception using errcode='22023',message='COMMISSION_POLICY_INVALID'; end if;
  select * into result from public.sales_commission_policies where request_key=p_request_key;
  if result.id is not null then return public.phase4_policy_json_v1(result.id)||jsonb_build_object('idempotentReplay',true); end if;
  insert into public.sales_commission_policies(request_key,name,rule_type,rule_value,description,created_by)
    values(p_request_key,clean_name,clean_type,round(p_rule_value,4),trim(coalesce(p_description,'')),actor) returning * into result;
  insert into public.sales_commission_policy_events(policy_id,event_type,actor_user_id,metadata,idempotency_key)
    values(result.id,'CREATED',actor,jsonb_build_object('type',result.rule_type,'value',result.rule_value),'policy-created:'||result.id);
  return public.phase4_policy_json_v1(result.id)||jsonb_build_object('idempotentReplay',false);
end $$;
revoke all on function public.create_commission_policy_v1(uuid,text,text,numeric,text) from public,anon;
grant execute on function public.create_commission_policy_v1(uuid,text,text,numeric,text) to authenticated;

create or replace function public.duplicate_commission_policy_v1(p_request_key uuid,p_policy_id uuid,p_name text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare source public.sales_commission_policies%rowtype; result public.sales_commission_policies%rowtype; actor uuid:=auth.uid();
begin
  if not public.commercial_phase4_permission_allowed('commissions:policies:manage') then raise exception using errcode='42501',message='PHASE4_ACCESS_DENIED'; end if;
  select * into source from public.sales_commission_policies where id=p_policy_id;
  if source.id is null then raise exception using errcode='P0002',message='COMMISSION_POLICY_NOT_FOUND'; end if;
  select * into result from public.sales_commission_policies where request_key=p_request_key;
  if result.id is not null then return public.phase4_policy_json_v1(result.id)||jsonb_build_object('idempotentReplay',true); end if;
  insert into public.sales_commission_policies(request_key,name,rule_type,rule_value,base_contract,conditions,description,duplicated_from,created_by)
    values(p_request_key,trim(p_name),source.rule_type,source.rule_value,source.base_contract,source.conditions,source.description,source.id,actor) returning * into result;
  insert into public.sales_commission_policy_events(policy_id,event_type,actor_user_id,metadata,idempotency_key)
    values(result.id,'DUPLICATED',actor,jsonb_build_object('sourcePolicyId',source.id),'policy-duplicated:'||result.id);
  return public.phase4_policy_json_v1(result.id)||jsonb_build_object('idempotentReplay',false);
end $$;
revoke all on function public.duplicate_commission_policy_v1(uuid,uuid,text) from public,anon;
grant execute on function public.duplicate_commission_policy_v1(uuid,uuid,text) to authenticated;

create or replace function public.deactivate_commission_policy_v1(p_policy_id uuid,p_reason text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); clean_reason text:=trim(coalesce(p_reason,'')); target public.sales_commission_policies%rowtype;
begin
  if not public.commercial_phase4_permission_allowed('commissions:policies:manage') then raise exception using errcode='42501',message='PHASE4_ACCESS_DENIED'; end if;
  if char_length(clean_reason) not between 10 and 500 then raise exception using errcode='22023',message='COMMISSION_POLICY_REASON_REQUIRED'; end if;
  select * into target from public.sales_commission_policies where id=p_policy_id for update;
  if target.id is null then raise exception using errcode='P0002',message='COMMISSION_POLICY_NOT_FOUND'; end if;
  if not target.active then return public.phase4_policy_json_v1(target.id)||jsonb_build_object('idempotentReplay',true); end if;
  update public.sales_commission_policies set active=false,deactivated_by=actor,deactivated_at=now(),deactivation_reason=clean_reason where id=target.id;
  insert into public.sales_commission_policy_events(policy_id,event_type,actor_user_id,reason,idempotency_key)
    values(target.id,'DEACTIVATED',actor,clean_reason,'policy-deactivated:'||target.id);
  return public.phase4_policy_json_v1(target.id)||jsonb_build_object('idempotentReplay',false);
end $$;
revoke all on function public.deactivate_commission_policy_v1(uuid,text) from public,anon;
grant execute on function public.deactivate_commission_policy_v1(uuid,text) to authenticated;

create or replace function public.list_commission_policies_v1(p_query text default null,p_status text default 'all',p_type text default 'all')
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if not public.commercial_phase4_permission_allowed('commissions:policies:manage') then raise exception using errcode='42501',message='PHASE4_ACCESS_DENIED'; end if;
  select jsonb_build_object(
    'results',coalesce(jsonb_agg(public.phase4_policy_json_v1(p.id) order by p.active desc,p.created_at desc),'[]'::jsonb),
    'coverage',jsonb_build_object(
      'activeSellers',(select count(*) from public.users u join public.roles r on r.id=u.role_id where r.name='vendedor' and u.active),
      'withRule',(select count(*) from public.users u join public.roles r on r.id=u.role_id where r.name='vendedor' and u.active and exists(select 1 from public.sales_commission_rules cr where cr.seller_user_id=u.id and cr.effective_from<=now() and (cr.effective_to is null or cr.effective_to>now()))),
      'scheduled',(select count(distinct cr.seller_user_id) from public.sales_commission_rules cr join public.users u on u.id=cr.seller_user_id and u.active where cr.effective_from>now()))) into result
  from public.sales_commission_policies p where (p_status='all' or (p_status='active' and p.active) or (p_status='inactive' and not p.active))
    and (p_type='all' or p.rule_type=p_type) and (nullif(trim(coalesce(p_query,'')),'') is null or p.name ilike '%'||trim(p_query)||'%');
  return result;
end $$;
revoke all on function public.list_commission_policies_v1(text,text,text) from public,anon;
grant execute on function public.list_commission_policies_v1(text,text,text) to authenticated;

create or replace function public.preview_commission_policy_assignment_v1(p_policy_id uuid,p_seller_ids uuid[],p_effective_date date)
returns jsonb language plpgsql stable security definer set search_path=public set timezone='America/Tegucigalpa' as $$
declare result jsonb; normalized uuid[]; policy public.sales_commission_policies%rowtype; start_at timestamptz;
begin
  if not public.commercial_phase4_permission_allowed('commissions:policies:manage') then raise exception using errcode='42501',message='PHASE4_ACCESS_DENIED'; end if;
  select coalesce(array_agg(distinct value order by value),array[]::uuid[]) into normalized from unnest(coalesce(p_seller_ids,array[]::uuid[])) value;
  if cardinality(normalized) not between 1 and 50 or p_effective_date is null or p_effective_date<(now() at time zone 'America/Tegucigalpa')::date then raise exception using errcode='22023',message='COMMISSION_ASSIGNMENT_INVALID'; end if;
  select * into policy from public.sales_commission_policies where id=p_policy_id;
  if policy.id is null or not policy.active then raise exception using errcode='22023',message='COMMISSION_POLICY_INACTIVE'; end if;
  start_at:=case when p_effective_date=(now() at time zone 'America/Tegucigalpa')::date then now()
    else make_timestamptz(extract(year from p_effective_date)::int,extract(month from p_effective_date)::int,extract(day from p_effective_date)::int,0,0,0,'America/Tegucigalpa') end;
  with sellers as (
    select selected.id,u.active,(role.name='vendedor') is_seller,coalesce(nullif(trim(u.full_name),''),nullif(trim(u.username),''),split_part(u.email,'@',1),'Vendedor') name,
      current_rule.id current_id,current_rule.rule_type current_type,current_rule.rule_value current_value,
      future.id future_id,future.rule_type future_type,future.rule_value future_value,future.effective_from future_from
    from unnest(normalized) selected(id) left join public.users u on u.id=selected.id
    left join public.roles role on role.id=u.role_id and role.name='vendedor'
    left join lateral(select * from public.sales_commission_rules r where r.seller_user_id=u.id and r.effective_from<=start_at and (r.effective_to is null or r.effective_to>start_at) order by r.effective_from desc limit 1) current_rule on true
    left join lateral(select * from public.sales_commission_rules r where r.seller_user_id=u.id and r.effective_from>now() order by r.effective_from limit 1) future on true
  ), rows as (select *,case when not coalesce(is_seller,false) or not coalesce(active,false) then 'INACTIVE' when future_id is not null and (future_type<>policy.rule_type or future_value<>policy.rule_value) then 'FUTURE_CONFLICT' when (current_type=policy.rule_type and current_value=policy.rule_value) or (future_type=policy.rule_type and future_value=policy.rule_value) then 'NO_OP' else 'CREATE' end outcome from sellers)
  select jsonb_build_object('previewToken',encode(extensions.digest(policy.id::text||'|'||policy.rule_type||'|'||policy.rule_value::text||'|'||p_effective_date::text||'|'||array_to_string(normalized,',')||'|'||coalesce((select string_agg(id::text||':'||coalesce(active::text,'null')||':'||coalesce(is_seller::text,'null')||':'||coalesce(current_id::text,'none')||':'||coalesce(current_type,'none')||':'||coalesce(current_value::text,'none')||':'||coalesce(future_id::text,'none')||':'||coalesce(future_type,'none')||':'||coalesce(future_value::text,'none')||':'||coalesce(future_from::text,'none'),'|' order by id) from rows),''),'sha256'),'hex'),'policy',public.phase4_policy_json_v1(policy.id),'effectiveDate',p_effective_date,
    'selected',(select count(*) from rows),'willCreate',(select count(*) from rows where outcome='CREATE'),'noOp',(select count(*) from rows where outcome='NO_OP'),'conflicts',(select count(*) from rows where outcome in ('FUTURE_CONFLICT','INACTIVE')),
    'sellers',coalesce((select jsonb_agg(jsonb_build_object('sellerId',id,'name',coalesce(name,'Vendedor no válido'),'active',coalesce(active,false),'currentRule',case when current_id is null then null else jsonb_build_object('type',current_type,'value',current_value) end,'futureRule',case when future_id is null then null else jsonb_build_object('type',future_type,'value',future_value,'effectiveFrom',future_from) end,'outcome',outcome) order by name,id) from rows),'[]'::jsonb)) into result;
  return result;
end $$;
revoke all on function public.preview_commission_policy_assignment_v1(uuid,uuid[],date) from public,anon;
grant execute on function public.preview_commission_policy_assignment_v1(uuid,uuid[],date) to authenticated;

create or replace function public.apply_commission_policy_assignment_v1(p_request_key uuid,p_policy_id uuid,p_seller_ids uuid[],p_effective_date date,p_reason text,p_preview_token text)
returns jsonb language plpgsql security definer set search_path=public set timezone='America/Tegucigalpa' as $$
declare actor uuid:=auth.uid(); preview jsonb; operation public.sales_commission_assignment_operations%rowtype; policy public.sales_commission_policies%rowtype; seller jsonb; previous public.sales_commission_rules%rowtype; new_rule public.sales_commission_rules%rowtype; start_at timestamptz; next_version integer; rule_key uuid; created_count integer:=0; no_op_count integer:=0; normalized uuid[]; target_seller uuid;
begin
  if not public.commercial_phase4_permission_allowed('commissions:policies:manage') then raise exception using errcode='42501',message='PHASE4_ACCESS_DENIED'; end if;
  if p_request_key is null or char_length(trim(coalesce(p_reason,''))) not between 10 and 500 then raise exception using errcode='22023',message='COMMISSION_ASSIGNMENT_REASON_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('phase4-assignment:'||p_request_key::text,0));
  select * into operation from public.sales_commission_assignment_operations where request_key=p_request_key;
  if operation.id is not null then
    if operation.policy_id<>p_policy_id or operation.effective_date<>p_effective_date or operation.reason<>trim(p_reason) or operation.preview_token<>p_preview_token then raise exception using errcode='PT409',message='COMMISSION_ASSIGNMENT_IDEMPOTENCY_CONFLICT'; end if;
    return jsonb_build_object('operationId',operation.id,'created',operation.created_count,'noOp',operation.no_op_count,'idempotentReplay',true);
  end if;
  select coalesce(array_agg(distinct value order by value),array[]::uuid[]) into normalized from unnest(coalesce(p_seller_ids,array[]::uuid[])) value;
  select * into policy from public.sales_commission_policies where id=p_policy_id and active for update;
  if policy.id is null then raise exception using errcode='22023',message='COMMISSION_POLICY_INACTIVE'; end if;
  foreach target_seller in array normalized loop perform pg_advisory_xact_lock(hashtextextended('commission-rule:'||target_seller::text,0)); end loop;
  perform 1 from public.users where id=any(normalized) order by id for update;
  preview:=public.preview_commission_policy_assignment_v1(p_policy_id,p_seller_ids,p_effective_date);
  if preview->>'previewToken' is distinct from p_preview_token then raise exception using errcode='PT409',message='COMMISSION_ASSIGNMENT_PREVIEW_STALE'; end if;
  if (preview->>'conflicts')::integer>0 then raise exception using errcode='PT409',message='COMMISSION_ASSIGNMENT_CONFLICT'; end if;
  start_at:=case when p_effective_date=(now() at time zone 'America/Tegucigalpa')::date then now() else make_timestamptz(extract(year from p_effective_date)::int,extract(month from p_effective_date)::int,extract(day from p_effective_date)::int,0,0,0,'America/Tegucigalpa') end;
  insert into public.sales_commission_assignment_operations(request_key,policy_id,effective_date,reason,preview_token,selected_count,created_count,no_op_count,actor_user_id)
    values(p_request_key,policy.id,p_effective_date,trim(p_reason),(preview->>'previewToken'),(preview->>'selected')::integer,(preview->>'willCreate')::integer,(preview->>'noOp')::integer,actor) returning * into operation;
  for seller in select value from jsonb_array_elements(preview->'sellers') loop
    select * into previous from public.sales_commission_rules where seller_user_id=(seller->>'sellerId')::uuid and effective_from<=start_at and (effective_to is null or effective_to>start_at) order by effective_from desc limit 1 for update;
    if seller->>'outcome'='NO_OP' then
      insert into public.sales_commission_assignment_items(operation_id,seller_user_id,outcome,previous_rule_id) values(operation.id,(seller->>'sellerId')::uuid,'NO_OP',previous.id); no_op_count:=no_op_count+1;
    else
      if previous.id is not null then perform set_config('app.commission_internal','on',true); update public.sales_commission_rules set effective_to=start_at where id=previous.id; end if;
      select coalesce(max(version),0)+1 into next_version from public.sales_commission_rules where seller_user_id=(seller->>'sellerId')::uuid;
      rule_key:=(substr(md5(p_request_key::text||(seller->>'sellerId')),1,8)||'-'||substr(md5(p_request_key::text||(seller->>'sellerId')),9,4)||'-4'||substr(md5(p_request_key::text||(seller->>'sellerId')),14,3)||'-a'||substr(md5(p_request_key::text||(seller->>'sellerId')),18,3)||'-'||substr(md5(p_request_key::text||(seller->>'sellerId')),21,12))::uuid;
      insert into public.sales_commission_rules(request_key,seller_user_id,version,rule_type,rule_value,effective_from,reason,created_by,policy_id,assignment_operation_id)
        values(rule_key,(seller->>'sellerId')::uuid,next_version,policy.rule_type,policy.rule_value,start_at,trim(p_reason),actor,policy.id,operation.id) returning * into new_rule;
      insert into public.sales_commission_assignment_items(operation_id,seller_user_id,outcome,previous_rule_id,created_rule_id) values(operation.id,new_rule.seller_user_id,'CREATED',previous.id,new_rule.id); created_count:=created_count+1;
    end if;
  end loop;
  insert into public.sales_commission_policy_events(policy_id,event_type,actor_user_id,reason,metadata,idempotency_key)
    values(policy.id,'BULK_ASSIGNED',actor,trim(p_reason),jsonb_build_object('operationId',operation.id,'created',created_count,'noOp',no_op_count),'policy-assigned:'||operation.id);
  return jsonb_build_object('operationId',operation.id,'created',created_count,'noOp',no_op_count,'idempotentReplay',false);
end $$;
revoke all on function public.apply_commission_policy_assignment_v1(uuid,uuid,uuid[],date,text,text) from public,anon;
grant execute on function public.apply_commission_policy_assignment_v1(uuid,uuid,uuid[],date,text,text) to authenticated;

create or replace function public.get_commercial_dashboard_v1(p_filters jsonb,p_limit integer default 20,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path=public set timezone='America/Tegucigalpa' as $$
declare result jsonb; from_date date; to_date date; previous_from date; previous_to date; compare_previous boolean; seller uuid; channel_filter text; customer_filter text; payment_filter text; status_filter text; special_filter text;
begin
  if not public.commercial_phase4_permission_allowed('commercial:reports:read') then raise exception using errcode='42501',message='PHASE4_ACCESS_DENIED'; end if;
  from_date:=coalesce((p_filters->>'from')::date,date_trunc('month',now() at time zone 'America/Tegucigalpa')::date); to_date:=coalesce((p_filters->>'to')::date,(now() at time zone 'America/Tegucigalpa')::date);
  if from_date>to_date or to_date-from_date>366 then raise exception using errcode='22023',message='REPORT_PERIOD_INVALID'; end if;
  previous_to:=from_date-1; previous_from:=previous_to-(to_date-from_date);
  compare_previous:=coalesce((p_filters->>'comparePrevious')::boolean,false);
  seller:=nullif(p_filters->>'sellerId','')::uuid; channel_filter:=coalesce(p_filters->>'channel','all'); customer_filter:=coalesce(p_filters->>'customerType','all'); payment_filter:=coalesce(p_filters->>'paymentMethod','all'); status_filter:=coalesce(p_filters->>'saleStatus','all'); special_filter:=coalesce(p_filters->>'specialPrice','all');
  with source_sales as (
    select o.id,o.order_number,coalesce(o.confirmed_at,o.created_at) sale_at,o.seller_id,coalesce(o.seller_display_name_snapshot,'Sin vendedor') seller_name,o.customer_id,o.customer_name,o.price_mode::text customer_type,o.source,o.payment_method::text payment_method,o.status::text status,o.total,
      least(public.commission_net_valid_collected_v1(o.id),o.total) collected,
      exists(select 1 from public.pos_price_requests pr where pr.consumed_order_id=o.id and pr.status='consumed') special_price,
      coalesce(ce.potential_amount,0) potential,coalesce(ce.earned_amount,0) earned,
      case when ce.status in ('VOIDED','REVERSED') then 0 else greatest(coalesce(ce.potential_amount,0)-coalesce(ce.earned_amount,0),0) end remaining,
      coalesce(ce.reversed_amount,0) reversed
    from public.orders o left join public.sales_commission_entries ce on ce.order_id=o.id and ce.superseded_at is null
    where (coalesce(o.confirmed_at,o.created_at) at time zone 'America/Tegucigalpa')::date
      between case when compare_previous then previous_from else from_date end and to_date
  ), scoped as (
    select * from source_sales s where (seller is null or s.seller_id=seller) and (channel_filter='all' or s.source=channel_filter)
      and (customer_filter='all' or s.customer_type=customer_filter) and (payment_filter='all' or s.payment_method=payment_filter)
      and (status_filter='all' or (status_filter='cancelled' and s.status in ('cancelado','cancelled')) or (status_filter='valid' and s.status not in ('cancelado','cancelled')))
      and (special_filter='all' or (special_filter='with' and s.special_price) or (special_filter='without' and not s.special_price))
  ), filtered as (select * from scoped where (sale_at at time zone 'America/Tegucigalpa')::date between from_date and to_date),
  previous_filtered as (select * from scoped where compare_previous and (sale_at at time zone 'America/Tegucigalpa')::date between previous_from and previous_to),
  valid as (select * from filtered where status not in ('cancelado','cancelled')),
  previous_valid as (select * from previous_filtered where status not in ('cancelado','cancelled')),
  seller_rows as (select seller_id,seller_name,count(*) sales,sum(total) sold,sum(collected) collected,sum(greatest(total-collected,0)) outstanding,round(avg(total),2) average_ticket,0 cancelled,0 cancelled_amount,sum(potential) potential,sum(earned) earned,sum(remaining) remaining,sum(reversed) reversed from valid group by seller_id,seller_name),
  page as (select * from filtered order by sale_at desc,id desc limit least(greatest(coalesce(p_limit,20),1),5000) offset least(greatest(coalesce(p_offset,0),0),100000)),
  coverage as (select count(*) active_sellers,count(*) filter(where current_rule) with_rule,count(*) filter(where not current_rule) without_rule,count(*) filter(where scheduled_rule) scheduled from (select u.id,exists(select 1 from public.sales_commission_rules r where r.seller_user_id=u.id and r.effective_from<=now() and (r.effective_to is null or r.effective_to>now())) current_rule,exists(select 1 from public.sales_commission_rules r where r.seller_user_id=u.id and r.effective_from>now()) scheduled_rule from public.users u join public.roles r on r.id=u.role_id where r.name='vendedor' and u.active) x)
  select jsonb_build_object('generatedAt',now(),'timezone','America/Tegucigalpa','filters',p_filters,
    'kpis',jsonb_build_object('sales',(select count(*) from valid),'sold',coalesce((select sum(total) from valid),0),'collected',coalesce((select sum(collected) from valid),0),'outstanding',coalesce((select sum(greatest(total-collected,0)) from valid),0),'averageTicket',coalesce((select round(avg(total),2) from valid),0),'cancelled',(select count(*) from filtered where status in ('cancelado','cancelled')),'cancelledAmount',coalesce((select sum(total) from filtered where status in ('cancelado','cancelled')),0)),
    'previous',case when compare_previous then jsonb_build_object('sales',(select count(*) from previous_valid),'sold',coalesce((select sum(total) from previous_valid),0),'collected',coalesce((select sum(collected) from previous_valid),0),'outstanding',coalesce((select sum(greatest(total-collected,0)) from previous_valid),0),'averageTicket',coalesce((select round(avg(total),2) from previous_valid),0),'cancelled',(select count(*) from previous_filtered where status in ('cancelado','cancelled')),'cancelledAmount',coalesce((select sum(total) from previous_filtered where status in ('cancelado','cancelled')),0)) else null end,
    'trend',coalesce((select jsonb_agg(jsonb_build_object('date',sale_day,'sold',sold,'collected',collected) order by sale_day) from (select (sale_at at time zone 'America/Tegucigalpa')::date sale_day,sum(total) sold,sum(collected) collected from valid group by 1) t),'[]'::jsonb),
    'sellers',coalesce((select jsonb_agg(jsonb_build_object('sellerId',seller_id,'sellerName',seller_name,'sales',sales,'sold',sold,'collected',collected,'outstanding',outstanding,'averageTicket',average_ticket,'cancelled',cancelled,'cancelledAmount',cancelled_amount,'potential',potential,'earned',earned,'remaining',remaining,'reversed',reversed) order by sold desc,seller_name) from seller_rows),'[]'::jsonb),
    'paymentMethods',coalesce((select jsonb_agg(jsonb_build_object('key',payment_method,'label',payment_method,'count',count,'amount',amount) order by amount desc) from (select payment_method,count(*) count,sum(total) amount from valid group by payment_method) x),'[]'::jsonb),
    'customerTypes',coalesce((select jsonb_agg(jsonb_build_object('key',customer_type,'label',case customer_type when 'wholesale' then 'Mayorista' else 'Minorista' end,'count',count,'amount',amount) order by amount desc) from (select customer_type,count(*) count,sum(total) amount from valid group by customer_type) x),'[]'::jsonb),
    'channels',coalesce((select jsonb_agg(jsonb_build_object('key',source,'label',upper(source),'count',count,'amount',amount) order by amount desc) from (select source,count(*) count,sum(total) amount from valid group by source) x),'[]'::jsonb),
    'specialPrices',jsonb_build_object('requests',(select count(*) from public.pos_price_requests where requested_at::date between from_date and to_date and (seller is null or seller_user_id=seller)),'approved',(select count(*) from public.pos_price_requests where status in ('approved','consumed') and requested_at::date between from_date and to_date and (seller is null or seller_user_id=seller)),'rejected',(select count(*) from public.pos_price_requests where status='rejected' and requested_at::date between from_date and to_date and (seller is null or seller_user_id=seller)),'expiredOrCancelled',(select count(*) from public.pos_price_requests where status in ('expired','cancelled','revoked') and requested_at::date between from_date and to_date and (seller is null or seller_user_id=seller)),'used',(select count(*) from valid where special_price),'soldAmount',coalesce((select sum(total) from valid where special_price),0)),
    'priceRequests',coalesce((select jsonb_agg(jsonb_build_object('requestId',id,'requestedAt',requested_at,'sellerId',seller_user_id,'sellerName',seller_display_name_snapshot,'productName',product_name_snapshot,'sku',sku_snapshot,'status',status,'baseUnitPrice',base_unit_price,'requestedUnitPrice',requested_unit_price,'difference',requested_unit_price-base_unit_price,'consumedOrderId',consumed_order_id) order by requested_at desc,id desc) from (select * from public.pos_price_requests where requested_at::date between from_date and to_date and (seller is null or seller_user_id=seller) order by requested_at desc,id desc limit 500) price_rows),'[]'::jsonb),
    'commissions',jsonb_build_object('potential',coalesce((select sum(potential) from valid),0),'earned',coalesce((select sum(earned) from valid),0),'remaining',coalesce((select sum(remaining) from valid),0),'reversed',coalesce((select sum(reversed) from filtered),0)),
    'coverage',(select jsonb_build_object('activeSellers',active_sellers,'withRule',with_rule,'withoutRule',without_rule,'scheduled',scheduled,'percentage',case when active_sellers>0 then round(with_rule*100.0/active_sellers,2) else 0 end) from coverage),
    'attention',jsonb_build_array(jsonb_build_object('code','SELLERS_WITHOUT_RULE','label','Vendedores activos sin regla de comisión','count',(select without_rule from coverage),'href','/admin/politicas-comision'),jsonb_build_object('code','OUTSTANDING_SALES','label','Ventas con saldo pendiente','count',(select count(*) from valid where total-collected>0),'amount',coalesce((select sum(total-collected) from valid where total-collected>0),0),'href','/admin/reportes-comerciales?attention=outstanding'),jsonb_build_object('code','PENDING_PRICE_REQUESTS','label','Solicitudes de precio pendientes','count',(select count(*) from public.pos_price_requests where status='pending' and (seller is null or seller_user_id=seller)),'href','/admin/aprobaciones-precio')),
    'sellerDetail',case when seller is null then null else jsonb_build_object('customersAttended',(select count(distinct customer_id) from valid),'retailCustomers',(select count(distinct customer_id) from valid where customer_type='retail'),'wholesaleCustomers',(select count(distinct customer_id) from valid where customer_type='wholesale'),'attributionCorrections',(select count(*) from public.pos_seller_attribution_events where event_type='corrected' and (seller_user_id=seller or previous_seller_user_id=seller) and (created_at at time zone 'America/Tegucigalpa')::date between from_date and to_date),'cancellations',(select count(*) from filtered where status in ('cancelado','cancelled')),'cancelledAmount',coalesce((select sum(total) from filtered where status in ('cancelado','cancelled')),0),'reversedCommission',coalesce((select sum(reversed) from filtered),0),'ruleHistory',coalesce((select jsonb_agg(jsonb_build_object('ruleId',id,'version',version,'type',rule_type,'value',rule_value,'effectiveFrom',effective_from,'effectiveTo',effective_to,'policyName',policy_name) order by effective_from desc) from (select r.id,r.version,r.rule_type,r.rule_value,r.effective_from,r.effective_to,p.name policy_name from public.sales_commission_rules r left join public.sales_commission_policies p on p.id=r.policy_id where r.seller_user_id=seller order by r.effective_from desc limit 10) rule_rows),'[]'::jsonb)) end,
    'sales',coalesce((select jsonb_agg(jsonb_build_object('orderId',id,'orderNumber',order_number,'date',sale_at,'sellerId',seller_id,'sellerName',seller_name,'customerName',customer_name,'customerType',customer_type,'channel',source,'paymentMethod',payment_method,'status',status,'total',total,'collected',collected,'outstanding',greatest(total-collected,0),'specialPrice',special_price,'potential',potential,'earned',earned,'remaining',remaining) order by sale_at desc,id desc) from page),'[]'::jsonb),'totalSales',(select count(*) from filtered)) into result;
  return result;
end $$;
revoke all on function public.get_commercial_dashboard_v1(jsonb,integer,integer) from public,anon;
grant execute on function public.get_commercial_dashboard_v1(jsonb,integer,integer) to authenticated;

create or replace function public.create_commercial_report_generation_v1(p_request_key uuid,p_report_type text,p_format text,p_report_name text,p_filters jsonb,p_sections jsonb,p_columns jsonb,p_configuration_name text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); generation public.commercial_report_generations%rowtype; config_id uuid;
begin
  if not public.commercial_phase4_permission_allowed('commercial:reports:generate') then raise exception using errcode='42501',message='PHASE4_ACCESS_DENIED'; end if;
  select * into generation from public.commercial_report_generations where request_key=p_request_key;
  if generation.id is not null then return jsonb_build_object('generationId',generation.id,'status',generation.status,'idempotentReplay',true); end if;
  if p_configuration_name is not null and char_length(trim(p_configuration_name)) between 3 and 100 then
    insert into public.commercial_report_configurations(owner_user_id,name,report_type,format,normalized_filters,included_sections,included_columns)
      values(actor,trim(p_configuration_name),p_report_type,p_format,p_filters,p_sections,p_columns)
      on conflict(owner_user_id,name) do update set report_type=excluded.report_type,format=excluded.format,normalized_filters=excluded.normalized_filters,included_sections=excluded.included_sections,included_columns=excluded.included_columns,updated_at=now() returning id into config_id;
  end if;
  insert into public.commercial_report_generations(request_key,actor_user_id,configuration_id,report_type,format,report_name,normalized_filters,included_sections,included_columns)
    values(p_request_key,actor,config_id,p_report_type,p_format,trim(p_report_name),p_filters,p_sections,p_columns) returning * into generation;
  insert into public.commercial_report_generation_events(generation_id,event_type,actor_user_id,metadata)
    values(generation.id,'REQUESTED',actor,jsonb_build_object('reportType',p_report_type,'format',p_format));
  return jsonb_build_object('generationId',generation.id,'status',generation.status,'idempotentReplay',false);
end $$;
revoke all on function public.create_commercial_report_generation_v1(uuid,text,text,text,jsonb,jsonb,jsonb,text) from public,anon;
grant execute on function public.create_commercial_report_generation_v1(uuid,text,text,text,jsonb,jsonb,jsonb,text) to authenticated;

create or replace function public.complete_commercial_report_generation_v1(p_generation_id uuid,p_snapshot jsonb,p_row_count integer,p_snapshot_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid(); target public.commercial_report_generations%rowtype;
begin
  if not public.commercial_phase4_permission_allowed('commercial:reports:generate') then raise exception using errcode='42501',message='PHASE4_ACCESS_DENIED'; end if;
  select * into target from public.commercial_report_generations where id=p_generation_id and actor_user_id=actor for update;
  if target.id is null then raise exception using errcode='P0002',message='REPORT_GENERATION_NOT_FOUND'; end if;
  if target.status='READY' then return jsonb_build_object('generationId',target.id,'status','READY','idempotentReplay',true); end if;
  if target.status<>'PENDING' or p_row_count<0 or p_row_count>5000 or jsonb_typeof(p_snapshot)<>'object' or p_snapshot_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode='22023',message='REPORT_GENERATION_INVALID'; end if;
  perform set_config('app.phase4_internal','on',true);
  update public.commercial_report_generations set status='READY',row_count=p_row_count,report_snapshot=p_snapshot,snapshot_hash=p_snapshot_hash,generated_at=now() where id=target.id;
  perform set_config('app.phase4_internal','off',true);
  insert into public.commercial_report_generation_events(generation_id,event_type,actor_user_id,metadata) values(target.id,'READY',actor,jsonb_build_object('rowCount',p_row_count,'snapshotHash',p_snapshot_hash));
  return jsonb_build_object('generationId',target.id,'status','READY','idempotentReplay',false);
end $$;
revoke all on function public.complete_commercial_report_generation_v1(uuid,jsonb,integer,text) from public,anon;
grant execute on function public.complete_commercial_report_generation_v1(uuid,jsonb,integer,text) to authenticated;

create or replace function public.fail_commercial_report_generation_v1(p_generation_id uuid,p_category text,p_message text)
returns void language plpgsql security definer set search_path=public as $$
declare actor uuid:=auth.uid();
begin
  if not public.commercial_phase4_permission_allowed('commercial:reports:generate') then raise exception using errcode='42501',message='PHASE4_ACCESS_DENIED'; end if;
  perform set_config('app.phase4_internal','on',true);
  update public.commercial_report_generations set status='FAILED',error_category=left(coalesce(p_category,'UNKNOWN'),80),error_message=left(coalesce(p_message,'No se pudo generar el reporte.'),300),generated_at=now() where id=p_generation_id and actor_user_id=actor and status='PENDING';
  perform set_config('app.phase4_internal','off',true);
  if found then insert into public.commercial_report_generation_events(generation_id,event_type,actor_user_id,metadata) values(p_generation_id,'FAILED',actor,jsonb_build_object('category',left(coalesce(p_category,'UNKNOWN'),80))); end if;
end $$;
revoke all on function public.fail_commercial_report_generation_v1(uuid,text,text) from public,anon;
grant execute on function public.fail_commercial_report_generation_v1(uuid,text,text) to authenticated;

create or replace function public.list_commercial_report_history_v1(p_limit integer default 10,p_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path=public as $$
declare result jsonb;
begin
  if not public.commercial_phase4_permission_allowed('commercial:reports:read') then raise exception using errcode='42501',message='PHASE4_ACCESS_DENIED'; end if;
  with rows as (select g.*,coalesce(u.full_name,u.username,split_part(u.email,'@',1),'Usuario') actor_name from public.commercial_report_generations g join public.users u on u.id=g.actor_user_id order by g.created_at desc,g.id desc limit least(greatest(p_limit,1),50) offset least(greatest(p_offset,0),10000))
  select jsonb_build_object('results',coalesce((select jsonb_agg(jsonb_build_object('generationId',id,'reportType',report_type,'format',format,'status',status,'reportName',report_name,'filters',normalized_filters,'rowCount',row_count,'generatedAt',generated_at,'createdAt',created_at,'generatedByName',actor_name,'errorCategory',error_category) order by created_at desc,id desc) from rows),'[]'::jsonb),'total',(select count(*) from public.commercial_report_generations)) into result;
  return result;
end $$;
revoke all on function public.list_commercial_report_history_v1(integer,integer) from public,anon;
grant execute on function public.list_commercial_report_history_v1(integer,integer) to authenticated;

create or replace function public.get_commercial_report_snapshot_v1(p_generation_id uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb;
begin
  if not public.commercial_phase4_permission_allowed('commercial:reports:generate') then raise exception using errcode='42501',message='PHASE4_ACCESS_DENIED'; end if;
  select jsonb_build_object('generationId',g.id,'reportType',g.report_type,'format',g.format,'reportName',g.report_name,'filters',g.normalized_filters,'sections',g.included_sections,'columns',g.included_columns,'snapshot',g.report_snapshot,'snapshotHash',g.snapshot_hash) into result from public.commercial_report_generations g where g.id=p_generation_id and g.status='READY';
  if result is null then raise exception using errcode='P0002',message='REPORT_GENERATION_NOT_FOUND'; end if;
  insert into public.commercial_report_generation_events(generation_id,event_type,actor_user_id) values(p_generation_id,'DOWNLOADED',auth.uid());
  return result;
end $$;
revoke all on function public.get_commercial_report_snapshot_v1(uuid) from public,anon;
grant execute on function public.get_commercial_report_snapshot_v1(uuid) to authenticated;

insert into public.notification_preferences(notification_type,module,label,internal_enabled,email_enabled,push_enabled,destination_roles)
values ('commission.policy.assigned','sistema','Política de comisión asignada',true,false,true,array[]::text[]),('commercial.report.ready','sistema','Reporte comercial listo',true,false,true,array['technical_owner','business_owner','admin']::text[]),('commercial.report.failed','sistema','Falló un reporte comercial',true,false,true,array['technical_owner','business_owner','admin']::text[])
on conflict(notification_type) do update set label=excluded.label,updated_at=now();

commit;
