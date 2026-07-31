-- Controlled containment for accounting outbox retries.
-- Additive only: no existing outbox is held and no business row is processed.

alter table public.accounting_outbox_v2
  add column if not exists processing_hold boolean not null default false,
  add column if not exists hold_reason text,
  add column if not exists held_at timestamptz,
  add column if not exists held_by uuid references public.users(id) on delete set null;

alter table public.accounting_outbox_v2
  drop constraint if exists accounting_outbox_v2_hold_contract_check,
  add constraint accounting_outbox_v2_hold_contract_check check (
    (
      processing_hold
      and hold_reason is not null
      and char_length(hold_reason) between 4 and 500
      and held_at is not null
    )
    or (
      not processing_hold
      and hold_reason is null
      and held_at is null
      and held_by is null
    )
  );

create index if not exists accounting_outbox_v2_held_idx
  on public.accounting_outbox_v2(held_at, id)
  where processing_hold;

-- Service-role incident operations must remain auditable without impersonating a
-- human actor. Authenticated behavior is unchanged.
create or replace function public.write_audit_log(
  target_table text,
  target_record_id uuid,
  action_name text,
  previous_data jsonb default null,
  next_data jsonb default null,
  actor_ip text default null,
  actor_user_agent text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  log_id uuid;
  actor_id uuid := auth.uid();
  service_call boolean := coalesce(auth.role(), '') = 'service_role';
  actor_role_name text := case
    when service_call then 'service_role'
    else public.current_actor_role()
  end;
  safe_actor_ip inet;
begin
  if actor_id is null and not service_call then
    raise exception 'Authentication required';
  end if;

  begin
    safe_actor_ip := nullif(trim(coalesce(actor_ip, '')), '')::inet;
  exception
    when invalid_text_representation then
      safe_actor_ip := null;
  end;

  insert into public.audit_logs (
    user_id, actor_role, table_name, record_id, action,
    old_data, new_data, ip_address, user_agent
  )
  values (
    actor_id, actor_role_name, target_table, target_record_id, action_name,
    previous_data, next_data, safe_actor_ip,
    nullif(trim(coalesce(actor_user_agent, '')), '')
  )
  returning id into log_id;

  return log_id;
end;
$$;

revoke all on function public.write_audit_log(
  text, uuid, text, jsonb, jsonb, text, text
) from public, anon;
grant execute on function public.write_audit_log(
  text, uuid, text, jsonb, jsonb, text, text
) to authenticated, service_role;

create or replace function public.hold_accounting_outbox_v1(
  p_outbox_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := auth.uid();
  service_call boolean := coalesce(auth.role(), '') = 'service_role';
  clean_reason text := nullif(
    left(regexp_replace(btrim(coalesce(p_reason, '')), '\s+', ' ', 'g'), 500),
    ''
  );
  box public.accounting_outbox_v2%rowtype;
begin
  if not service_call and (
    caller_id is null
    or public.current_actor_role() <> 'technical_owner'
    or not public.has_permission('technical:tools')
  ) then
    raise exception using errcode = '42501', message = 'Solo el propietario tecnico puede retener la outbox.';
  end if;
  if p_outbox_id is null or clean_reason is null or char_length(clean_reason) < 4 then
    raise exception using errcode = '22023', message = 'La outbox y un motivo auditable son obligatorios.';
  end if;

  select * into box
  from public.accounting_outbox_v2
  where id = p_outbox_id
  for update;

  if box.id is null then
    raise exception using errcode = 'P0002', message = 'La outbox contable no existe.';
  end if;
  if box.status in ('completed', 'cancelled') then
    raise exception using errcode = '23514', message = 'Una outbox finalizada no puede retenerse.';
  end if;
  if box.status = 'processing' and box.lease_until > now() then
    raise exception using errcode = '55P03', message = 'La outbox tiene un lease activo.';
  end if;

  if box.processing_hold then
    if box.hold_reason is distinct from clean_reason then
      raise exception using errcode = '23505', message = 'La outbox ya esta retenida por otro motivo.';
    end if;
    return jsonb_build_object(
      'status', 'held', 'replayed', true, 'outbox_id', box.id,
      'held_at', box.held_at, 'hold_reason', box.hold_reason
    );
  end if;

  update public.accounting_outbox_v2
  set processing_hold = true,
      hold_reason = clean_reason,
      held_at = now(),
      held_by = caller_id,
      lease_until = null,
      locked_by = null
  where id = box.id
  returning * into box;

  perform public.write_audit_log(
    'accounting_outbox_v2',
    box.id,
    'accounting.outbox.held',
    null,
    jsonb_build_object(
      'outbox_id', box.id,
      'source_type', box.source_type,
      'source_id', box.source_id,
      'event_purpose', box.event_purpose,
      'reason', clean_reason
    )
  );

  return jsonb_build_object(
    'status', 'held', 'replayed', false, 'outbox_id', box.id,
    'held_at', box.held_at, 'hold_reason', box.hold_reason
  );
end;
$$;

create or replace function public.release_accounting_outbox_v1(
  p_outbox_id uuid,
  p_expected_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  caller_id uuid := auth.uid();
  service_call boolean := coalesce(auth.role(), '') = 'service_role';
  clean_reason text := nullif(
    left(regexp_replace(btrim(coalesce(p_expected_reason, '')), '\s+', ' ', 'g'), 500),
    ''
  );
  box public.accounting_outbox_v2%rowtype;
  previous_held_at timestamptz;
begin
  if not service_call and (
    caller_id is null
    or public.current_actor_role() <> 'technical_owner'
    or not public.has_permission('technical:tools')
  ) then
    raise exception using errcode = '42501', message = 'Solo el propietario tecnico puede liberar la outbox.';
  end if;
  if p_outbox_id is null or clean_reason is null then
    raise exception using errcode = '22023', message = 'La outbox y el motivo esperado son obligatorios.';
  end if;

  select * into box
  from public.accounting_outbox_v2
  where id = p_outbox_id
  for update;

  if box.id is null then
    raise exception using errcode = 'P0002', message = 'La outbox contable no existe.';
  end if;
  if not box.processing_hold then
    return jsonb_build_object('status', 'released', 'replayed', true, 'outbox_id', box.id);
  end if;
  if box.hold_reason is distinct from clean_reason then
    raise exception using errcode = '23505', message = 'El motivo de retencion no coincide.';
  end if;

  previous_held_at := box.held_at;
  update public.accounting_outbox_v2
  set processing_hold = false,
      hold_reason = null,
      held_at = null,
      held_by = null,
      next_attempt_at = least(next_attempt_at, now())
  where id = box.id;

  perform public.write_audit_log(
    'accounting_outbox_v2',
    box.id,
    'accounting.outbox.released',
    null,
    jsonb_build_object(
      'outbox_id', box.id,
      'source_type', box.source_type,
      'source_id', box.source_id,
      'event_purpose', box.event_purpose,
      'reason', clean_reason,
      'held_at', previous_held_at
    )
  );

  return jsonb_build_object('status', 'released', 'replayed', false, 'outbox_id', box.id);
end;
$$;

revoke all on function public.hold_accounting_outbox_v1(uuid, text)
  from public, anon, authenticated;
revoke all on function public.release_accounting_outbox_v1(uuid, text)
  from public, anon, authenticated;
grant execute on function public.hold_accounting_outbox_v1(uuid, text)
  to service_role;
grant execute on function public.release_accounting_outbox_v1(uuid, text)
  to service_role;
grant execute on function public.hold_accounting_outbox_v1(uuid, text)
  to authenticated;
grant execute on function public.release_accounting_outbox_v1(uuid, text)
  to authenticated;

create or replace function public.claim_due_accounting_outbox_v2(
  batch_size integer default 20
)
returns table (outbox_id uuid)
language sql
security definer
set search_path = public
as $$
  select box.id
  from public.accounting_outbox_v2 box
  where not box.processing_hold
    and (
      (
        box.status in ('queued', 'failed', 'pending_mapping', 'pending_data')
        and box.next_attempt_at <= now()
        and box.attempt_count < box.max_attempts
      )
      or (
        box.status = 'processing'
        and box.lease_until <= now()
        and box.attempt_count < box.max_attempts
      )
    )
  order by box.next_attempt_at, box.created_at
  limit least(greatest(batch_size, 1), 100)
  for update skip locked
$$;

revoke all on function public.claim_due_accounting_outbox_v2(integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_accounting_outbox_v2(integer)
  to service_role;
