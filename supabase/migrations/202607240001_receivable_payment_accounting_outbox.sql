-- Transactional accounting outbox and directed draft policy for receivable payments.
-- Global accounting automation remains unchanged. Only the exact
-- receivable_payment/receivable_payment/v1 contract is handled here.

alter table public.accounts_receivable_payments
  add column if not exists balance_before numeric(12, 2),
  add column if not exists balance_after numeric(12, 2);

alter table public.accounts_receivable_payments
  drop constraint if exists accounts_receivable_payments_balance_trace_check,
  add constraint accounts_receivable_payments_balance_trace_check check (
    (balance_before is null and balance_after is null)
    or (
      balance_before is not null
      and balance_after is not null
      and balance_before >= 0
      and balance_after >= 0
      and balance_after <= balance_before
    )
  );

create table public.accounting_outbox (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  source_id uuid not null references public.accounts_receivable_payments(id) on delete restrict,
  event_purpose text not null,
  posting_version text not null default 'v1',
  status text not null default 'queued',
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  locked_by text,
  last_error text,
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_outbox_source_contract_check check (
    source_type = 'receivable_payment'
    and event_purpose = 'receivable_payment'
    and posting_version = 'v1'
  ),
  constraint accounting_outbox_status_check check (
    status in ('queued', 'processing', 'completed', 'failed')
  ),
  constraint accounting_outbox_attempts_check check (attempts >= 0),
  constraint accounting_outbox_lock_check check (
    (status = 'processing' and locked_at is not null and locked_by is not null)
    or status <> 'processing'
  ),
  constraint accounting_outbox_error_length_check check (
    last_error is null or char_length(last_error) <= 500
  ),
  constraint accounting_outbox_source_unique unique (
    source_type,
    source_id,
    event_purpose,
    posting_version
  )
);

create index accounting_outbox_dispatch_idx
  on public.accounting_outbox (status, available_at, created_at)
  where status in ('queued', 'failed');
create index accounting_outbox_source_idx
  on public.accounting_outbox (source_type, source_id);
create index accounting_outbox_failed_attempts_idx
  on public.accounting_outbox (attempts desc, updated_at)
  where status = 'failed';

create trigger accounting_outbox_set_updated_at
before update on public.accounting_outbox
for each row execute function public.set_updated_at();

alter table public.accounting_outbox enable row level security;

create policy accounting_outbox_authorized_read
  on public.accounting_outbox
  for select
  using (
    public.has_permission('accounting:read')
    and public.current_actor_role() in (
      'technical_owner',
      'business_owner',
      'admin',
      'contadora'
    )
  );

grant select on public.accounting_outbox to authenticated;
revoke insert, update, delete on public.accounting_outbox from authenticated;
grant select, insert, update, delete on public.accounting_outbox to service_role;

comment on table public.accounting_outbox is
  'Transactional recovery queue for exact receivable payment accounting facts. Authenticated mutations are RPC-only.';

create or replace function public.prepare_receivable_payment_accounting_trace_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  current_balance numeric(12, 2);
begin
  select balance_due
    into current_balance
    from public.accounts_receivable
    where id = new.receivable_id
    for update;

  if current_balance is null then
    raise exception 'No se puede registrar el abono sin una cuenta por cobrar valida.';
  end if;

  new.balance_before := current_balance;
  new.balance_after := greatest(round(current_balance - new.amount, 2), 0);
  return new;
end;
$$;

revoke all on function public.prepare_receivable_payment_accounting_trace_v1() from public;

create or replace function public.enqueue_receivable_payment_accounting_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.accounting_outbox (
    source_type,
    source_id,
    event_purpose,
    posting_version,
    status,
    available_at
  )
  values (
    'receivable_payment',
    new.id,
    'receivable_payment',
    'v1',
    'queued',
    now()
  );

  return new;
end;
$$;

revoke all on function public.enqueue_receivable_payment_accounting_v1() from public;

drop trigger if exists accounts_receivable_payments_prepare_accounting_trace_v1
  on public.accounts_receivable_payments;
create trigger accounts_receivable_payments_prepare_accounting_trace_v1
before insert on public.accounts_receivable_payments
for each row execute function public.prepare_receivable_payment_accounting_trace_v1();

drop trigger if exists accounts_receivable_payments_enqueue_accounting_v1
  on public.accounts_receivable_payments;
create trigger accounts_receivable_payments_enqueue_accounting_v1
after insert on public.accounts_receivable_payments
for each row execute function public.enqueue_receivable_payment_accounting_v1();

-- Preserve the battle-tested payment implementation as an inaccessible core,
-- then expose the same signature with a richer, idempotent result contract.
alter function public.register_credit_receivable_payment(
  uuid,
  numeric,
  text,
  text,
  timestamptz,
  text,
  text,
  text,
  text
) rename to register_credit_receivable_payment_core_v1;

revoke all on function public.register_credit_receivable_payment_core_v1(
  uuid,
  numeric,
  text,
  text,
  timestamptz,
  text,
  text,
  text,
  text
) from public, anon, authenticated;

create function public.register_credit_receivable_payment(
  target_receivable_id uuid,
  payment_amount numeric,
  received_payment_method text,
  payment_reference text default null,
  payment_received_at timestamptz default now(),
  payment_note text default null,
  payment_receipt_url text default null,
  payment_receipt_public_id text default null,
  request_key text default null
)
returns table (
  payment_id uuid,
  receivable_id uuid,
  previous_balance numeric,
  balance_due numeric,
  total_paid numeric,
  receivable_status text,
  queued_email_id uuid,
  outbox_id uuid,
  outbox_created boolean,
  idempotent_replay boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  normalized_request_key text := nullif(left(btrim(coalesce(request_key, '')), 200), '');
  existing_payment_id uuid;
  existing_outbox_id uuid;
  core_result record;
  payment_row public.accounts_receivable_payments%rowtype;
  ensured_outbox_id uuid;
begin
  if actor_id is null
    or actor_role_name not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('credit:mark_paid')
  then
    raise exception 'No tienes permiso para registrar abonos de credito comercial.';
  end if;

  if normalized_request_key is not null then
    perform pg_advisory_xact_lock(hashtextextended(normalized_request_key, 0));

    select payment.id
      into existing_payment_id
      from public.accounts_receivable_payments payment
      where payment.idempotency_key = normalized_request_key
      limit 1;

    if existing_payment_id is not null then
      select box.id
        into existing_outbox_id
        from public.accounting_outbox box
        where box.source_type = 'receivable_payment'
          and box.source_id = existing_payment_id
          and box.event_purpose = 'receivable_payment'
          and box.posting_version = 'v1';
    end if;
  end if;

  select *
    into core_result
    from public.register_credit_receivable_payment_core_v1(
      target_receivable_id,
      payment_amount,
      received_payment_method,
      payment_reference,
      payment_received_at,
      payment_note,
      payment_receipt_url,
      payment_receipt_public_id,
      normalized_request_key
    );

  if core_result.payment_id is null then
    raise exception 'El abono no devolvio un identificador recuperable.';
  end if;

  select *
    into payment_row
    from public.accounts_receivable_payments payment
    where payment.id = core_result.payment_id;

  if not found then
    raise exception 'El abono confirmado no se pudo recuperar.';
  end if;

  insert into public.accounting_outbox (
    source_type,
    source_id,
    event_purpose,
    posting_version,
    status,
    available_at
  )
  values (
    'receivable_payment',
    payment_row.id,
    'receivable_payment',
    'v1',
    'queued',
    now()
  )
  on conflict (source_type, source_id, event_purpose, posting_version)
  do nothing
  returning id into ensured_outbox_id;

  if ensured_outbox_id is null then
    select box.id
      into ensured_outbox_id
      from public.accounting_outbox box
      where box.source_type = 'receivable_payment'
        and box.source_id = payment_row.id
        and box.event_purpose = 'receivable_payment'
        and box.posting_version = 'v1';
  end if;

  if ensured_outbox_id is null then
    raise exception 'No se pudo asegurar la trazabilidad contable del abono.';
  end if;

  payment_id := payment_row.id;
  receivable_id := payment_row.receivable_id;
  previous_balance := payment_row.balance_before;
  balance_due := payment_row.balance_after;
  total_paid := core_result.total_paid;
  receivable_status := core_result.receivable_status;
  queued_email_id := core_result.queued_email_id;
  outbox_id := ensured_outbox_id;
  outbox_created := existing_outbox_id is null;
  idempotent_replay := existing_payment_id is not null;
  return next;
end;
$$;

revoke all on function public.register_credit_receivable_payment(
  uuid,
  numeric,
  text,
  text,
  timestamptz,
  text,
  text,
  text,
  text
) from public, anon;
grant execute on function public.register_credit_receivable_payment(
  uuid,
  numeric,
  text,
  text,
  timestamptz,
  text,
  text,
  text,
  text
) to authenticated;

create or replace function public.process_receivable_payment_accounting_outbox_v1(
  target_outbox_id uuid,
  worker_token text,
  force_retry boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  clean_worker_token text := nullif(left(btrim(coalesce(worker_token, '')), 120), '');
  service_call boolean := coalesce(auth.role(), '') = 'service_role';
  box public.accounting_outbox%rowtype;
  payment record;
  payment_date date;
  payment_mapping_id uuid;
  receivable_mapping_id uuid;
  event_status text;
  event_errors jsonb := '[]'::jsonb;
  reason_code text;
  event_row public.financial_events%rowtype;
begin
  if not service_call and (
    actor_id is null
    or actor_role_name not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('accounting:manage')
  ) then
    raise exception 'No tienes permiso para procesar eventos contables de abonos.';
  end if;

  if clean_worker_token is null then
    raise exception 'El procesador contable requiere un identificador de trabajo.';
  end if;

  select *
    into box
    from public.accounting_outbox
    where id = target_outbox_id
    for update skip locked;

  if not found then
    return jsonb_build_object(
      'ok', true,
      'claimed', false,
      'outbox_id', target_outbox_id,
      'outbox_status', 'processing',
      'reason', 'already_processing'
    );
  end if;

  if box.source_type <> 'receivable_payment'
    or box.event_purpose <> 'receivable_payment'
    or box.posting_version <> 'v1'
  then
    raise exception 'La fila de outbox no pertenece al contrato contable de abonos v1.';
  end if;

  select event.*
    into event_row
    from public.financial_events event
    where event.source_type = box.source_type
      and event.source_id = box.source_id::text
      and event.event_purpose = box.event_purpose
      and event.posting_version = box.posting_version;

  if box.status = 'completed'
    and not (
      force_retry
      and event_row.id is not null
      and event_row.journal_entry_id is null
      and event_row.status in ('pending', 'ready', 'failed')
    )
  then
    return jsonb_build_object(
      'ok', true,
      'claimed', false,
      'outbox_id', box.id,
      'outbox_status', box.status,
      'attempts', box.attempts,
      'event_id', event_row.id,
      'event_status', event_row.status,
      'journal_entry_id', event_row.journal_entry_id,
      'reason', case
        when event_row.status = 'skipped' then 'payment_voided'
        else 'already_completed'
      end
    );
  end if;

  if box.status = 'processing'
    and box.locked_at >= now() - interval '15 minutes'
    and box.locked_by is distinct from clean_worker_token
  then
    return jsonb_build_object(
      'ok', true,
      'claimed', false,
      'outbox_id', box.id,
      'outbox_status', box.status,
      'attempts', box.attempts,
      'reason', 'already_processing'
    );
  end if;

  if box.available_at > now() and not force_retry then
    return jsonb_build_object(
      'ok', true,
      'claimed', false,
      'outbox_id', box.id,
      'outbox_status', box.status,
      'attempts', box.attempts,
      'reason', 'retry_not_available'
    );
  end if;

  update public.accounting_outbox
    set status = 'processing',
        attempts = attempts + 1,
        locked_at = now(),
        locked_by = clean_worker_token,
        last_error = null,
        processed_at = null
    where id = box.id
    returning * into box;

  select
      payment_row.id,
      payment_row.receivable_id,
      payment_row.customer_id,
      payment_row.order_id,
      payment_row.amount,
      payment_row.payment_method,
      payment_row.reference,
      payment_row.received_at,
      payment_row.recorded_by,
      payment_row.voided_at,
      receivable.invoice_id,
      coalesce(customer.business_name, customer.contact_name, 'Cliente') as customer_name,
      order_row.order_number
    into payment
    from public.accounts_receivable_payments payment_row
    join public.accounts_receivable receivable on receivable.id = payment_row.receivable_id
    join public.customers customer on customer.id = payment_row.customer_id
    left join public.orders order_row on order_row.id = payment_row.order_id
    where payment_row.id = box.source_id
    for share of payment_row, receivable;

  if payment.id is null then
    raise exception 'El abono de la outbox no existe.';
  end if;

  if payment.payment_method not in ('cash', 'bank_transfer', 'card') then
    raise exception 'El abono tiene un metodo de pago no soportado.';
  end if;

  payment_date := (payment.received_at at time zone 'America/Tegucigalpa')::date;

  select mapping.id
    into payment_mapping_id
    from public.accounting_mappings mapping
    join public.accounting_accounts account on account.id = mapping.account_id
    where mapping.mapping_type = 'payment_method'
      and mapping.source_key = payment.payment_method
      and mapping.is_active = true
      and account.is_active = true
      and (mapping.effective_from is null or mapping.effective_from <= payment_date)
      and (mapping.effective_to is null or mapping.effective_to >= payment_date)
    order by mapping.priority, mapping.created_at, mapping.id
    limit 1;

  select mapping.id
    into receivable_mapping_id
    from public.accounting_mappings mapping
    join public.accounting_accounts account on account.id = mapping.account_id
    where mapping.mapping_type = 'receivable'
      and mapping.source_key = 'accounts_receivable'
      and mapping.is_active = true
      and account.is_active = true
      and (mapping.effective_from is null or mapping.effective_from <= payment_date)
      and (mapping.effective_to is null or mapping.effective_to >= payment_date)
    order by mapping.priority, mapping.created_at, mapping.id
    limit 1;

  if payment.voided_at is not null then
    event_status := 'skipped';
    reason_code := 'payment_voided';
    event_errors := jsonb_build_array('El abono a cuenta por cobrar esta anulado y no puede generar una partida normal.');
  elsif payment_mapping_id is null or receivable_mapping_id is null then
    event_status := 'pending';
    reason_code := 'mapping_missing';
    if payment_mapping_id is null then
      event_errors := event_errors || jsonb_build_array(
        'Mapeo faltante o inactivo: payment_method:' || payment.payment_method || '.'
      );
    end if;
    if receivable_mapping_id is null then
      event_errors := event_errors || jsonb_build_array(
        'Mapeo faltante o inactivo: receivable:accounts_receivable.'
      );
    end if;
  elsif public.is_date_in_closed_accounting_period(payment_date) then
    event_status := 'pending';
    reason_code := 'period_closed';
    event_errors := jsonb_build_array(
      'El periodo contable de la fecha efectiva del abono esta cerrado.'
    );
  else
    event_status := 'ready';
    reason_code := null;
  end if;

  insert into public.financial_events (
    source_type,
    source_id,
    event_purpose,
    posting_version,
    status,
    occurred_at,
    source_snapshot,
    validation_errors,
    created_by
  )
  values (
    'receivable_payment',
    payment.id::text,
    'receivable_payment',
    'v1',
    event_status,
    payment.received_at,
    jsonb_build_object(
      'event_type', 'receivable_payment_received',
      'source_id', payment.id,
      'payment_id', payment.id,
      'receivable_id', payment.receivable_id,
      'customer_id', payment.customer_id,
      'customer_name', payment.customer_name,
      'order_id', payment.order_id,
      'order_number', payment.order_number,
      'invoice_id', payment.invoice_id,
      'recorded_by', payment.recorded_by,
      'payment_method', payment.payment_method,
      'reference', payment.reference,
      'amount', round(payment.amount, 2),
      'total', round(payment.amount, 2),
      'occurred_at', payment.received_at,
      'effective_date', payment_date,
      'status', case when payment.voided_at is null then 'received' else 'voided' end,
      'currency', 'HNL'
    ),
    event_errors,
    actor_id
  )
  on conflict (source_type, source_id, event_purpose, posting_version)
  do update set
    status = case
      when public.financial_events.journal_entry_id is null
        and public.financial_events.status not in ('posted', 'reversed')
      then excluded.status
      else public.financial_events.status
    end,
    occurred_at = excluded.occurred_at,
    source_snapshot = case
      when public.financial_events.status not in ('posted', 'reversed')
      then excluded.source_snapshot
      else public.financial_events.source_snapshot
    end,
    validation_errors = case
      when public.financial_events.journal_entry_id is null
        and public.financial_events.status not in ('posted', 'reversed')
      then excluded.validation_errors
      else public.financial_events.validation_errors
    end,
    updated_at = now()
  returning * into event_row;

  insert into public.accounting_event_log (
    event_type,
    entity_type,
    entity_id,
    source_type,
    source_id,
    metadata,
    created_by
  )
  values (
    case when box.attempts > 1
      then 'receivable_payment.outbox_retried'
      else 'receivable_payment.outbox_claimed'
    end,
    'accounting_outbox',
    box.id,
    'receivable_payment',
    payment.id::text,
    jsonb_build_object(
      'attempt', box.attempts,
      'event_id', event_row.id,
      'event_status', event_row.status,
      'reason', reason_code,
      'worker', left(clean_worker_token, 24)
    ),
    actor_id
  );

  return jsonb_build_object(
    'ok', true,
    'claimed', true,
    'outbox_id', box.id,
    'outbox_status', box.status,
    'attempts', box.attempts,
    'event_id', event_row.id,
    'event_status', event_row.status,
    'journal_entry_id', event_row.journal_entry_id,
    'reason', reason_code,
    'validation_errors', event_row.validation_errors
  );
exception
  when others then
    if box.id is not null then
      update public.accounting_outbox
        set status = 'failed',
            locked_at = null,
            locked_by = null,
            last_error = left(
              regexp_replace(
                coalesce(sqlerrm, 'Fallo tecnico durante el procesamiento contable.'),
                E'[\\n\\r\\t]+',
                ' ',
                'g'
              ),
              500
            ),
            available_at = now() + make_interval(mins => least(greatest(box.attempts, 1), 30))
        where id = box.id;
    end if;
    return jsonb_build_object(
      'ok', false,
      'claimed', box.id is not null,
      'outbox_id', coalesce(box.id, target_outbox_id),
      'outbox_status', 'failed',
      'attempts', coalesce(box.attempts, 0),
      'reason', 'technical_error',
      'error', left(
        regexp_replace(
          coalesce(sqlerrm, 'Fallo tecnico durante el procesamiento contable.'),
          E'[\\n\\r\\t]+',
          ' ',
          'g'
        ),
        500
      )
    );
end;
$$;

revoke all on function public.process_receivable_payment_accounting_outbox_v1(
  uuid,
  text,
  boolean
) from public, anon;
grant execute on function public.process_receivable_payment_accounting_outbox_v1(
  uuid,
  text,
  boolean
) to authenticated, service_role;

create or replace function public.complete_receivable_payment_accounting_outbox_v1(
  target_outbox_id uuid,
  worker_token text,
  target_event_id uuid,
  target_journal_entry_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  service_call boolean := coalesce(auth.role(), '') = 'service_role';
  box public.accounting_outbox%rowtype;
begin
  if not service_call and (
    actor_id is null
    or actor_role_name not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('accounting:manage')
  ) then
    raise exception 'No tienes permiso para completar eventos contables de abonos.';
  end if;

  select *
    into box
    from public.accounting_outbox
    where id = target_outbox_id
    for update;

  if not found then
    raise exception 'La fila de outbox no existe.';
  end if;

  if box.status = 'completed' then
    return jsonb_build_object('ok', true, 'outbox_id', box.id, 'status', box.status);
  end if;

  if box.status <> 'processing' or box.locked_by is distinct from left(btrim(worker_token), 120) then
    raise exception 'La fila de outbox no pertenece a este procesador.';
  end if;

  if not exists (
    select 1
    from public.financial_events event
    where event.id = target_event_id
      and event.source_type = box.source_type
      and event.source_id = box.source_id::text
      and event.event_purpose = box.event_purpose
      and event.posting_version = box.posting_version
      and (
        target_journal_entry_id is null
        or event.journal_entry_id = target_journal_entry_id
      )
  ) then
    raise exception 'El evento financiero no coincide con la outbox.';
  end if;

  update public.accounting_outbox
    set status = 'completed',
        processed_at = now(),
        locked_at = null,
        locked_by = null,
        last_error = null
    where id = box.id;

  insert into public.accounting_event_log (
    event_type,
    entity_type,
    entity_id,
    source_type,
    source_id,
    metadata,
    created_by
  )
  values (
    'receivable_payment.outbox_completed',
    'accounting_outbox',
    box.id,
    box.source_type,
    box.source_id::text,
    jsonb_build_object(
      'attempts', box.attempts,
      'event_id', target_event_id,
      'journal_entry_id', target_journal_entry_id
    ),
    actor_id
  );

  return jsonb_build_object('ok', true, 'outbox_id', box.id, 'status', 'completed');
end;
$$;

revoke all on function public.complete_receivable_payment_accounting_outbox_v1(
  uuid,
  text,
  uuid,
  uuid
) from public, anon;
grant execute on function public.complete_receivable_payment_accounting_outbox_v1(
  uuid,
  text,
  uuid,
  uuid
) to authenticated, service_role;

create or replace function public.fail_receivable_payment_accounting_outbox_v1(
  target_outbox_id uuid,
  worker_token text,
  error_message text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  service_call boolean := coalesce(auth.role(), '') = 'service_role';
  clean_error text := left(
    regexp_replace(
      coalesce(nullif(btrim(error_message), ''), 'Fallo tecnico durante el procesamiento contable.'),
      E'[\\n\\r\\t]+',
      ' ',
      'g'
    ),
    500
  );
  box public.accounting_outbox%rowtype;
begin
  if not service_call and (
    actor_id is null
    or actor_role_name not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('accounting:manage')
  ) then
    raise exception 'No tienes permiso para actualizar la outbox contable.';
  end if;

  select *
    into box
    from public.accounting_outbox
    where id = target_outbox_id
    for update;

  if not found then
    raise exception 'La fila de outbox no existe.';
  end if;

  if box.status = 'completed' then
    return jsonb_build_object('ok', true, 'outbox_id', box.id, 'status', box.status);
  end if;

  if box.status <> 'processing' or box.locked_by is distinct from left(btrim(worker_token), 120) then
    raise exception 'La fila de outbox no pertenece a este procesador.';
  end if;

  update public.accounting_outbox
    set status = 'failed',
        available_at = now() + make_interval(mins => least(greatest(attempts, 1), 30)),
        locked_at = null,
        locked_by = null,
        last_error = clean_error
    where id = box.id;

  insert into public.accounting_event_log (
    event_type,
    entity_type,
    entity_id,
    source_type,
    source_id,
    metadata,
    created_by
  )
  values (
    'receivable_payment.outbox_failed',
    'accounting_outbox',
    box.id,
    box.source_type,
    box.source_id::text,
    jsonb_build_object('attempts', box.attempts, 'error', clean_error),
    actor_id
  );

  return jsonb_build_object(
    'ok', true,
    'outbox_id', box.id,
    'status', 'failed',
    'retry_available_at', now() + make_interval(mins => least(greatest(box.attempts, 1), 30))
  );
end;
$$;

revoke all on function public.fail_receivable_payment_accounting_outbox_v1(
  uuid,
  text,
  text
) from public, anon;
grant execute on function public.fail_receivable_payment_accounting_outbox_v1(
  uuid,
  text,
  text
) to authenticated, service_role;

-- Remove direct authenticated writes. Existing trusted server services use the
-- service role; end-user mutations must go through audited RPCs.
drop policy if exists "Accounting create financial events" on public.financial_events;
drop policy if exists "Accounting update financial events" on public.financial_events;
revoke insert, update, delete on public.financial_events from authenticated;

-- Harden automatic receivable-payment drafts: the database, not the browser,
-- determines the amount, date and mapped accounts.
alter function public.create_journal_draft_from_financial_event(
  uuid,
  date,
  text,
  jsonb,
  text,
  text
) rename to create_journal_draft_from_financial_event_core_v1;

revoke all on function public.create_journal_draft_from_financial_event_core_v1(
  uuid,
  date,
  text,
  jsonb,
  text,
  text
) from public, anon, authenticated;

create function public.create_journal_draft_from_financial_event(
  financial_event_id uuid,
  entry_date_value date,
  description_value text,
  lines_data jsonb,
  actor_ip text default null,
  actor_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  target_event public.financial_events%rowtype;
  payment record;
  payment_date date;
  debit_account_id uuid;
  credit_account_id uuid;
  canonical_lines jsonb;
  canonical_description text;
begin
  select *
    into target_event
    from public.financial_events event
    where event.id = financial_event_id
    for update;

  if not found then
    raise exception 'El evento financiero no existe.';
  end if;

  if target_event.event_purpose = 'receivable_paid' then
    raise exception 'El evento receivable_paid es un control no monetario y no puede generar una partida.';
  end if;

  if target_event.source_type = 'receivable_payment'
    or target_event.event_purpose = 'receivable_payment'
  then
    if target_event.source_type <> 'receivable_payment'
      or target_event.event_purpose <> 'receivable_payment'
      or target_event.posting_version <> 'v1'
    then
      raise exception 'El contrato del evento de abono no es valido.';
    end if;

    if actor_id is null
      or actor_role_name not in ('technical_owner', 'business_owner', 'admin', 'contadora')
      or not public.has_permission('accounting:manage')
    then
      raise exception 'No tienes permiso para generar borradores de abonos.';
    end if;

    select
        payment_row.id,
        payment_row.receivable_id,
        payment_row.customer_id,
        payment_row.amount,
        payment_row.payment_method,
        payment_row.received_at,
        payment_row.recorded_by,
        payment_row.voided_at
      into payment
      from public.accounts_receivable_payments payment_row
      where payment_row.id::text = target_event.source_id
      for share;

    if payment.id is null then
      raise exception 'El abono vinculado no existe.';
    end if;

    if payment.voided_at is not null then
      raise exception 'Un abono anulado no puede generar una partida normal.';
    end if;

    if target_event.journal_entry_id is not null then
      raise exception 'Este evento ya tiene una partida asociada.';
    end if;

    payment_date := (payment.received_at at time zone 'America/Tegucigalpa')::date;

    select mapping.account_id
      into debit_account_id
      from public.accounting_mappings mapping
      join public.accounting_accounts account on account.id = mapping.account_id
      where mapping.mapping_type = 'payment_method'
        and mapping.source_key = payment.payment_method
        and mapping.is_active = true
        and account.is_active = true
        and (mapping.effective_from is null or mapping.effective_from <= payment_date)
        and (mapping.effective_to is null or mapping.effective_to >= payment_date)
      order by mapping.priority, mapping.created_at, mapping.id
      limit 1;

    select mapping.account_id
      into credit_account_id
      from public.accounting_mappings mapping
      join public.accounting_accounts account on account.id = mapping.account_id
      where mapping.mapping_type = 'receivable'
        and mapping.source_key = 'accounts_receivable'
        and mapping.is_active = true
        and account.is_active = true
        and (mapping.effective_from is null or mapping.effective_from <= payment_date)
        and (mapping.effective_to is null or mapping.effective_to >= payment_date)
      order by mapping.priority, mapping.created_at, mapping.id
      limit 1;

    if debit_account_id is null then
      raise exception 'No existe un mapeo activo para payment_method:%.', payment.payment_method;
    end if;

    if credit_account_id is null then
      raise exception 'No existe un mapeo activo para receivable:accounts_receivable.';
    end if;

    canonical_description := 'Borrador de abono a cuenta por cobrar '
      || left(payment.id::text, 8);
    canonical_lines := jsonb_build_array(
      jsonb_build_object(
        'account_id', debit_account_id,
        'debit', round(payment.amount, 2),
        'credit', 0,
        'description', 'Abono recibido ' || left(payment.id::text, 8),
        'customer_id', payment.customer_id
      ),
      jsonb_build_object(
        'account_id', credit_account_id,
        'debit', 0,
        'credit', round(payment.amount, 2),
        'description', 'Aplicacion a cuenta por cobrar ' || left(payment.receivable_id::text, 8),
        'customer_id', payment.customer_id
      )
    );

    return public.create_journal_draft_from_financial_event_core_v1(
      target_event.id,
      payment_date,
      canonical_description,
      canonical_lines,
      actor_ip,
      actor_user_agent
    );
  end if;

  return public.create_journal_draft_from_financial_event_core_v1(
    financial_event_id,
    entry_date_value,
    description_value,
    lines_data,
    actor_ip,
    actor_user_agent
  );
end;
$$;

revoke all on function public.create_journal_draft_from_financial_event(
  uuid,
  date,
  text,
  jsonb,
  text,
  text
) from public, anon;
grant execute on function public.create_journal_draft_from_financial_event(
  uuid,
  date,
  text,
  jsonb,
  text,
  text
) to authenticated;

-- Prevent publication of a normal draft after its payment was voided.
alter function public.post_journal_entry(
  uuid,
  integer,
  text,
  text
) rename to post_journal_entry_core_v1;

revoke all on function public.post_journal_entry_core_v1(
  uuid,
  integer,
  text,
  text
) from public, anon, authenticated;

create function public.post_journal_entry(
  target_entry_id uuid,
  expected_version integer,
  actor_ip text default null,
  actor_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text := public.current_actor_role();
  event_row public.financial_events%rowtype;
begin
  select event.*
    into event_row
    from public.journal_entries entry
    join public.financial_events event
      on event.id::text = entry.source_id
     and entry.source_type = 'financial_event'
    where entry.id = target_entry_id;

  if event_row.id is not null
    and (
      event_row.source_type = 'receivable_payment'
      or event_row.event_purpose = 'receivable_payment'
    )
  then
    if event_row.source_type <> 'receivable_payment'
      or event_row.event_purpose <> 'receivable_payment'
      or event_row.posting_version <> 'v1'
    then
      raise exception 'El contrato del evento de abono no es valido.';
    end if;

    if actor_id is null
      or actor_role_name not in ('technical_owner', 'business_owner', 'admin', 'contadora')
      or not public.has_permission('accounting:post')
    then
      raise exception 'No tienes permiso para publicar partidas de abonos.';
    end if;

    if not exists (
      select 1
      from public.accounts_receivable_payments payment
      where payment.id::text = event_row.source_id
        and payment.voided_at is null
    ) then
      raise exception 'El abono fue anulado. La partida no puede publicarse; utiliza el flujo formal de revision o reversion.';
    end if;
  end if;

  return public.post_journal_entry_core_v1(
    target_entry_id,
    expected_version,
    actor_ip,
    actor_user_agent
  );
end;
$$;

revoke all on function public.post_journal_entry(
  uuid,
  integer,
  text,
  text
) from public, anon;
grant execute on function public.post_journal_entry(
  uuid,
  integer,
  text,
  text
) to authenticated;

-- Preserve controlled rollback of imported receivables without leaving orphan
-- accounting facts. Once any imported payment has a journal entry, rollback is
-- no longer deletion-safe and must use the formal accounting flow instead.
create or replace function public.rollback_historical_accounts_receivable_import(
  target_batch_id uuid,
  rollback_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_payments integer := 0;
  deleted_receivables integer := 0;
begin
  if not public.has_import_foundation_permission('accounts_receivable', 'rollback') then
    raise exception 'Solo technical_owner o business_owner pueden revertir un lote aplicado.';
  end if;

  if not exists (
    select 1
    from public.import_batches
    where id = target_batch_id
      and module = 'accounts_receivable'
      and status = 'applied'
  ) then
    raise exception 'Solo se puede revertir un lote aplicado de cuentas por cobrar.';
  end if;

  if exists (
    select 1
    from public.accounts_receivable_payments payment_row
    join public.accounts_receivable receivable on receivable.id = payment_row.receivable_id
    join public.financial_events event
      on event.source_type = 'receivable_payment'
     and event.source_id = payment_row.id::text
     and event.event_purpose = 'receivable_payment'
     and event.posting_version = 'v1'
    where receivable.imported_from_batch_id = target_batch_id
      and event.journal_entry_id is not null
  ) then
    raise exception 'El lote tiene abonos con partidas contables. Utiliza el flujo formal de revision o reversion.';
  end if;

  delete from public.accounting_outbox box
  using public.accounts_receivable_payments payment_row,
        public.accounts_receivable receivable
  where box.source_type = 'receivable_payment'
    and box.source_id = payment_row.id
    and payment_row.receivable_id = receivable.id
    and receivable.imported_from_batch_id = target_batch_id;

  delete from public.financial_events event
  using public.accounts_receivable_payments payment_row,
        public.accounts_receivable receivable
  where event.source_type = 'receivable_payment'
    and event.source_id = payment_row.id::text
    and event.event_purpose = 'receivable_payment'
    and event.posting_version = 'v1'
    and event.journal_entry_id is null
    and payment_row.receivable_id = receivable.id
    and receivable.imported_from_batch_id = target_batch_id;

  delete from public.accounts_receivable_payments payment_row
  using public.accounts_receivable receivable
  where payment_row.receivable_id = receivable.id
    and receivable.imported_from_batch_id = target_batch_id;
  get diagnostics deleted_payments = row_count;

  delete from public.accounts_receivable
  where imported_from_batch_id = target_batch_id;
  get diagnostics deleted_receivables = row_count;

  update public.import_rows
  set apply_status = 'rolled_back',
      updated_at = now()
  where batch_id = target_batch_id
    and apply_status = 'applied';

  update public.import_batches
  set status = 'rolled_back',
      rollback_reason = nullif(trim(coalesce(rollback_historical_accounts_receivable_import.rollback_reason, '')), ''),
      rolled_back_at = now(),
      completed_at = now(),
      updated_at = now()
  where id = target_batch_id;

  insert into public.import_audit_events (batch_id, module, event_type, metadata, created_by)
  values (
    target_batch_id,
    'accounts_receivable',
    'batch_rolled_back',
    jsonb_build_object(
      'receivables', deleted_receivables,
      'payments', deleted_payments,
      'reason', rollback_reason,
      'accounting_trace_removed', true
    ),
    auth.uid()
  );

  insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
  values (
    auth.uid(),
    public.current_actor_role(),
    'accounts_receivable',
    target_batch_id,
    'historical_receivable_import.rolled_back',
    jsonb_build_object(
      'receivables', deleted_receivables,
      'payments', deleted_payments,
      'reason', rollback_reason,
      'accounting_trace_removed', true
    )
  );

  return jsonb_build_object('receivables', deleted_receivables, 'payments', deleted_payments);
end;
$$;

revoke all on function public.rollback_historical_accounts_receivable_import(uuid, text)
  from public, anon;
grant execute on function public.rollback_historical_accounts_receivable_import(uuid, text)
  to authenticated;

comment on function public.process_receivable_payment_accounting_outbox_v1(
  uuid,
  text,
  boolean
) is
  'Claims one exact receivable-payment outbox row with row locking, reconstructs its financial event from DB facts, and never posts.';
