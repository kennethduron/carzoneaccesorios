begin;

-- Additive capability only. Existing payables are deliberately not scanned,
-- classified, linked, drafted, or otherwise mutated by this migration.
create table public.manual_accounts_payable_recognitions (
  id uuid primary key default gen_random_uuid(),
  accounts_payable_id uuid not null
    constraint manual_ap_recognition_payable_fkey
    references public.accounts_payable(id) on delete restrict,
  state text not null default 'pending_accounting_recognition',
  accounting_date date,
  debit_account_id uuid
    constraint manual_ap_recognition_debit_account_fkey
    references public.accounting_accounts(id) on delete restrict,
  concept text,
  source_reference text,
  subtotal numeric(12, 2),
  tax_amount numeric(12, 2),
  discount_amount numeric(12, 2),
  financial_event_id uuid
    constraint manual_ap_recognition_event_fkey
    references public.financial_events(id) on delete restrict,
  journal_entry_id uuid
    constraint manual_ap_recognition_journal_fkey
    references public.journal_entries(id) on delete restrict,
  creation_request_key text not null,
  completion_request_key text,
  created_by uuid not null references public.users(id) on delete restrict,
  completed_by uuid references public.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint manual_ap_recognition_payable_unique unique (accounts_payable_id),
  constraint manual_ap_recognition_event_unique unique (financial_event_id),
  constraint manual_ap_recognition_journal_unique unique (journal_entry_id),
  constraint manual_ap_recognition_creation_request_unique unique (creation_request_key),
  constraint manual_ap_recognition_completion_request_unique unique (completion_request_key),
  constraint manual_ap_recognition_state_check check (state in (
    'pending_accounting_recognition',
    'draft_pending_publication',
    'recognized',
    'blocked'
  )),
  constraint manual_ap_recognition_amounts_non_negative check (
    (subtotal is null or subtotal >= 0) and
    (tax_amount is null or tax_amount >= 0) and
    (discount_amount is null or discount_amount >= 0)
  ),
  constraint manual_ap_recognition_concept_length check (
    concept is null or char_length(btrim(concept)) between 3 and 500
  ),
  constraint manual_ap_recognition_reference_length check (
    source_reference is null or char_length(btrim(source_reference)) between 2 and 240
  ),
  constraint manual_ap_recognition_completion_shape check (
    state = 'pending_accounting_recognition'
    or (
      accounting_date is not null and
      debit_account_id is not null and
      concept is not null and
      source_reference is not null and
      subtotal is not null and
      tax_amount is not null and
      discount_amount is not null and
      financial_event_id is not null and
      journal_entry_id is not null and
      completion_request_key is not null and
      completed_by is not null and
      completed_at is not null
    )
  )
);

create index manual_ap_recognition_state_idx
  on public.manual_accounts_payable_recognitions(state, updated_at desc);
create index manual_ap_recognition_debit_account_idx
  on public.manual_accounts_payable_recognitions(debit_account_id);

alter table public.manual_accounts_payable_recognitions enable row level security;

create policy manual_ap_recognition_select
  on public.manual_accounts_payable_recognitions for select
  using (
    public.has_permission('payables:read')
    or public.has_permission('payables:manage')
    or public.has_permission('accounting:read')
    or public.has_permission('accounting:manage')
  );

grant select on table public.manual_accounts_payable_recognitions
  to authenticated, service_role;

-- No direct insert/update/delete policies. Mutations must use the authenticated
-- transactional RPCs below so actor identity and accounting invariants cannot
-- be supplied or bypassed by the client.

create trigger manual_ap_recognition_set_updated_at
before update on public.manual_accounts_payable_recognitions
for each row execute function public.set_updated_at();

create or replace function public.sync_manual_ap_recognition_journal_state_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.manual_accounts_payable_recognitions recognition
  set state = case
        when new.status = 'publicada' then 'recognized'
        when new.status = 'borrador' then 'draft_pending_publication'
        else 'blocked'
      end
  where recognition.journal_entry_id = new.id;
  return new;
end;
$$;

revoke all on function public.sync_manual_ap_recognition_journal_state_v1()
  from public, anon, authenticated;

create trigger sync_manual_ap_recognition_journal_state_v1
after update of status on public.journal_entries
for each row
when (old.status is distinct from new.status)
execute function public.sync_manual_ap_recognition_journal_state_v1();

create or replace function public.guard_manual_ap_recognition_payable_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  recognition public.manual_accounts_payable_recognitions%rowtype;
  target_payable_id uuid;
begin
  if tg_op = 'DELETE' then
    target_payable_id := old.id;
  else
    target_payable_id := new.id;
  end if;

  select * into recognition
  from public.manual_accounts_payable_recognitions
  where accounts_payable_id = target_payable_id;

  if recognition.id is null then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'DELETE' and recognition.journal_entry_id is not null then
    raise exception using errcode = '55000', message = 'La cuenta por pagar tiene reconocimiento contable y no puede eliminarse.';
  end if;

  if tg_op = 'UPDATE' and recognition.journal_entry_id is not null and (
    new.supplier_id is distinct from old.supplier_id or
    new.purchase_id is distinct from old.purchase_id or
    new.supplier_invoice_id is distinct from old.supplier_invoice_id or
    new.total_amount is distinct from old.total_amount or
    new.currency is distinct from old.currency
  ) then
    raise exception using errcode = '55000', message = 'La clasificación contable ya tiene una partida vinculada y requiere una corrección controlada.';
  end if;

  if tg_op = 'UPDATE'
    and new.status = 'cancelled'
    and old.status is distinct from new.status
    and recognition.journal_entry_id is not null
  then
    raise exception using errcode = '55000', message = 'Primero debe revertir la partida contable vinculada.';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_manual_ap_recognition_payable_v1()
  from public, anon, authenticated;

create trigger guard_manual_ap_recognition_payable_v1
before update or delete on public.accounts_payable
for each row execute function public.guard_manual_ap_recognition_payable_v1();

create or replace function public.complete_manual_accounts_payable_recognition_v1(
  p_accounts_payable_id uuid,
  p_accounting_date date,
  p_debit_account_id uuid,
  p_concept text,
  p_source_reference text,
  p_subtotal numeric,
  p_tax_amount numeric,
  p_discount_amount numeric,
  p_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := public.current_actor_role();
  payable public.accounts_payable%rowtype;
  recognition public.manual_accounts_payable_recognitions%rowtype;
  debit_account public.accounting_accounts%rowtype;
  payable_account public.accounting_accounts%rowtype;
  tax_account public.accounting_accounts%rowtype;
  discount_account public.accounting_accounts%rowtype;
  event public.financial_events%rowtype;
  event_count integer := 0;
  linked_entry public.journal_entries%rowtype;
  clean_concept text := nullif(btrim(coalesce(p_concept, '')), '');
  clean_reference text := nullif(btrim(coalesce(p_source_reference, '')), '');
  clean_request text := nullif(btrim(coalesce(p_request_key, '')), '');
  normalized_subtotal numeric(12,2) := round(coalesce(p_subtotal, -1), 2);
  normalized_tax numeric(12,2) := round(coalesce(p_tax_amount, -1), 2);
  normalized_discount numeric(12,2) := round(coalesce(p_discount_amount, -1), 2);
  journal_lines jsonb := '[]'::jsonb;
  draft_result jsonb;
  draft_id uuid;
begin
  if actor_id is null
    or actor_role not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('payables:manage')
    or not public.has_permission('accounting:manage')
  then
    raise exception using errcode = '42501', message = 'No tienes permiso para completar reconocimientos contables.';
  end if;

  if clean_request is null or char_length(clean_request) not between 8 and 160 then
    raise exception using errcode = '22023', message = 'La solicitud de reconocimiento no es válida.';
  end if;

  select * into payable
  from public.accounts_payable
  where id = p_accounts_payable_id
  for update;
  if payable.id is null then
    raise exception using errcode = 'P0002', message = 'La cuenta por pagar no existe.';
  end if;
  if payable.purchase_id is not null
    or payable.supplier_invoice_id is not null
    or payable.automation_source is not null
    or payable.imported_from_batch_id is not null
    or payable.imported_from_row_id is not null
  then
    raise exception using errcode = '22023', message = 'Esta cuenta por pagar utiliza reconocimiento desde su documento origen.';
  end if;
  if payable.status in ('paid', 'cancelled') or payable.paid_amount <> 0 then
    raise exception using errcode = '55000', message = 'La cuenta por pagar ya no admite reconocimiento manual.';
  end if;
  if upper(btrim(payable.currency)) <> 'HNL' then
    raise exception using errcode = '22023', message = 'El reconocimiento manual solo admite obligaciones en HNL.';
  end if;
  if p_accounting_date is null or public.is_date_in_closed_accounting_period(p_accounting_date) then
    raise exception using errcode = '55000', message = 'La fecha contable no pertenece a un período abierto.';
  end if;
  if clean_concept is null or char_length(clean_concept) not between 3 and 500 then
    raise exception using errcode = '22023', message = 'Ingrese un concepto contable válido.';
  end if;
  if clean_reference is null or char_length(clean_reference) not between 2 and 240 then
    raise exception using errcode = '22023', message = 'Ingrese una referencia de respaldo válida.';
  end if;
  if normalized_subtotal <= 0 or normalized_tax < 0 or normalized_discount < 0 then
    raise exception using errcode = '22023', message = 'El desglose fiscal contiene importes inválidos.';
  end if;
  if round(normalized_subtotal + normalized_tax - normalized_discount, 2) <> round(payable.total_amount, 2) then
    raise exception using errcode = '22023', message = 'La información contable no coincide con el total de la obligación.';
  end if;

  select * into debit_account
  from public.accounting_accounts
  where id = p_debit_account_id;
  if debit_account.id is null
    or not debit_account.is_active
    or debit_account.normal_balance <> 'debit'
    or debit_account.type not in ('asset', 'cost', 'expense')
  then
    raise exception using errcode = '22023', message = 'Seleccione una cuenta de débito activa y válida.';
  end if;

  select account.* into payable_account
  from public.accounting_mappings mapping
  join public.accounting_accounts account on account.id = mapping.account_id
  where mapping.mapping_type = 'default_account'
    and mapping.source_key = 'accounts_payable'
    and mapping.is_active
    and account.is_active
  order by mapping.priority, mapping.created_at, mapping.id
  limit 1;
  if payable_account.id is null or payable_account.normal_balance <> 'credit' then
    raise exception using errcode = '55000', message = 'Falta la cuenta contable de proveedores por pagar.';
  end if;
  if debit_account.id = payable_account.id then
    raise exception using errcode = '22023', message = 'La cuenta de clasificación no puede ser la cuenta de proveedores por pagar.';
  end if;

  if normalized_tax > 0 then
    select account.* into tax_account
    from public.accounting_mappings mapping
    join public.accounting_accounts account on account.id = mapping.account_id
    where mapping.mapping_type = 'tax'
      and mapping.source_key = 'purchase_tax'
      and mapping.is_active
      and account.is_active
    order by mapping.priority, mapping.created_at, mapping.id
    limit 1;
    if tax_account.id is null or tax_account.normal_balance <> 'debit' then
      raise exception using errcode = '55000', message = 'Falta la cuenta contable de impuesto de compras.';
    end if;
  end if;

  if normalized_discount > 0 then
    select account.* into discount_account
    from public.accounting_mappings mapping
    join public.accounting_accounts account on account.id = mapping.account_id
    where mapping.mapping_type = 'discount'
      and mapping.source_key = 'purchase_discount'
      and mapping.is_active
      and account.is_active
    order by mapping.priority, mapping.created_at, mapping.id
    limit 1;
    if discount_account.id is null or discount_account.normal_balance <> 'credit' then
      raise exception using errcode = '55000', message = 'Falta la cuenta contable de descuento de compras.';
    end if;
  end if;

  insert into public.manual_accounts_payable_recognitions (
    accounts_payable_id, state, creation_request_key, created_by
  ) values (
    payable.id, 'pending_accounting_recognition', 'legacy:' || payable.id::text, actor_id
  )
  on conflict (accounts_payable_id) do nothing;

  select * into recognition
  from public.manual_accounts_payable_recognitions
  where accounts_payable_id = payable.id
  for update;

  if recognition.journal_entry_id is not null then
    select * into linked_entry from public.journal_entries where id = recognition.journal_entry_id;
    if linked_entry.id is null
      or recognition.financial_event_id is null
      or linked_entry.source_type <> 'financial_event'
      or linked_entry.source_id <> recognition.financial_event_id::text
    then
      raise exception using errcode = '55000', message = 'La vinculación del reconocimiento contable no es válida.';
    end if;
    if linked_entry.status not in ('borrador', 'publicada') then
      raise exception using errcode = '55000', message = 'La partida vinculada requiere una corrección contable controlada.';
    end if;
    return jsonb_build_object(
      'ok', true,
      'code', case when linked_entry.status = 'publicada' then 'CXP_ALREADY_RECOGNIZED' else 'CXP_RECOGNITION_DRAFT_EXISTS' end,
      'accounts_payable_id', payable.id,
      'recognition_id', recognition.id,
      'recognition_state', case when linked_entry.status = 'publicada' then 'recognized' else 'draft_pending_publication' end,
      'financial_event_id', recognition.financial_event_id,
      'journal_entry_id', recognition.journal_entry_id,
      'replayed', true
    );
  end if;

  select count(*) into event_count
  from public.financial_events
  where source_type = 'accounts_payable'
    and source_id = payable.id::text
    and event_purpose = 'accounts_payable_created'
    and posting_version = 'v1';
  if event_count > 1 then
    raise exception using errcode = '55000', message = 'La obligación tiene evidencia contable ambigua y requiere revisión.';
  end if;

  select * into event
  from public.financial_events
  where source_type = 'accounts_payable'
    and source_id = payable.id::text
    and event_purpose = 'accounts_payable_created'
    and posting_version = 'v1'
  for update;

  if event.id is not null and event.journal_entry_id is not null then
    select * into linked_entry from public.journal_entries where id = event.journal_entry_id;
    if linked_entry.id is null or linked_entry.source_type <> 'financial_event' or linked_entry.source_id <> event.id::text then
      raise exception using errcode = '55000', message = 'El evento contable tiene una vinculación incompatible.';
    end if;
    if linked_entry.status not in ('borrador', 'publicada') then
      raise exception using errcode = '55000', message = 'La partida vinculada requiere una corrección contable controlada.';
    end if;
    update public.manual_accounts_payable_recognitions
    set state = case when linked_entry.status = 'publicada' then 'recognized' else 'draft_pending_publication' end,
        financial_event_id = event.id,
        journal_entry_id = linked_entry.id,
        completion_request_key = clean_request,
        completed_by = actor_id,
        completed_at = coalesce(completed_at, now())
    where id = recognition.id;
    return jsonb_build_object(
      'ok', true,
      'code', case when linked_entry.status = 'publicada' then 'CXP_ALREADY_RECOGNIZED' else 'CXP_RECOGNITION_DRAFT_EXISTS' end,
      'accounts_payable_id', payable.id,
      'recognition_id', recognition.id,
      'recognition_state', case when linked_entry.status = 'publicada' then 'recognized' else 'draft_pending_publication' end,
      'financial_event_id', event.id,
      'journal_entry_id', linked_entry.id,
      'replayed', true
    );
  end if;

  if event.id is null then
    insert into public.financial_events (
      source_type, source_id, event_purpose, posting_version, status,
      occurred_at, accounting_date, source_snapshot, validation_errors, created_by
    ) values (
      'accounts_payable', payable.id::text, 'accounts_payable_created', 'v1', 'ready',
      payable.created_at, p_accounting_date, '{}'::jsonb, '[]'::jsonb, actor_id
    ) returning * into event;
  end if;

  update public.financial_events
  set status = 'ready',
      accounting_date = p_accounting_date,
      source_snapshot = jsonb_build_object(
        'snapshot_version', 'manual_accounts_payable_recognition_v1',
        'source_type', 'accounts_payable',
        'source_id', payable.id,
        'accounts_payable_id', payable.id,
        'supplier_id', payable.supplier_id,
        'vendor_id', payable.supplier_id,
        'currency', 'HNL',
        'subtotal', normalized_subtotal,
        'tax_amount', normalized_tax,
        'discount_amount', normalized_discount,
        'shipping_amount', 0,
        'total_amount', payable.total_amount,
        'fiscal_breakdown_status', 'complete',
        'fiscal_source', 'manual_accounts_payable_recognition_v1',
        'accounting_date', p_accounting_date,
        'manual_debit_account_id', debit_account.id,
        'manual_debit_account_code', debit_account.code,
        'manual_concept', clean_concept,
        'source_reference', clean_reference
      ),
      validation_errors = '[]'::jsonb,
      journal_entry_id = null,
      updated_at = now()
  where id = event.id
  returning * into event;

  journal_lines := journal_lines || jsonb_build_array(jsonb_build_object(
    'account_id', debit_account.id,
    'debit', normalized_subtotal,
    'credit', 0,
    'description', clean_concept,
    'vendor_id', payable.supplier_id
  ));
  if normalized_tax > 0 then
    journal_lines := journal_lines || jsonb_build_array(jsonb_build_object(
      'account_id', tax_account.id,
      'debit', normalized_tax,
      'credit', 0,
      'description', 'Impuesto de compras',
      'vendor_id', payable.supplier_id
    ));
  end if;
  if normalized_discount > 0 then
    journal_lines := journal_lines || jsonb_build_array(jsonb_build_object(
      'account_id', discount_account.id,
      'debit', 0,
      'credit', normalized_discount,
      'description', 'Descuento de la obligación',
      'vendor_id', payable.supplier_id
    ));
  end if;
  journal_lines := journal_lines || jsonb_build_array(jsonb_build_object(
    'account_id', payable_account.id,
    'debit', 0,
    'credit', payable.total_amount,
    'description', 'Proveedores por pagar',
    'vendor_id', payable.supplier_id
  ));

  select public.create_journal_draft_from_financial_event(
    event.id,
    p_accounting_date,
    clean_concept,
    journal_lines,
    null,
    null
  ) into draft_result;
  draft_id := nullif(draft_result->>'journal_entry_id', '')::uuid;
  if draft_id is null then
    raise exception using errcode = '55000', message = 'No se pudo crear el borrador contable vinculado.';
  end if;

  update public.manual_accounts_payable_recognitions
  set state = 'draft_pending_publication',
      accounting_date = p_accounting_date,
      debit_account_id = debit_account.id,
      concept = clean_concept,
      source_reference = clean_reference,
      subtotal = normalized_subtotal,
      tax_amount = normalized_tax,
      discount_amount = normalized_discount,
      financial_event_id = event.id,
      journal_entry_id = draft_id,
      completion_request_key = clean_request,
      completed_by = actor_id,
      completed_at = now()
  where id = recognition.id
  returning * into recognition;

  perform public.write_audit_log(
    'manual_accounts_payable_recognitions', recognition.id,
    'manual_accounts_payable_recognition.completed', null,
    jsonb_build_object(
      'accounts_payable_id', payable.id,
      'recognition_state', recognition.state,
      'accounting_date', recognition.accounting_date,
      'debit_account_id', recognition.debit_account_id,
      'subtotal', recognition.subtotal,
      'tax_amount', recognition.tax_amount,
      'discount_amount', recognition.discount_amount,
      'financial_event_id', recognition.financial_event_id,
      'journal_entry_id', recognition.journal_entry_id,
      'actor_role', actor_role
    ), null, null
  );
  insert into public.accounting_event_log (
    event_type, entity_type, entity_id, source_type, source_id, metadata, created_by
  ) values (
    'manual_accounts_payable_recognition.completed',
    'manual_accounts_payable_recognitions', recognition.id,
    'accounts_payable', payable.id::text,
    jsonb_build_object(
      'recognition_state', recognition.state,
      'financial_event_id', recognition.financial_event_id,
      'journal_entry_id', recognition.journal_entry_id,
      'debit_account_id', recognition.debit_account_id,
      'actor_role', actor_role
    ), actor_id
  );

  return jsonb_build_object(
    'ok', true,
    'code', 'CXP_RECOGNITION_DRAFT_CREATED',
    'accounts_payable_id', payable.id,
    'recognition_id', recognition.id,
    'recognition_state', recognition.state,
    'financial_event_id', recognition.financial_event_id,
    'journal_entry_id', recognition.journal_entry_id,
    'replayed', false
  );
end;
$$;

revoke all on function public.complete_manual_accounts_payable_recognition_v1(
  uuid, date, uuid, text, text, numeric, numeric, numeric, text
) from public, anon;
grant execute on function public.complete_manual_accounts_payable_recognition_v1(
  uuid, date, uuid, text, text, numeric, numeric, numeric, text
) to authenticated;

create or replace function public.create_manual_accounts_payable_v1(
  p_supplier_id uuid,
  p_total_amount numeric,
  p_due_date date,
  p_currency text,
  p_notes text,
  p_recognition_mode text,
  p_accounting_date date,
  p_debit_account_id uuid,
  p_concept text,
  p_source_reference text,
  p_subtotal numeric,
  p_tax_amount numeric,
  p_discount_amount numeric,
  p_request_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  actor_id uuid := auth.uid();
  actor_role text := public.current_actor_role();
  payable public.accounts_payable%rowtype;
  recognition public.manual_accounts_payable_recognitions%rowtype;
  event public.financial_events%rowtype;
  clean_request text := nullif(btrim(coalesce(p_request_key, '')), '');
  clean_mode text := lower(btrim(coalesce(p_recognition_mode, '')));
  result jsonb;
begin
  if actor_id is null
    or actor_role not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('payables:manage')
  then
    raise exception using errcode = '42501', message = 'No tienes permiso para crear cuentas por pagar manuales.';
  end if;
  if clean_mode not in ('pending', 'complete') then
    raise exception using errcode = '22023', message = 'Seleccione cómo guardar el reconocimiento contable.';
  end if;
  if clean_mode = 'complete' and not public.has_permission('accounting:manage') then
    raise exception using errcode = '42501', message = 'No tienes permiso para completar reconocimientos contables.';
  end if;
  if clean_request is null or char_length(clean_request) not between 8 and 160 then
    raise exception using errcode = '22023', message = 'La solicitud de creación no es válida.';
  end if;
  if p_total_amount is null or round(p_total_amount, 2) <= 0 then
    raise exception using errcode = '22023', message = 'El total por pagar debe ser mayor que cero.';
  end if;
  if upper(btrim(coalesce(p_currency, 'HNL'))) <> 'HNL' then
    raise exception using errcode = '22023', message = 'Las cuentas por pagar manuales solo admiten HNL.';
  end if;
  if not exists (
    select 1 from public.suppliers where id = p_supplier_id and is_active
  ) then
    raise exception using errcode = '22023', message = 'Seleccione un proveedor activo.';
  end if;

  select ap.* into payable
  from public.manual_accounts_payable_recognitions existing
  join public.accounts_payable ap on ap.id = existing.accounts_payable_id
  where existing.creation_request_key = clean_request;
  if payable.id is not null then
    select * into recognition
    from public.manual_accounts_payable_recognitions
    where accounts_payable_id = payable.id;
    return jsonb_build_object(
      'ok', true,
      'code', case
        when recognition.state = 'pending_accounting_recognition' then 'CXP_CREATED_PENDING_RECOGNITION'
        else 'CXP_CREATED_RECOGNITION_DRAFT'
      end,
      'accounts_payable_id', payable.id,
      'recognition_id', recognition.id,
      'recognition_state', recognition.state,
      'financial_event_id', recognition.financial_event_id,
      'journal_entry_id', recognition.journal_entry_id,
      'replayed', true
    );
  end if;

  insert into public.accounts_payable (
    supplier_id, purchase_id, supplier_invoice_id, total_amount, paid_amount,
    due_date, status, currency, notes, created_by
  ) values (
    p_supplier_id, null, null, round(p_total_amount, 2), 0,
    p_due_date, 'pending', 'HNL', nullif(btrim(coalesce(p_notes, '')), ''), actor_id
  ) returning * into payable;

  insert into public.financial_events (
    source_type, source_id, event_purpose, posting_version, status,
    occurred_at, accounting_date, source_snapshot, validation_errors, created_by
  ) values (
    'accounts_payable', payable.id::text, 'accounts_payable_created', 'v1', 'pending',
    payable.created_at, p_accounting_date,
    jsonb_build_object(
      'snapshot_version', 'manual_accounts_payable_recognition_v1',
      'source_type', 'accounts_payable',
      'source_id', payable.id,
      'accounts_payable_id', payable.id,
      'supplier_id', payable.supplier_id,
      'vendor_id', payable.supplier_id,
      'currency', 'HNL',
      'total_amount', payable.total_amount,
      'fiscal_breakdown_status', 'missing',
      'fiscal_source', 'manual_accounts_payable_pending'
    ),
    jsonb_build_array('La cuenta por pagar está pendiente de reconocimiento contable.'),
    actor_id
  ) returning * into event;

  insert into public.manual_accounts_payable_recognitions (
    accounts_payable_id, state, financial_event_id, creation_request_key, created_by
  ) values (
    payable.id, 'pending_accounting_recognition', event.id, clean_request, actor_id
  ) returning * into recognition;

  perform public.write_audit_log(
    'accounts_payable', payable.id, 'accounts_payable.manual_created', null,
    jsonb_build_object(
      'supplier_id', payable.supplier_id,
      'total_amount', payable.total_amount,
      'currency', payable.currency,
      'recognition_state', recognition.state,
      'financial_event_id', event.id,
      'actor_role', actor_role
    ), null, null
  );

  if clean_mode = 'complete' then
    select public.complete_manual_accounts_payable_recognition_v1(
      payable.id, p_accounting_date, p_debit_account_id, p_concept,
      p_source_reference, p_subtotal, p_tax_amount, p_discount_amount,
      clean_request
    ) into result;
    return result || jsonb_build_object('code', 'CXP_CREATED_RECOGNITION_DRAFT');
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', 'CXP_CREATED_PENDING_RECOGNITION',
    'accounts_payable_id', payable.id,
    'recognition_id', recognition.id,
    'recognition_state', recognition.state,
    'financial_event_id', event.id,
    'journal_entry_id', null,
    'replayed', false
  );
end;
$$;

revoke all on function public.create_manual_accounts_payable_v1(
  uuid, numeric, date, text, text, text, date, uuid, text, text,
  numeric, numeric, numeric, text
) from public, anon;
grant execute on function public.create_manual_accounts_payable_v1(
  uuid, numeric, date, text, text, text, date, uuid, text, text,
  numeric, numeric, numeric, text
) to authenticated;

create or replace function public.search_manual_payable_debit_accounts_v1(
  p_query text default null,
  p_limit integer default 25,
  p_offset integer default 0
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
set search_path = public, pg_temp
as $$
declare
  actor_role text := public.current_actor_role();
  normalized_query text := translate(lower(btrim(regexp_replace(coalesce(p_query, ''), '\s+', ' ', 'g'))), 'áéíóúüñ', 'aeiouun');
  safe_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  safe_offset integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
begin
  if auth.uid() is null
    or actor_role not in ('technical_owner', 'business_owner', 'admin', 'contadora')
    or not public.has_permission('accounting:manage')
  then
    raise exception using errcode = '42501', message = 'No tienes permiso para clasificar cuentas por pagar.';
  end if;

  return query
  with ranked as (
    select account.id, account.code, account.name, account.type as account_type,
      account.normal_balance, account.is_active, account.parent_id,
      true as is_selectable,
      case
        when normalized_query = '' then 50
        when translate(lower(account.code), 'áéíóúüñ', 'aeiouun') = normalized_query then 0
        when translate(lower(account.name), 'áéíóúüñ', 'aeiouun') = normalized_query then 1
        when translate(lower(account.code), 'áéíóúüñ', 'aeiouun') like normalized_query || '%' then 2
        when translate(lower(account.name), 'áéíóúüñ', 'aeiouun') like normalized_query || '%' then 3
        else 4
      end as match_rank
    from public.accounting_accounts account
    where account.is_active
      and account.normal_balance = 'debit'
      and account.type in ('asset', 'cost', 'expense')
      and (
        normalized_query = ''
        or translate(lower(account.code), 'áéíóúüñ', 'aeiouun') like '%' || normalized_query || '%'
        or translate(lower(account.name), 'áéíóúüñ', 'aeiouun') like '%' || normalized_query || '%'
      )
  )
  select ranked.id, ranked.code, ranked.name, ranked.account_type,
    ranked.normal_balance, ranked.is_active, ranked.parent_id,
    ranked.is_selectable, ranked.match_rank, count(*) over() as total_count
  from ranked
  order by ranked.match_rank, ranked.code, ranked.name, ranked.id
  offset safe_offset
  limit safe_limit;
end;
$$;

revoke all on function public.search_manual_payable_debit_accounts_v1(text, integer, integer)
  from public, anon;
grant execute on function public.search_manual_payable_debit_accounts_v1(text, integer, integer)
  to authenticated;

comment on table public.manual_accounts_payable_recognitions is
  'Durable, separately permissioned recognition evidence for standalone manual accounts payable. No historical rows are backfilled.';
comment on function public.create_manual_accounts_payable_v1(
  uuid, numeric, date, text, text, text, date, uuid, text, text,
  numeric, numeric, numeric, text
) is
  'Creates a standalone manual payable explicitly pending recognition or atomically with one linked recognition draft.';
comment on function public.complete_manual_accounts_payable_recognition_v1(
  uuid, date, uuid, text, text, numeric, numeric, numeric, text
) is
  'Completes a standalone manual payable recognition exactly once and creates one linked journal draft. Actor is auth.uid().';
comment on function public.search_manual_payable_debit_accounts_v1(text, integer, integer) is
  'Permission-checked, paginated active debit account selector for standalone manual payable recognition.';

commit;
