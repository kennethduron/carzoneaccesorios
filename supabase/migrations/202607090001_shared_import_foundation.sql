create table if not exists public.import_batches (
  id uuid primary key default gen_random_uuid(),
  module text not null,
  status text not null default 'uploaded',
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  total_rows integer not null default 0 check (total_rows >= 0),
  pending_rows integer not null default 0 check (pending_rows >= 0),
  validated_rows integer not null default 0 check (validated_rows >= 0),
  applied_rows integer not null default 0 check (applied_rows >= 0),
  failed_rows integer not null default 0 check (failed_rows >= 0),
  rollback_batch_id uuid references public.import_batches(id) on delete set null,
  rollback_reason text,
  audit_log_id uuid references public.audit_logs(id) on delete set null,
  completed_at timestamptz,
  applied_at timestamptz,
  rolled_back_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  constraint import_batches_module_check check (module in ('accounts_receivable', 'accounts_payable')),
  constraint import_batches_status_check check (status in ('uploaded', 'validating', 'validated', 'pending_assignment', 'ready', 'applied', 'cancelled', 'rolled_back', 'failed'))
);

create table if not exists public.import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  module text not null,
  row_number integer not null check (row_number > 0),
  original_data jsonb not null default '{}'::jsonb,
  normalized_data jsonb not null default '{}'::jsonb,
  validation_status text not null default 'pending',
  validation_messages jsonb not null default '[]'::jsonb,
  suggested_customer_id uuid references public.customers(id) on delete set null,
  suggested_supplier_id uuid references public.suppliers(id) on delete set null,
  assignment_type text not null default 'none',
  assignment_status text not null default 'not_required',
  assigned_customer_id uuid references public.customers(id) on delete set null,
  assigned_supplier_id uuid references public.suppliers(id) on delete set null,
  assigned_by uuid references public.users(id) on delete set null,
  assigned_at timestamptz,
  apply_status text not null default 'pending',
  apply_error text,
  audit_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_rows_module_check check (module in ('accounts_receivable', 'accounts_payable')),
  constraint import_rows_validation_status_check check (validation_status in ('pending', 'valid', 'invalid', 'warning')),
  constraint import_rows_assignment_type_check check (assignment_type in ('none', 'customer', 'supplier')),
  constraint import_rows_assignment_status_check check (assignment_status in ('not_required', 'pending', 'suggested', 'manual', 'confirmed', 'unassigned')),
  constraint import_rows_apply_status_check check (apply_status in ('pending', 'ready', 'applied', 'skipped', 'failed', 'rolled_back')),
  constraint import_rows_validation_messages_array check (jsonb_typeof(validation_messages) = 'array')
);

create table if not exists public.import_audit_events (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.import_batches(id) on delete cascade,
  row_id uuid references public.import_rows(id) on delete cascade,
  module text not null,
  event_type text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint import_audit_events_module_check check (module in ('accounts_receivable', 'accounts_payable')),
  constraint import_audit_events_type_not_empty check (char_length(trim(event_type)) > 0)
);

create index if not exists import_batches_module_status_idx on public.import_batches(module, status, created_at desc);
create index if not exists import_batches_created_by_idx on public.import_batches(created_by, created_at desc);
create index if not exists import_rows_batch_row_idx on public.import_rows(batch_id, row_number);
create index if not exists import_rows_assignment_idx on public.import_rows(batch_id, assignment_type, assignment_status);
create index if not exists import_rows_apply_idx on public.import_rows(batch_id, apply_status);
create index if not exists import_audit_events_batch_idx on public.import_audit_events(batch_id, created_at desc);

alter table public.import_batches enable row level security;
alter table public.import_rows enable row level security;
alter table public.import_audit_events enable row level security;

drop trigger if exists import_batches_set_updated_at on public.import_batches;
create trigger import_batches_set_updated_at
before update on public.import_batches
for each row execute function public.set_updated_at();

drop trigger if exists import_rows_set_updated_at on public.import_rows;
create trigger import_rows_set_updated_at
before update on public.import_rows
for each row execute function public.set_updated_at();

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
  end if;

  return false;
end;
$$;

create policy import_batches_select
  on public.import_batches for select
  using (public.has_import_foundation_permission(module, 'review') or created_by = auth.uid());

create policy import_batches_insert
  on public.import_batches for insert
  with check (public.has_import_foundation_permission(module, 'import'));

create policy import_batches_update
  on public.import_batches for update
  using (public.has_import_foundation_permission(module, 'import') or public.has_import_foundation_permission(module, 'apply') or public.has_import_foundation_permission(module, 'rollback'))
  with check (public.has_import_foundation_permission(module, 'import') or public.has_import_foundation_permission(module, 'apply') or public.has_import_foundation_permission(module, 'rollback'));

create policy import_rows_select
  on public.import_rows for select
  using (public.has_import_foundation_permission(module, 'review'));

create policy import_rows_insert
  on public.import_rows for insert
  with check (public.has_import_foundation_permission(module, 'import'));

create policy import_rows_update
  on public.import_rows for update
  using (public.has_import_foundation_permission(module, 'import') or public.has_import_foundation_permission(module, 'assign') or public.has_import_foundation_permission(module, 'apply') or public.has_import_foundation_permission(module, 'rollback'))
  with check (public.has_import_foundation_permission(module, 'import') or public.has_import_foundation_permission(module, 'assign') or public.has_import_foundation_permission(module, 'apply') or public.has_import_foundation_permission(module, 'rollback'));

create policy import_audit_events_select
  on public.import_audit_events for select
  using (public.has_import_foundation_permission(module, 'audit'));

create policy import_audit_events_insert
  on public.import_audit_events for insert
  with check (public.has_import_foundation_permission(module, 'import') or public.has_import_foundation_permission(module, 'assign') or public.has_import_foundation_permission(module, 'apply') or public.has_import_foundation_permission(module, 'rollback'));

create or replace function public.recount_import_batch(target_batch_id uuid)
returns public.import_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  target_module text;
  refreshed_batch public.import_batches;
begin
  select module into target_module from public.import_batches where id = target_batch_id;
  if target_module is null then
    raise exception 'Import batch not found';
  end if;

  if not public.has_import_foundation_permission(target_module, 'review') then
    raise exception 'Insufficient import review permission';
  end if;

  update public.import_batches batch
  set
    total_rows = counts.total_rows,
    pending_rows = counts.pending_rows,
    validated_rows = counts.validated_rows,
    applied_rows = counts.applied_rows,
    failed_rows = counts.failed_rows,
    updated_at = now()
  from (
    select
      count(*)::integer as total_rows,
      count(*) filter (where assignment_status in ('pending', 'suggested', 'unassigned'))::integer as pending_rows,
      count(*) filter (where validation_status in ('valid', 'warning'))::integer as validated_rows,
      count(*) filter (where apply_status = 'applied')::integer as applied_rows,
      count(*) filter (where validation_status = 'invalid' or apply_status = 'failed')::integer as failed_rows
    from public.import_rows
    where batch_id = target_batch_id
  ) counts
  where batch.id = target_batch_id
  returning batch.* into refreshed_batch;

  return refreshed_batch;
end;
$$;

create or replace function public.create_import_batch(import_module text, batch_metadata jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_batch_id uuid;
begin
  if import_module not in ('accounts_receivable', 'accounts_payable') then
    raise exception 'Unsupported import module';
  end if;

  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if not public.has_import_foundation_permission(import_module, 'import') then
    raise exception 'Insufficient import permission';
  end if;

  insert into public.import_batches (module, created_by, metadata)
  values (import_module, auth.uid(), coalesce(batch_metadata, '{}'::jsonb))
  returning id into new_batch_id;

  insert into public.import_audit_events (batch_id, module, event_type, metadata, created_by)
  values (new_batch_id, import_module, 'batch_created', coalesce(batch_metadata, '{}'::jsonb), auth.uid());

  return new_batch_id;
end;
$$;

create or replace function public.set_import_batch_status(target_batch_id uuid, next_status text, status_metadata jsonb default '{}'::jsonb)
returns public.import_batches
language plpgsql
security definer
set search_path = public
as $$
declare
  target_module text;
  refreshed_batch public.import_batches;
begin
  select module into target_module from public.import_batches where id = target_batch_id;
  if target_module is null then
    raise exception 'Import batch not found';
  end if;

  if next_status not in ('uploaded', 'validating', 'validated', 'pending_assignment', 'ready', 'applied', 'cancelled', 'rolled_back', 'failed') then
    raise exception 'Unsupported import batch status';
  end if;

  if next_status in ('applied') and not public.has_import_foundation_permission(target_module, 'apply') then
    raise exception 'Insufficient import apply permission';
  elsif next_status in ('rolled_back') and not public.has_import_foundation_permission(target_module, 'rollback') then
    raise exception 'Insufficient import rollback permission';
  elsif not public.has_import_foundation_permission(target_module, 'import') then
    raise exception 'Insufficient import permission';
  end if;

  update public.import_batches
  set
    status = next_status,
    metadata = metadata || coalesce(status_metadata, '{}'::jsonb),
    completed_at = case when next_status in ('applied', 'cancelled', 'rolled_back', 'failed') then now() else completed_at end,
    applied_at = case when next_status = 'applied' then now() else applied_at end,
    rolled_back_at = case when next_status = 'rolled_back' then now() else rolled_back_at end,
    updated_at = now()
  where id = target_batch_id
  returning * into refreshed_batch;

  insert into public.import_audit_events (batch_id, module, event_type, metadata, created_by)
  values (target_batch_id, target_module, 'batch_status_changed', jsonb_build_object('status', next_status) || coalesce(status_metadata, '{}'::jsonb), auth.uid());

  return refreshed_batch;
end;
$$;

create or replace function public.upsert_import_rows(target_batch_id uuid, row_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_module text;
  inserted_count integer := 0;
begin
  select module into target_module from public.import_batches where id = target_batch_id;
  if target_module is null then
    raise exception 'Import batch not found';
  end if;

  if not public.has_import_foundation_permission(target_module, 'import') then
    raise exception 'Insufficient import permission';
  end if;

  if coalesce(jsonb_array_length(row_payload), 0) > 1000 then
    raise exception 'Import row limit exceeded';
  end if;

  delete from public.import_rows where batch_id = target_batch_id;

  insert into public.import_rows (
    batch_id,
    module,
    row_number,
    original_data,
    normalized_data,
    validation_status,
    validation_messages,
    suggested_customer_id,
    suggested_supplier_id,
    assignment_type,
    assignment_status,
    apply_status,
    audit_metadata
  )
  select
    target_batch_id,
    target_module,
    coalesce(nullif(value->>'row_number', '')::integer, row_number() over ()) as row_number,
    coalesce(value->'original_data', '{}'::jsonb),
    coalesce(value->'normalized_data', '{}'::jsonb),
    coalesce(nullif(value->>'validation_status', ''), 'pending'),
    coalesce(value->'validation_messages', '[]'::jsonb),
    nullif(value->>'suggested_customer_id', '')::uuid,
    nullif(value->>'suggested_supplier_id', '')::uuid,
    coalesce(nullif(value->>'assignment_type', ''), 'none'),
    coalesce(nullif(value->>'assignment_status', ''), 'not_required'),
    coalesce(nullif(value->>'apply_status', ''), 'pending'),
    coalesce(value->'audit_metadata', '{}'::jsonb)
  from jsonb_array_elements(coalesce(row_payload, '[]'::jsonb)) as payload(value);

  get diagnostics inserted_count = row_count;

  perform public.recount_import_batch(target_batch_id);

  insert into public.import_audit_events (batch_id, module, event_type, metadata, created_by)
  values (target_batch_id, target_module, 'rows_staged', jsonb_build_object('rows', inserted_count), auth.uid());

  return jsonb_build_object('rows', inserted_count);
end;
$$;

create or replace function public.assign_import_row(target_row_id uuid, target_customer_id uuid default null, target_supplier_id uuid default null, assignment_metadata jsonb default '{}'::jsonb)
returns public.import_rows
language plpgsql
security definer
set search_path = public
as $$
declare
  target_module text;
  updated_row public.import_rows;
begin
  select module into target_module from public.import_rows where id = target_row_id;
  if target_module is null then
    raise exception 'Import row not found';
  end if;

  if not public.has_import_foundation_permission(target_module, 'assign') then
    raise exception 'Insufficient import assignment permission';
  end if;

  if target_module = 'accounts_receivable' and target_customer_id is null then
    raise exception 'Customer assignment is required for accounts receivable';
  end if;

  if target_module = 'accounts_payable' and target_supplier_id is null then
    raise exception 'Supplier assignment is required for accounts payable';
  end if;

  update public.import_rows
  set
    assigned_customer_id = case when target_module = 'accounts_receivable' then target_customer_id else assigned_customer_id end,
    assigned_supplier_id = case when target_module = 'accounts_payable' then target_supplier_id else assigned_supplier_id end,
    assignment_type = case when target_module = 'accounts_receivable' then 'customer' else 'supplier' end,
    assignment_status = 'manual',
    assigned_by = auth.uid(),
    assigned_at = now(),
    audit_metadata = audit_metadata || coalesce(assignment_metadata, '{}'::jsonb),
    updated_at = now()
  where id = target_row_id
  returning * into updated_row;

  insert into public.import_audit_events (batch_id, row_id, module, event_type, metadata, created_by)
  values (updated_row.batch_id, updated_row.id, updated_row.module, 'row_assigned', coalesce(assignment_metadata, '{}'::jsonb), auth.uid());

  return updated_row;
end;
$$;

create or replace function public.confirm_import_row_assignment(target_row_id uuid, confirmation_metadata jsonb default '{}'::jsonb)
returns public.import_rows
language plpgsql
security definer
set search_path = public
as $$
declare
  target_module text;
  updated_row public.import_rows;
begin
  select module into target_module from public.import_rows where id = target_row_id;
  if target_module is null then
    raise exception 'Import row not found';
  end if;

  if not public.has_import_foundation_permission(target_module, 'assign') then
    raise exception 'Insufficient import assignment permission';
  end if;

  update public.import_rows
  set
    assignment_status = 'confirmed',
    audit_metadata = audit_metadata || coalesce(confirmation_metadata, '{}'::jsonb),
    updated_at = now()
  where id = target_row_id
    and (
      (module = 'accounts_receivable' and assigned_customer_id is not null)
      or (module = 'accounts_payable' and assigned_supplier_id is not null)
      or assignment_type = 'none'
    )
  returning * into updated_row;

  if updated_row.id is null then
    raise exception 'Import row cannot be confirmed without an assignment';
  end if;

  insert into public.import_audit_events (batch_id, row_id, module, event_type, metadata, created_by)
  values (updated_row.batch_id, updated_row.id, updated_row.module, 'row_assignment_confirmed', coalesce(confirmation_metadata, '{}'::jsonb), auth.uid());

  perform public.recount_import_batch(updated_row.batch_id);

  return updated_row;
end;
$$;

grant execute on function public.has_import_foundation_permission(text, text) to authenticated;
grant execute on function public.recount_import_batch(uuid) to authenticated;
grant execute on function public.create_import_batch(text, jsonb) to authenticated;
grant execute on function public.set_import_batch_status(uuid, text, jsonb) to authenticated;
grant execute on function public.upsert_import_rows(uuid, jsonb) to authenticated;
grant execute on function public.assign_import_row(uuid, uuid, uuid, jsonb) to authenticated;
grant execute on function public.confirm_import_row_assignment(uuid, jsonb) to authenticated;
