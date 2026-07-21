-- Safe accounting draft editing, source recalculation and posting.

alter table public.journal_entries
  add column if not exists version integer not null default 1,
  add column if not exists updated_by uuid references public.users(id) on delete set null,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.journal_entries
  drop constraint if exists journal_entries_version_positive,
  add constraint journal_entries_version_positive check (version > 0),
  drop constraint if exists journal_entries_metadata_object,
  add constraint journal_entries_metadata_object check (jsonb_typeof(metadata) = 'object');

create index if not exists journal_entries_updated_by_idx on public.journal_entries (updated_by);

update public.roles
set permissions = (
  select coalesce(jsonb_agg(distinct permission order by permission), '[]'::jsonb)
  from jsonb_array_elements_text(coalesce(public.roles.permissions, '[]'::jsonb) || '["accounting:edit_draft_entries"]'::jsonb) permission(permission)
), updated_at = now()
where name in ('technical_owner', 'business_owner', 'admin', 'contadora');

create or replace function public.normalize_journal_draft_lines(lines_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item jsonb;
  normalized jsonb := '[]'::jsonb;
  line_id uuid;
  account_id uuid;
  customer_id uuid;
  vendor_id uuid;
  product_id uuid;
  debit numeric;
  credit numeric;
  line_description text;
  total_debit numeric(20, 2) := 0;
  total_credit numeric(20, 2) := 0;
begin
  if jsonb_typeof(lines_data) <> 'array' then raise exception 'Las lineas deben enviarse como una lista.'; end if;
  if jsonb_array_length(lines_data) < 2 then raise exception 'La partida debe tener al menos dos lineas.'; end if;
  if jsonb_array_length(lines_data) > 200 then raise exception 'La partida no puede tener mas de 200 lineas.'; end if;

  for item in select value from jsonb_array_elements(lines_data)
  loop
    if jsonb_typeof(item) <> 'object' then raise exception 'Cada linea debe ser un objeto valido.'; end if;
    begin
      line_id := nullif(btrim(coalesce(item->>'id', '')), '')::uuid;
      account_id := nullif(btrim(coalesce(item->>'account_id', '')), '')::uuid;
      customer_id := nullif(btrim(coalesce(item->>'customer_id', '')), '')::uuid;
      vendor_id := nullif(btrim(coalesce(item->>'vendor_id', '')), '')::uuid;
      product_id := nullif(btrim(coalesce(item->>'product_id', '')), '')::uuid;
      debit := coalesce(nullif(btrim(coalesce(item->>'debit', '')), '')::numeric, 0);
      credit := coalesce(nullif(btrim(coalesce(item->>'credit', '')), '')::numeric, 0);
    exception when others then
      raise exception 'Una linea contiene identificadores o montos invalidos.';
    end;
    line_description := nullif(btrim(coalesce(item->>'description', '')), '');
    if account_id is null then raise exception 'Cada linea debe tener una cuenta.'; end if;
    if debit < 0 or credit < 0 then raise exception 'Debitos y creditos no pueden ser negativos.'; end if;
    if debit <> round(debit, 2) or credit <> round(credit, 2) then raise exception 'Los montos deben tener maximo dos decimales.'; end if;
    if debit > 999999999999.99 or credit > 999999999999.99 then raise exception 'El monto excede el limite permitido.'; end if;
    if (debit > 0 and credit > 0) or (debit = 0 and credit = 0) then
      raise exception 'Cada linea debe tener exactamente un debito o credito positivo.';
    end if;
    if char_length(coalesce(line_description, '')) > 500 then raise exception 'La descripcion de linea es demasiado larga.'; end if;
    if not exists (select 1 from public.accounting_accounts where id = account_id and is_active = true) then
      raise exception 'Todas las lineas deben usar cuentas activas.';
    end if;
    normalized := normalized || jsonb_build_array(jsonb_build_object(
      'id', line_id, 'account_id', account_id, 'debit', round(debit, 2), 'credit', round(credit, 2),
      'description', line_description, 'customer_id', customer_id, 'vendor_id', vendor_id, 'product_id', product_id
    ));
    total_debit := total_debit + round(debit, 2);
    total_credit := total_credit + round(credit, 2);
  end loop;

  if exists (select 1 from jsonb_array_elements(normalized) line where line->>'id' is not null group by line->>'id' having count(*) > 1) then
    raise exception 'La solicitud contiene IDs de linea duplicados.';
  end if;
  if exists (select 1 from jsonb_array_elements(normalized) line group by line - 'id' having count(*) > 1) then
    raise exception 'La partida no puede contener lineas duplicadas.';
  end if;
  if round(total_debit, 2) <= 0 or round(total_debit, 2) <> round(total_credit, 2) then
    raise exception 'La partida debe estar cuadrada: debito igual a credito.';
  end if;
  return jsonb_build_object('lines', normalized, 'total_debit', round(total_debit, 2), 'total_credit', round(total_credit, 2));
end;
$$;
revoke all on function public.normalize_journal_draft_lines(jsonb) from public;

create or replace function public.next_journal_entry_number()
returns text language plpgsql security definer set search_path = public
as $$
declare candidate text;
begin
  loop
    candidate := 'PC-' || to_char(now() at time zone 'America/Tegucigalpa', 'YYYYMMDD') || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from public.journal_entries where entry_number = candidate);
  end loop;
  return candidate;
end;
$$;
revoke all on function public.next_journal_entry_number() from public;

create or replace function public.journal_lines_snapshot(target_entry_id uuid)
returns jsonb language sql security definer set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', line.id, 'account_id', line.account_id, 'debit', line.debit, 'credit', line.credit,
    'description', line.description, 'customer_id', line.customer_id, 'vendor_id', line.vendor_id, 'product_id', line.product_id
  ) order by line.created_at, line.id), '[]'::jsonb)
  from public.journal_entry_lines line where line.journal_entry_id = target_entry_id;
$$;
revoke all on function public.journal_lines_snapshot(uuid) from public;

create or replace function public.create_manual_journal_draft(
  entry_date_value date, description_value text, lines_data jsonb,
  actor_ip text default null, actor_user_agent text default null
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  actor_user_id uuid := auth.uid();
  normalized jsonb;
  entry_id uuid;
  entry_number_value text;
  clean_description text := nullif(btrim(coalesce(description_value, '')), '');
begin
  if actor_user_id is null or not public.has_permission('accounting:create') then raise exception 'No tienes permiso para crear partidas.'; end if;
  if entry_date_value is null or clean_description is null or char_length(clean_description) < 3 or char_length(clean_description) > 500 then
    raise exception 'Ingresa una fecha y descripcion valida.';
  end if;
  if public.is_date_in_closed_accounting_period(entry_date_value) then raise exception 'El periodo contable esta cerrado.'; end if;
  normalized := public.normalize_journal_draft_lines(lines_data);
  entry_number_value := public.next_journal_entry_number();

  insert into public.journal_entries (
    entry_number, entry_date, description, status, source_type, source_id, created_by, updated_by, metadata
  ) values (
    entry_number_value, entry_date_value, clean_description, 'borrador', null, null, actor_user_id, actor_user_id,
    jsonb_build_object('entry_kind', 'manual', 'manually_overridden', false)
  ) returning id into entry_id;

  insert into public.journal_entry_lines (
    id, journal_entry_id, account_id, debit, credit, description, customer_id, vendor_id, product_id
  )
  select coalesce(nullif(item->>'id', '')::uuid, gen_random_uuid()), entry_id,
    (item->>'account_id')::uuid, (item->>'debit')::numeric, (item->>'credit')::numeric,
    item->>'description', nullif(item->>'customer_id', '')::uuid,
    nullif(item->>'vendor_id', '')::uuid, nullif(item->>'product_id', '')::uuid
  from jsonb_array_elements(normalized->'lines') item;

  perform public.write_audit_log(
    'journal_entries', entry_id, 'accounting.journal_draft.created', null,
    jsonb_build_object(
      'entry_number', entry_number_value, 'entry_date', entry_date_value, 'description', clean_description,
      'status', 'borrador', 'version', 1, 'lines', public.journal_lines_snapshot(entry_id),
      'total_debit', normalized->'total_debit', 'total_credit', normalized->'total_credit'
    ), actor_ip, actor_user_agent
  );
  insert into public.accounting_event_log (event_type, entity_type, entity_id, metadata, created_by)
  values ('accounting_entry_created', 'journal_entries', entry_id,
    jsonb_build_object('entry_number', entry_number_value, 'version', 1, 'entry_kind', 'manual'), actor_user_id);

  return jsonb_build_object(
    'ok', true, 'journal_entry_id', entry_id, 'entry_number', entry_number_value, 'status', 'borrador',
    'version', 1, 'lines', public.journal_lines_snapshot(entry_id),
    'total_debit', normalized->'total_debit', 'total_credit', normalized->'total_credit'
  );
end;
$$;
revoke all on function public.create_manual_journal_draft(date, text, jsonb, text, text) from public;
grant execute on function public.create_manual_journal_draft(date, text, jsonb, text, text) to authenticated;

create or replace function public.create_journal_draft_from_financial_event(
  financial_event_id uuid, entry_date_value date, description_value text, lines_data jsonb,
  actor_ip text default null, actor_user_agent text default null
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  actor_user_id uuid := auth.uid();
  target_event public.financial_events%rowtype;
  normalized jsonb;
  entry_id uuid;
  entry_number_value text;
  clean_description text := nullif(btrim(coalesce(description_value, '')), '');
begin
  if actor_user_id is null or not public.has_permission('accounting:manage') then raise exception 'No tienes permiso para generar borradores.'; end if;
  select * into target_event from public.financial_events where id = financial_event_id for update;
  if not found then raise exception 'El evento financiero no existe.'; end if;
  if target_event.journal_entry_id is not null or exists (
    select 1 from public.journal_entries where source_type = 'financial_event' and source_id = target_event.id::text
  ) then raise exception 'Este evento ya tiene una partida asociada.'; end if;
  if target_event.status in ('posted', 'reversed') then raise exception 'El evento ya no admite un borrador.'; end if;
  if entry_date_value is null or clean_description is null or char_length(clean_description) < 3 or char_length(clean_description) > 500 then
    raise exception 'Los datos del encabezado no son validos.';
  end if;
  if public.is_date_in_closed_accounting_period(entry_date_value) then raise exception 'El periodo contable esta cerrado.'; end if;
  normalized := public.normalize_journal_draft_lines(lines_data);
  entry_number_value := public.next_journal_entry_number();

  insert into public.journal_entries (
    entry_number, entry_date, description, status, source_type, source_id, created_by, updated_by, metadata
  ) values (
    entry_number_value, entry_date_value, clean_description, 'borrador', 'financial_event', target_event.id::text,
    actor_user_id, actor_user_id, jsonb_build_object(
      'entry_kind', 'automatic', 'generated_from_source', true, 'recalculated_from_source', false,
      'manually_overridden', false, 'financial_event_id', target_event.id
    )
  ) returning id into entry_id;

  insert into public.journal_entry_lines (
    id, journal_entry_id, account_id, debit, credit, description, customer_id, vendor_id, product_id
  )
  select coalesce(nullif(item->>'id', '')::uuid, gen_random_uuid()), entry_id,
    (item->>'account_id')::uuid, (item->>'debit')::numeric, (item->>'credit')::numeric,
    item->>'description', nullif(item->>'customer_id', '')::uuid,
    nullif(item->>'vendor_id', '')::uuid, nullif(item->>'product_id', '')::uuid
  from jsonb_array_elements(normalized->'lines') item;

  update public.financial_events
  set status = 'draft_created', journal_entry_id = entry_id, validation_errors = '[]'::jsonb, updated_at = now()
  where id = target_event.id;

  perform public.write_audit_log(
    'journal_entries', entry_id, 'accounting.journal_draft.generated_from_financial_event', null,
    jsonb_build_object(
      'financial_event_id', target_event.id, 'source_type', target_event.source_type, 'source_id', target_event.source_id,
      'event_purpose', target_event.event_purpose, 'entry_number', entry_number_value, 'status', 'borrador',
      'version', 1, 'lines', public.journal_lines_snapshot(entry_id),
      'total_debit', normalized->'total_debit', 'total_credit', normalized->'total_credit'
    ), actor_ip, actor_user_agent
  );
  insert into public.accounting_event_log (event_type, entity_type, entity_id, source_type, source_id, metadata, created_by)
  values ('journal_draft.generated_from_financial_event', 'journal_entries', entry_id, 'financial_event', target_event.id::text,
    jsonb_build_object('event_purpose', target_event.event_purpose, 'status', 'borrador', 'version', 1), actor_user_id);

  return jsonb_build_object(
    'ok', true, 'journal_entry_id', entry_id, 'entry_number', entry_number_value, 'status', 'borrador',
    'version', 1, 'lines', public.journal_lines_snapshot(entry_id),
    'total_debit', normalized->'total_debit', 'total_credit', normalized->'total_credit'
  );
end;
$$;
revoke all on function public.create_journal_draft_from_financial_event(uuid, date, text, jsonb, text, text) from public;
grant execute on function public.create_journal_draft_from_financial_event(uuid, date, text, jsonb, text, text) to authenticated;

create or replace function public.update_journal_draft(
  target_entry_id uuid, expected_version integer, entry_date_value date, description_value text,
  lines_data jsonb, edit_reason text, actor_ip text default null, actor_user_agent text default null
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role_name text;
  target_entry public.journal_entries%rowtype;
  normalized jsonb;
  previous_header jsonb;
  previous_lines jsonb;
  next_header jsonb;
  next_lines jsonb;
  added_lines jsonb;
  updated_lines jsonb;
  removed_lines jsonb;
  clean_description text := nullif(btrim(coalesce(description_value, '')), '');
  clean_reason text := nullif(btrim(coalesce(edit_reason, '')), '');
  next_version integer;
begin
  if actor_user_id is null or not public.has_permission('accounting:edit_draft_entries') then raise exception 'No tienes permiso para editar borradores.'; end if;
  select role.name into actor_role_name from public.users actor join public.roles role on role.id = actor.role_id where actor.id = actor_user_id;
  if clean_reason is null or char_length(clean_reason) < 10 or char_length(clean_reason) > 1000 then raise exception 'Ingresa un motivo de edicion de al menos 10 caracteres.'; end if;
  if entry_date_value is null or clean_description is null or char_length(clean_description) < 3 or char_length(clean_description) > 500 then
    raise exception 'Ingresa una fecha y descripcion valida.';
  end if;
  select * into target_entry from public.journal_entries where id = target_entry_id for update;
  if not found then raise exception 'La partida no existe.'; end if;
  if target_entry.status <> 'borrador' then raise exception 'Esta partida ya fue publicada y no puede editarse.'; end if;
  if target_entry.version <> expected_version then
    raise exception using errcode = '40001', message = 'La partida fue modificada por otro usuario. Recargue la informacion antes de continuar.';
  end if;
  if public.is_date_in_closed_accounting_period(target_entry.entry_date) or public.is_date_in_closed_accounting_period(entry_date_value) then
    raise exception 'El periodo contable esta cerrado.';
  end if;
  normalized := public.normalize_journal_draft_lines(lines_data);
  previous_header := to_jsonb(target_entry);
  previous_lines := public.journal_lines_snapshot(target_entry_id);
  if exists (
    select 1 from jsonb_array_elements(normalized->'lines') item
    where item->>'id' is not null and not exists (
      select 1 from public.journal_entry_lines existing
      where existing.id = (item->>'id')::uuid and existing.journal_entry_id = target_entry_id
    )
  ) then raise exception 'Una linea enviada no pertenece a esta partida.'; end if;

  delete from public.journal_entry_lines where journal_entry_id = target_entry_id;
  insert into public.journal_entry_lines (
    id, journal_entry_id, account_id, debit, credit, description, customer_id, vendor_id, product_id
  )
  select coalesce(nullif(item->>'id', '')::uuid, gen_random_uuid()), target_entry_id,
    (item->>'account_id')::uuid, (item->>'debit')::numeric, (item->>'credit')::numeric,
    item->>'description', nullif(item->>'customer_id', '')::uuid,
    nullif(item->>'vendor_id', '')::uuid, nullif(item->>'product_id', '')::uuid
  from jsonb_array_elements(normalized->'lines') item;

  -- update_journal_draft_mutation
  next_version := target_entry.version + 1;
  update public.journal_entries
  set entry_date = entry_date_value, description = clean_description, updated_by = actor_user_id,
      version = next_version,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'last_edit_mode', case when source_type = 'financial_event' then 'manual_override' else 'manual_edit' end,
        'manually_overridden', source_type = 'financial_event'
      )
  where id = target_entry_id;
  select to_jsonb(entry) into next_header from public.journal_entries entry where id = target_entry_id;
  next_lines := public.journal_lines_snapshot(target_entry_id);

  select coalesce(jsonb_agg(next_line), '[]'::jsonb) into added_lines
  from jsonb_array_elements(next_lines) next_line
  where not exists (select 1 from jsonb_array_elements(previous_lines) old_line where old_line->>'id' = next_line->>'id');
  select coalesce(jsonb_agg(old_line), '[]'::jsonb) into removed_lines
  from jsonb_array_elements(previous_lines) old_line
  where not exists (select 1 from jsonb_array_elements(next_lines) next_line where next_line->>'id' = old_line->>'id');
  select coalesce(jsonb_agg(jsonb_build_object('before', old_line, 'after', next_line)), '[]'::jsonb) into updated_lines
  from jsonb_array_elements(previous_lines) old_line
  join jsonb_array_elements(next_lines) next_line on next_line->>'id' = old_line->>'id'
  where (old_line - 'id') is distinct from (next_line - 'id');

  perform public.write_audit_log(
    'journal_entries', target_entry_id, 'accounting_entry_updated',
    jsonb_build_object('header', previous_header, 'lines', previous_lines, 'version', target_entry.version),
    jsonb_build_object(
      'header', next_header, 'lines', next_lines, 'edit_reason', clean_reason,
      'actor_id', actor_user_id, 'actor_role', actor_role_name, 'journal_entry_id', target_entry_id,
      'source_type', target_entry.source_type, 'source_id', target_entry.source_id, 'timestamp', now(),
      'lines_added', added_lines, 'lines_updated', updated_lines, 'lines_removed', removed_lines,
      'previous_version', target_entry.version, 'new_version', next_version,
      'total_debit', normalized->'total_debit', 'total_credit', normalized->'total_credit'
    ), actor_ip, actor_user_agent
  );
  insert into public.accounting_event_log (event_type, entity_type, entity_id, source_type, source_id, metadata, created_by)
  values ('accounting_entry_updated', 'journal_entries', target_entry_id, target_entry.source_type, target_entry.source_id,
    jsonb_build_object(
      'edit_reason', clean_reason, 'previous_version', target_entry.version, 'new_version', next_version,
      'actor_id', actor_user_id, 'actor_role', actor_role_name,
      'lines_added', added_lines, 'lines_updated', updated_lines, 'lines_removed', removed_lines,
      'manual_override', target_entry.source_type = 'financial_event'
    ), actor_user_id);

  insert into public.accounting_event_log (event_type, entity_type, entity_id, source_type, source_id, metadata, created_by)
  select 'accounting_line_added', 'journal_entry_lines', (line->>'id')::uuid, target_entry.source_type, target_entry.source_id,
    jsonb_build_object('journal_entry_id', target_entry_id, 'line', line, 'edit_reason', clean_reason), actor_user_id
  from jsonb_array_elements(added_lines) line;
  insert into public.accounting_event_log (event_type, entity_type, entity_id, source_type, source_id, metadata, created_by)
  select 'accounting_line_updated', 'journal_entry_lines', (change->'after'->>'id')::uuid, target_entry.source_type, target_entry.source_id,
    jsonb_build_object('journal_entry_id', target_entry_id, 'change', change, 'edit_reason', clean_reason), actor_user_id
  from jsonb_array_elements(updated_lines) change;
  insert into public.accounting_event_log (event_type, entity_type, entity_id, source_type, source_id, metadata, created_by)
  select 'accounting_line_removed', 'journal_entry_lines', (line->>'id')::uuid, target_entry.source_type, target_entry.source_id,
    jsonb_build_object('journal_entry_id', target_entry_id, 'line', line, 'edit_reason', clean_reason), actor_user_id
  from jsonb_array_elements(removed_lines) line;

  return jsonb_build_object(
    'ok', true, 'journal_entry_id', target_entry_id, 'entry_number', target_entry.entry_number,
    'status', 'borrador', 'version', next_version, 'entry', next_header, 'lines', next_lines,
    'total_debit', normalized->'total_debit', 'total_credit', normalized->'total_credit',
    'lines_added', added_lines, 'lines_updated', updated_lines, 'lines_removed', removed_lines
  );
end;
$$;
revoke all on function public.update_journal_draft(uuid, integer, date, text, jsonb, text, text, text) from public;
grant execute on function public.update_journal_draft(uuid, integer, date, text, jsonb, text, text, text) to authenticated;

create or replace function public.resolve_accounts_payable_snapshot(target_payable_id uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  payable public.accounts_payable%rowtype;
  invoice public.supplier_invoices%rowtype;
  purchase public.purchases%rowtype;
  supplier_name_value text;
  fiscal_source text := null;
  subtotal_value numeric(12, 2);
  tax_value numeric(12, 2);
  discount_value numeric(12, 2);
  shipping_value numeric(12, 2);
  document_number_value text;
  document_date_value date;
  item_count integer := 0;
begin
  select * into payable from public.accounts_payable where id = target_payable_id for share;
  if not found then raise exception 'La cuenta por pagar no existe.'; end if;
  if upper(btrim(payable.currency)) <> 'HNL' then raise exception 'La moneda de la cuenta por pagar no coincide con HNL.'; end if;
  select name into supplier_name_value from public.suppliers where id = payable.supplier_id;

  if payable.supplier_invoice_id is not null then
    select * into invoice from public.supplier_invoices where id = payable.supplier_invoice_id;
    if found and invoice.supplier_id = payable.supplier_id
      and invoice.status in ('received', 'posted_to_ap', 'paid')
      and upper(btrim(invoice.currency)) = upper(btrim(payable.currency))
      and round(invoice.total, 2) = round(payable.total_amount, 2)
      and round(invoice.subtotal + invoice.tax_amount - invoice.discount_amount, 2) = round(invoice.total, 2)
    then
      fiscal_source := 'supplier_invoice';
      subtotal_value := invoice.subtotal;
      tax_value := invoice.tax_amount;
      discount_value := invoice.discount_amount;
      shipping_value := 0;
      document_number_value := invoice.invoice_number;
      document_date_value := invoice.invoice_date;
    end if;
  end if;

  if payable.purchase_id is not null then
    select * into purchase from public.purchases where id = payable.purchase_id;
  end if;

  if fiscal_source is null and purchase.id is not null
    and purchase.supplier_id = payable.supplier_id
    and purchase.status in ('confirmed', 'received', 'returned')
    and upper(btrim(purchase.currency)) = upper(btrim(payable.currency))
    and round(purchase.total, 2) = round(payable.total_amount, 2)
    and round(purchase.subtotal + purchase.tax_amount + purchase.shipping_amount - purchase.discount_amount, 2) = round(purchase.total, 2)
  then
    fiscal_source := 'purchase';
    subtotal_value := purchase.subtotal;
    tax_value := purchase.tax_amount;
    discount_value := purchase.discount_amount;
    shipping_value := purchase.shipping_amount;
    document_number_value := purchase.purchase_number;
    document_date_value := purchase.purchase_date;
  end if;

  if fiscal_source is null and purchase.id is not null
    and purchase.supplier_id = payable.supplier_id
    and upper(btrim(purchase.currency)) = upper(btrim(payable.currency))
  then
    select count(*)::integer,
      round(coalesce(sum(quantity * unit_cost), 0), 2),
      round(coalesce(sum(tax_amount), 0), 2),
      round(coalesce(sum(discount_amount), 0), 2)
    into item_count, subtotal_value, tax_value, discount_value
    from public.purchase_items where purchase_id = purchase.id;
    shipping_value := purchase.shipping_amount;
    if item_count > 0 and round(subtotal_value + tax_value + shipping_value - discount_value, 2) = round(payable.total_amount, 2) then
      fiscal_source := 'purchase_items';
      document_number_value := purchase.purchase_number;
      document_date_value := purchase.purchase_date;
    end if;
  end if;

  if fiscal_source is null then
    raise exception 'La cuenta por pagar no tiene un desglose fiscal verificable en el documento origen.';
  end if;

  return jsonb_build_object(
    'accounts_payable_id', payable.id, 'purchase_id', payable.purchase_id,
    'supplier_invoice_id', payable.supplier_invoice_id, 'vendor_id', payable.supplier_id,
    'supplier_id', payable.supplier_id, 'supplier_name', coalesce(supplier_name_value, 'Proveedor no identificado'),
    'subtotal', subtotal_value, 'tax_amount', tax_value, 'discount_amount', discount_value,
    'shipping_amount', shipping_value, 'total_amount', payable.total_amount,
    'paid_amount', payable.paid_amount, 'balance', payable.balance, 'currency', upper(btrim(payable.currency)),
    'document_number', document_number_value, 'document_date', document_date_value,
    'purchase_number', case when purchase.id is null then null else purchase.purchase_number end,
    'invoice_number', case when invoice.id is null then null else invoice.invoice_number end,
    'due_date', payable.due_date, 'source_type', 'accounts_payable', 'source_id', payable.id,
    'payment_status', payable.status, 'status', payable.status,
    'fiscal_breakdown_status', 'complete', 'fiscal_source', fiscal_source,
    'fiscal_metadata', jsonb_build_object(
      'invoice_status', case when invoice.id is null then null else invoice.status end,
      'purchase_status', case when purchase.id is null then null else purchase.status end,
      'purchase_items_count', item_count, 'reconciled_total', true
    )
  );
end;
$$;
revoke all on function public.resolve_accounts_payable_snapshot(uuid) from public;

create or replace function public.recalculate_journal_draft_from_source(
  target_entry_id uuid, expected_version integer, recalculate_reason text,
  actor_ip text default null, actor_user_agent text default null
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role_name text;
  target_entry public.journal_entries%rowtype;
  target_event public.financial_events%rowtype;
  snapshot jsonb;
  generated_lines jsonb := '[]'::jsonb;
  normalized jsonb;
  previous_header jsonb;
  previous_lines jsonb;
  next_header jsonb;
  next_lines jsonb;
  payable_account_id uuid;
  cost_account_id uuid;
  tax_account_id uuid;
  discount_account_id uuid;
  shipping_account_id uuid;
  subtotal_value numeric(14, 2);
  tax_value numeric(14, 2);
  discount_value numeric(14, 2);
  shipping_value numeric(14, 2);
  total_value numeric(14, 2);
  next_version integer;
  clean_reason text := nullif(btrim(coalesce(recalculate_reason, '')), '');
begin
  if actor_user_id is null or not public.has_permission('accounting:edit_draft_entries') then raise exception 'No tienes permiso para recalcular borradores.'; end if;
  select role.name into actor_role_name from public.users actor join public.roles role on role.id = actor.role_id where actor.id = actor_user_id;
  if clean_reason is null or char_length(clean_reason) < 10 or char_length(clean_reason) > 1000 then raise exception 'Ingresa un motivo de recalculo de al menos 10 caracteres.'; end if;
  select * into target_entry from public.journal_entries where id = target_entry_id for update;
  if not found then raise exception 'La partida no existe.'; end if;
  if target_entry.status <> 'borrador' then raise exception 'Esta partida ya fue publicada y no puede recalcularse.'; end if;
  if target_entry.version <> expected_version then
    raise exception using errcode = '40001', message = 'La partida fue modificada por otro usuario. Recargue la informacion antes de continuar.';
  end if;
  if public.is_date_in_closed_accounting_period(target_entry.entry_date) then raise exception 'El periodo contable esta cerrado.'; end if;
  if target_entry.source_type <> 'financial_event' or target_entry.source_id is null then raise exception 'La partida no tiene un evento financiero recalculable.'; end if;

  select * into target_event from public.financial_events
  where id = target_entry.source_id::uuid and journal_entry_id = target_entry.id for update;
  if not found then raise exception 'El evento financiero vinculado no existe o cambio.'; end if;
  if target_event.source_type <> 'accounts_payable' or target_event.event_purpose <> 'accounts_payable_created' then
    raise exception 'Este tipo de evento no admite recalculo desde cuentas por pagar.';
  end if;
  snapshot := public.resolve_accounts_payable_snapshot(target_event.source_id::uuid);
  subtotal_value := (snapshot->>'subtotal')::numeric;
  tax_value := (snapshot->>'tax_amount')::numeric;
  discount_value := (snapshot->>'discount_amount')::numeric;
  shipping_value := (snapshot->>'shipping_amount')::numeric;
  total_value := (snapshot->>'total_amount')::numeric;
  if round(subtotal_value + tax_value + shipping_value - discount_value, 2) <> round(total_value, 2) then
    raise exception 'El desglose fiscal no coincide con el total de la cuenta por pagar.';
  end if;

  select account.id into payable_account_id
  from public.accounting_mappings mapping join public.accounting_accounts account on account.id = mapping.account_id
  where mapping.mapping_type = 'default_account' and mapping.source_key = 'accounts_payable'
    and mapping.is_active and account.is_active
    and (mapping.effective_from is null or mapping.effective_from <= current_date)
    and (mapping.effective_to is null or mapping.effective_to >= current_date)
  order by mapping.priority limit 1;
  select account.id into cost_account_id
  from public.accounting_mappings mapping join public.accounting_accounts account on account.id = mapping.account_id
  where mapping.mapping_type = 'inventory' and mapping.source_key = 'purchase_inventory'
    and mapping.is_active and account.is_active
    and (mapping.effective_from is null or mapping.effective_from <= current_date)
    and (mapping.effective_to is null or mapping.effective_to >= current_date)
  order by mapping.priority limit 1;
  if cost_account_id is null then
    select account.id into cost_account_id
    from public.accounting_mappings mapping join public.accounting_accounts account on account.id = mapping.account_id
    where mapping.mapping_type = 'default_account' and mapping.source_key = 'purchase_expense'
      and mapping.is_active and account.is_active
      and (mapping.effective_from is null or mapping.effective_from <= current_date)
      and (mapping.effective_to is null or mapping.effective_to >= current_date)
    order by mapping.priority limit 1;
  end if;
  if payable_account_id is null then raise exception 'Falta la cuenta de proveedores por pagar.'; end if;
  if cost_account_id is null then raise exception 'Falta la cuenta de inventario o gasto de compras.'; end if;

  if tax_value > 0 then
    select account.id into tax_account_id
    from public.accounting_mappings mapping join public.accounting_accounts account on account.id = mapping.account_id
    where mapping.mapping_type = 'tax' and mapping.source_key = 'purchase_tax'
      and mapping.is_active and account.is_active
      and (mapping.effective_from is null or mapping.effective_from <= current_date)
      and (mapping.effective_to is null or mapping.effective_to >= current_date)
    order by mapping.priority limit 1;
    if tax_account_id is null then raise exception 'Falta la cuenta de impuesto para compras.'; end if;
  end if;
  if discount_value > 0 then
    select account.id into discount_account_id
    from public.accounting_mappings mapping join public.accounting_accounts account on account.id = mapping.account_id
    where mapping.mapping_type = 'discount' and mapping.source_key = 'purchase_discount'
      and mapping.is_active and account.is_active
      and (mapping.effective_from is null or mapping.effective_from <= current_date)
      and (mapping.effective_to is null or mapping.effective_to >= current_date)
    order by mapping.priority limit 1;
    if discount_account_id is null then raise exception 'Falta la cuenta de descuentos de compras.'; end if;
  end if;
  if shipping_value > 0 then
    select account.id into shipping_account_id
    from public.accounting_mappings mapping join public.accounting_accounts account on account.id = mapping.account_id
    where mapping.mapping_type = 'shipping' and mapping.source_key = 'purchase_shipping'
      and mapping.is_active and account.is_active
      and (mapping.effective_from is null or mapping.effective_from <= current_date)
      and (mapping.effective_to is null or mapping.effective_to >= current_date)
    order by mapping.priority limit 1;
    if shipping_account_id is null then raise exception 'Falta la cuenta de flete de compras.'; end if;
  end if;

  generated_lines := jsonb_build_array(jsonb_build_object(
    'account_id', cost_account_id, 'debit', subtotal_value, 'credit', 0, 'description', 'Compra o gasto registrado',
    'customer_id', null, 'vendor_id', snapshot->>'vendor_id', 'product_id', null
  ));
  if tax_value > 0 then generated_lines := generated_lines || jsonb_build_array(jsonb_build_object(
    'account_id', tax_account_id, 'debit', tax_value, 'credit', 0, 'description', 'Impuesto de compras',
    'customer_id', null, 'vendor_id', snapshot->>'vendor_id', 'product_id', null
  )); end if;
  if shipping_value > 0 then generated_lines := generated_lines || jsonb_build_array(jsonb_build_object(
    'account_id', shipping_account_id, 'debit', shipping_value, 'credit', 0, 'description', 'Flete de compras',
    'customer_id', null, 'vendor_id', snapshot->>'vendor_id', 'product_id', null
  )); end if;
  if discount_value > 0 then generated_lines := generated_lines || jsonb_build_array(jsonb_build_object(
    'account_id', discount_account_id, 'debit', 0, 'credit', discount_value, 'description', 'Descuento de compras',
    'customer_id', null, 'vendor_id', snapshot->>'vendor_id', 'product_id', null
  )); end if;
  generated_lines := generated_lines || jsonb_build_array(jsonb_build_object(
    'account_id', payable_account_id, 'debit', 0, 'credit', total_value, 'description', 'Cuenta por pagar a proveedor',
    'customer_id', null, 'vendor_id', snapshot->>'vendor_id', 'product_id', null
  ));
  normalized := public.normalize_journal_draft_lines(generated_lines);
  previous_header := to_jsonb(target_entry);
  previous_lines := public.journal_lines_snapshot(target_entry_id);

  delete from public.journal_entry_lines where journal_entry_id = target_entry_id;
  insert into public.journal_entry_lines (
    journal_entry_id, account_id, debit, credit, description, customer_id, vendor_id, product_id
  )
  select target_entry_id, (item->>'account_id')::uuid, (item->>'debit')::numeric, (item->>'credit')::numeric,
    item->>'description', nullif(item->>'customer_id', '')::uuid,
    nullif(item->>'vendor_id', '')::uuid, nullif(item->>'product_id', '')::uuid
  from jsonb_array_elements(normalized->'lines') item;

  -- recalculate_journal_draft_audit
  next_version := target_entry.version + 1;
  update public.journal_entries
  set updated_by = actor_user_id, version = next_version,
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'entry_kind', 'automatic', 'generated_from_source', true, 'recalculated_from_source', true,
        'manually_overridden', false, 'last_edit_mode', 'source_recalculation',
        'financial_event_id', target_event.id, 'fiscal_source', snapshot->>'fiscal_source'
      )
  where id = target_entry_id;
  update public.financial_events
  set source_snapshot = snapshot, validation_errors = '[]'::jsonb, status = 'draft_created',
      journal_entry_id = target_entry_id, updated_at = now()
  where id = target_event.id;

  select to_jsonb(entry) into next_header from public.journal_entries entry where id = target_entry_id;
  next_lines := public.journal_lines_snapshot(target_entry_id);
  perform public.write_audit_log(
    'journal_entries', target_entry_id, 'accounting_entry_recalculated',
    jsonb_build_object(
      'header', previous_header, 'lines', previous_lines, 'source_snapshot', target_event.source_snapshot,
      'version', target_entry.version
    ),
    jsonb_build_object(
      'header', next_header, 'lines', next_lines, 'source_snapshot', snapshot,
      'edit_reason', clean_reason, 'source_document', snapshot->>'fiscal_source',
      'actor_id', actor_user_id, 'actor_role', actor_role_name, 'journal_entry_id', target_entry_id,
      'source_type', target_entry.source_type, 'source_id', target_entry.source_id, 'timestamp', now(),
      'previous_version', target_entry.version, 'new_version', next_version,
      'total_debit', normalized->'total_debit', 'total_credit', normalized->'total_credit'
    ), actor_ip, actor_user_agent
  );
  insert into public.accounting_event_log (
    event_type, entity_type, entity_id, source_type, source_id, metadata, created_by
  ) values (
    'accounting_entry_recalculated', 'journal_entries', target_entry_id, 'financial_event', target_event.id::text,
    jsonb_build_object(
      'edit_reason', clean_reason, 'financial_event_id', target_event.id,
      'actor_id', actor_user_id, 'actor_role', actor_role_name,
      'accounts_payable_id', target_event.source_id, 'fiscal_source', snapshot->>'fiscal_source',
      'previous_lines', previous_lines, 'new_lines', next_lines,
      'previous_version', target_entry.version, 'new_version', next_version
    ), actor_user_id
  );

  return jsonb_build_object(
    'ok', true, 'journal_entry_id', target_entry_id, 'entry_number', target_entry.entry_number,
    'status', 'borrador', 'version', next_version, 'entry', next_header, 'lines', next_lines,
    'source_snapshot', snapshot, 'financial_event_id', target_event.id,
    'total_debit', normalized->'total_debit', 'total_credit', normalized->'total_credit'
  );
end;
$$;
revoke all on function public.recalculate_journal_draft_from_source(uuid, integer, text, text, text) from public;
grant execute on function public.recalculate_journal_draft_from_source(uuid, integer, text, text, text) to authenticated;

create or replace function public.post_journal_entry(
  target_entry_id uuid, expected_version integer,
  actor_ip text default null, actor_user_agent text default null
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_role_name text;
  target_entry public.journal_entries%rowtype;
  previous_lines jsonb;
  normalized jsonb;
  next_version integer;
  linked_event_id uuid;
begin
  if actor_user_id is null or not public.has_permission('accounting:post') then raise exception 'No tienes permiso para publicar partidas.'; end if;
  select role.name into actor_role_name from public.users actor join public.roles role on role.id = actor.role_id where actor.id = actor_user_id;
  select * into target_entry from public.journal_entries where id = target_entry_id for update;
  if not found then raise exception 'La partida no existe.'; end if;
  if target_entry.status <> 'borrador' then raise exception 'Solo se pueden publicar partidas en borrador.'; end if;
  if target_entry.version <> expected_version then
    raise exception using errcode = '40001', message = 'La partida fue modificada por otro usuario. Recargue la informacion antes de continuar.';
  end if;
  if public.is_date_in_closed_accounting_period(target_entry.entry_date) then raise exception 'El periodo contable esta cerrado.'; end if;
  previous_lines := public.journal_lines_snapshot(target_entry_id);
  normalized := public.normalize_journal_draft_lines(previous_lines);
  next_version := target_entry.version + 1;

  if target_entry.source_type = 'financial_event' then
    begin linked_event_id := target_entry.source_id::uuid;
    exception when others then raise exception 'El evento financiero vinculado no es valido.'; end;
    perform 1 from public.financial_events
      where id = linked_event_id and journal_entry_id = target_entry_id for update;
    if not found then raise exception 'El evento financiero vinculado no existe o cambio.'; end if;
  end if;

  update public.journal_entries
  set status = 'publicada', posted_by = actor_user_id, posted_at = now(),
      updated_by = actor_user_id, version = next_version
  where id = target_entry_id;
  if linked_event_id is not null then
    update public.financial_events
    set status = 'posted', journal_entry_id = target_entry_id, validation_errors = '[]'::jsonb, updated_at = now()
    where id = linked_event_id;
  end if;

  perform public.write_audit_log(
    'journal_entries', target_entry_id, 'accounting_entry_published',
    jsonb_build_object('status', target_entry.status, 'version', target_entry.version, 'lines', previous_lines),
    jsonb_build_object(
      'status', 'publicada', 'posted_by', actor_user_id, 'version', next_version,
      'actor_id', actor_user_id, 'actor_role', actor_role_name, 'journal_entry_id', target_entry_id, 'timestamp', now(),
      'lines', previous_lines, 'total_debit', normalized->'total_debit', 'total_credit', normalized->'total_credit',
      'financial_event_id', linked_event_id
    ), actor_ip, actor_user_agent
  );
  insert into public.accounting_event_log (
    event_type, entity_type, entity_id, source_type, source_id, metadata, created_by
  ) values (
    'accounting_entry_published', 'journal_entries', target_entry_id, target_entry.source_type, target_entry.source_id,
    jsonb_build_object(
      'previous_version', target_entry.version, 'new_version', next_version,
      'actor_id', actor_user_id, 'actor_role', actor_role_name,
      'total_debit', normalized->'total_debit', 'total_credit', normalized->'total_credit',
      'financial_event_id', linked_event_id
    ), actor_user_id
  );
  return jsonb_build_object(
    'ok', true, 'journal_entry_id', target_entry_id, 'entry_number', target_entry.entry_number,
    'status', 'publicada', 'version', next_version, 'financial_event_id', linked_event_id,
    'total_debit', normalized->'total_debit', 'total_credit', normalized->'total_credit'
  );
end;
$$;
revoke all on function public.post_journal_entry(uuid, integer, text, text) from public;
grant execute on function public.post_journal_entry(uuid, integer, text, text) to authenticated;

create or replace function public.reverse_journal_entry(target_entry_id uuid)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  actor_user_id uuid := auth.uid();
  original_entry public.journal_entries%rowtype;
  existing_reversal_id uuid;
  reversal_entry_id uuid;
  reversal_entry_number text;
  reversal_entry_date date := (now() at time zone 'America/Tegucigalpa')::date;
  line_count integer;
  total_debit numeric(14, 2);
  total_credit numeric(14, 2);
  linked_event_id uuid;
begin
  if actor_user_id is null or not public.has_permission('accounting:reverse') then raise exception 'No tienes permiso para reversar partidas.'; end if;
  select * into original_entry from public.journal_entries where id = target_entry_id for update;
  if not found then raise exception 'La partida no existe.'; end if;
  if original_entry.status <> 'publicada' then raise exception 'Solo se pueden reversar partidas publicadas.'; end if;
  if original_entry.reversed_entry_id is not null then raise exception 'La partida ya fue reversada.'; end if;
  if public.is_date_in_closed_accounting_period(reversal_entry_date) then raise exception 'No se puede crear el reverso dentro de un periodo cerrado.'; end if;
  select id into existing_reversal_id from public.journal_entries
  where source_type = 'journal_reversal' and source_id = original_entry.id::text limit 1;
  if existing_reversal_id is not null then raise exception 'La partida ya tiene un asiento de reverso.'; end if;

  select count(*)::integer, coalesce(sum(debit), 0)::numeric(14, 2), coalesce(sum(credit), 0)::numeric(14, 2)
  into line_count, total_debit, total_credit
  from public.journal_entry_lines where journal_entry_id = original_entry.id;
  if line_count < 2 or total_debit <= 0 or total_debit <> total_credit then
    raise exception 'La partida original no esta cuadrada y no puede reversarse.';
  end if;

  reversal_entry_number := public.next_journal_entry_number();
  insert into public.journal_entries (
    entry_number, entry_date, description, status, source_type, source_id, created_by, updated_by, metadata
  ) values (
    reversal_entry_number, reversal_entry_date,
    left(format('Reverso de %s: %s', original_entry.entry_number, original_entry.description), 500),
    'borrador', 'journal_reversal', original_entry.id::text, actor_user_id, actor_user_id,
    jsonb_build_object('entry_kind', 'reversal', 'original_entry_id', original_entry.id)
  ) returning id into reversal_entry_id;

  insert into public.journal_entry_lines (
    journal_entry_id, account_id, debit, credit, description, customer_id, vendor_id, product_id
  )
  select reversal_entry_id, account_id, credit, debit,
    coalesce('Reverso: ' || nullif(description, ''), 'Reverso de ' || original_entry.entry_number),
    customer_id, vendor_id, product_id
  from public.journal_entry_lines where journal_entry_id = original_entry.id order by created_at, id;

  update public.journal_entries
  set status = 'publicada', posted_by = actor_user_id, posted_at = now(), updated_by = actor_user_id, version = version + 1
  where id = reversal_entry_id;
  update public.journal_entries
  set status = 'reversada', reversed_entry_id = reversal_entry_id, updated_by = actor_user_id, version = version + 1
  where id = original_entry.id;

  if original_entry.source_type = 'financial_event' then
    begin linked_event_id := original_entry.source_id::uuid;
    exception when others then linked_event_id := null; end;
    if linked_event_id is not null then
      update public.financial_events
      set status = 'reversed', journal_entry_id = original_entry.id, updated_at = now()
      where id = linked_event_id and journal_entry_id = original_entry.id;
    end if;
  end if;

  perform public.write_audit_log(
    'journal_entries', reversal_entry_id, 'accounting.journal_reversal.created', null,
    jsonb_build_object(
      'status', 'publicada', 'version', 2, 'original_entry_id', original_entry.id,
      'original_entry_number', original_entry.entry_number, 'total_debit', total_debit, 'total_credit', total_credit
    ), null, null
  );
  perform public.write_audit_log(
    'journal_entries', original_entry.id, 'accounting.journal_entry.reversed',
    jsonb_build_object('status', 'publicada', 'version', original_entry.version),
    jsonb_build_object(
      'status', 'reversada', 'version', original_entry.version + 1,
      'reversal_entry_id', reversal_entry_id, 'financial_event_id', linked_event_id
    ), null, null
  );
  insert into public.accounting_event_log (
    event_type, entity_type, entity_id, source_type, source_id, metadata, created_by
  ) values
  ('journal_reversal.created', 'journal_entries', reversal_entry_id, 'journal_reversal', original_entry.id::text,
    jsonb_build_object('original_entry_id', original_entry.id, 'reversal_entry_number', reversal_entry_number, 'total_debit', total_debit, 'total_credit', total_credit), actor_user_id),
  ('journal_entry.reversed', 'journal_entries', original_entry.id, 'journal_reversal', reversal_entry_id::text,
    jsonb_build_object('reversal_entry_id', reversal_entry_id, 'financial_event_id', linked_event_id, 'previous_status', 'publicada', 'next_status', 'reversada'), actor_user_id);

  return jsonb_build_object(
    'ok', true, 'original_entry_id', original_entry.id, 'original_version', original_entry.version + 1,
    'reversal_entry_id', reversal_entry_id, 'reversal_entry_number', reversal_entry_number,
    'financial_event_id', linked_event_id
  );
end;
$$;
revoke all on function public.reverse_journal_entry(uuid) from public;
grant execute on function public.reverse_journal_entry(uuid) to authenticated;
