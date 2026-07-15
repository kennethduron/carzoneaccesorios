-- Phase A: direct operational receivable imports and accountant payments.
-- This migration changes schema and function definitions only. It does not apply
-- existing batches or create customers, receivables, or payments at migration time.

alter table public.accounts_receivable
  add column if not exists import_dedupe_key text;

create unique index if not exists accounts_receivable_import_dedupe_key_idx
  on public.accounts_receivable(import_dedupe_key)
  where import_dedupe_key is not null;

alter table public.customers
  alter column phone drop not null;

update public.roles
set permissions = (
    select jsonb_agg(distinct permission_value)
    from jsonb_array_elements_text(
      coalesce(permissions, '[]'::jsonb) || '["credit:mark_paid"]'::jsonb
    ) as permission_value
  ),
  updated_at = now()
where name = 'contadora';

create or replace function public.normalize_receivable_import_email(raw_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when lower(trim(coalesce(raw_value, ''))) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      then lower(trim(raw_value))
    else null
  end;
$$;

create or replace function public.normalize_receivable_import_tax_id(raw_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when length(regexp_replace(coalesce(raw_value, ''), '\D', '', 'g')) = 14
      then regexp_replace(raw_value, '\D', '', 'g')
    else null
  end;
$$;

create or replace function public.normalize_receivable_import_phone(raw_value text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when length(regexp_replace(coalesce(raw_value, ''), '\D', '', 'g')) = 8
      then '+504' || regexp_replace(raw_value, '\D', '', 'g')
    when length(regexp_replace(coalesce(raw_value, ''), '\D', '', 'g')) = 11
      and regexp_replace(raw_value, '\D', '', 'g') like '504%'
      then '+' || regexp_replace(raw_value, '\D', '', 'g')
    else null
  end;
$$;

create or replace function public.receivable_import_dedupe_key(
  target_customer_id uuid,
  invoice_number text,
  issue_date date,
  original_amount numeric
)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select encode(
    extensions.digest(
      concat_ws(
        '|',
        'historical_receivable_import',
        target_customer_id::text,
        lower(regexp_replace(trim(coalesce(invoice_number, '')), '[[:space:]]+', '', 'g')),
        issue_date::text,
        round(original_amount, 2)::text
      ),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function public.resolve_receivable_import_customer(row_data jsonb)
returns table (
  resolution text,
  customer_id uuid,
  reason text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  normalized_tax_id text := public.normalize_receivable_import_tax_id(row_data->>'customer_tax_id');
  normalized_email text := public.normalize_receivable_import_email(row_data->>'customer_email');
  normalized_phone text := public.normalize_receivable_import_phone(row_data->>'customer_phone');
  candidate_ids uuid[];
  duplicate_identifier boolean;
  matched_customer public.customers%rowtype;
begin
  select
    coalesce(array_agg(distinct match.id), '{}'::uuid[]),
    coalesce(bool_or(match.match_count > 1), false)
  into candidate_ids, duplicate_identifier
  from (
    select c.id, count(*) over () as match_count
    from public.customers c
    where normalized_tax_id is not null
      and public.normalize_receivable_import_tax_id(c.tax_id) = normalized_tax_id
    union all
    select c.id, count(*) over () as match_count
    from public.customers c
    where normalized_email is not null
      and public.normalize_receivable_import_email(c.email) = normalized_email
    union all
    select c.id, count(*) over () as match_count
    from public.customers c
    where normalized_phone is not null
      and public.normalize_receivable_import_phone(c.phone) = normalized_phone
  ) match;

  if duplicate_identifier or coalesce(array_length(candidate_ids, 1), 0) > 1 then
    return query select 'ambiguous'::text, null::uuid, 'Los identificadores coinciden con clientes distintos o duplicados.'::text;
    return;
  end if;

  if coalesce(array_length(candidate_ids, 1), 0) = 1 then
    select * into matched_customer
    from public.customers
    where id = candidate_ids[1];

    if not coalesce(matched_customer.active, false) or matched_customer.status <> 'active' then
      return query select 'review_required'::text, null::uuid, 'El cliente coincidente no está activo.'::text;
    else
      return query select 'reuse'::text, matched_customer.id, 'Cliente existente identificado de forma inequívoca.'::text;
    end if;
    return;
  end if;

  if normalized_tax_id is not null or normalized_email is not null or normalized_phone is not null then
    return query select 'create'::text, null::uuid, 'Se creará un cliente operativo sin cuenta web.'::text;
  else
    return query select 'review_required'::text, null::uuid, 'Completa RTN, correo o teléfono, o selecciona un cliente existente.'::text;
  end if;
end;
$$;

create or replace function public.preview_historical_accounts_receivable_import(target_batch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  target_batch public.import_batches%rowtype;
  row_item public.import_rows%rowtype;
  resolution_row record;
  target_customer_id uuid;
  dedupe_key text;
  outcome text;
  outcome_reason text;
  preview_rows jsonb := '[]'::jsonb;
  seen_create_identities text[] := '{}'::text[];
  seen_preview_debts text[] := '{}'::text[];
  create_identity_key text;
  preview_debt_key text;
  create_customer_count integer := 0;
  reuse_customer_count integer := 0;
  create_receivable_count integer := 0;
  duplicate_count integer := 0;
  ambiguous_count integer := 0;
  rejected_count integer := 0;
  review_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión para revisar esta importación.';
  end if;

  if not public.has_import_foundation_permission('accounts_receivable', 'review') then
    raise exception 'No tienes permiso para revisar importaciones de cuentas por cobrar.';
  end if;

  select * into target_batch
  from public.import_batches
  where id = target_batch_id
    and module = 'accounts_receivable';

  if target_batch.id is null then
    raise exception 'Lote de cuentas por cobrar no encontrado.';
  end if;

  for row_item in
    select *
    from public.import_rows
    where batch_id = target_batch_id
      and module = 'accounts_receivable'
    order by row_number
  loop
    target_customer_id := null;
    dedupe_key := null;
    outcome := null;
    outcome_reason := null;

    if row_item.apply_status = 'applied' then
      outcome := 'applied';
      outcome_reason := 'La fila ya fue aplicada.';
    elsif row_item.apply_status in ('skipped', 'rolled_back') then
      outcome := 'cancelled';
      outcome_reason := 'La fila fue cancelada o revertida.';
    elsif row_item.validation_status = 'invalid' then
      outcome := 'rejected';
      outcome_reason := 'La fila tiene errores de validación.';
      rejected_count := rejected_count + 1;
    elsif row_item.assignment_status = 'confirmed' and row_item.assigned_customer_id is not null then
      target_customer_id := row_item.assigned_customer_id;
      outcome := 'reuse_customer';
      outcome_reason := 'Se usará el cliente confirmado manualmente.';
      reuse_customer_count := reuse_customer_count + 1;
    else
      select * into resolution_row
      from public.resolve_receivable_import_customer(row_item.normalized_data);

      target_customer_id := resolution_row.customer_id;
      outcome_reason := resolution_row.reason;
      if resolution_row.resolution = 'reuse' then
        outcome := 'reuse_customer';
        reuse_customer_count := reuse_customer_count + 1;
      elsif resolution_row.resolution = 'create' then
        outcome := 'create_customer';
        create_identity_key := coalesce(
          'tax:' || public.normalize_receivable_import_tax_id(row_item.normalized_data ->> 'customer_tax_id'),
          'email:' || public.normalize_receivable_import_email(row_item.normalized_data ->> 'customer_email'),
          'phone:' || public.normalize_receivable_import_phone(row_item.normalized_data ->> 'customer_phone')
        );
        if create_identity_key is not null and not (create_identity_key = any(seen_create_identities)) then
          create_customer_count := create_customer_count + 1;
          seen_create_identities := array_append(seen_create_identities, create_identity_key);
        end if;
      elsif resolution_row.resolution = 'ambiguous' then
        outcome := 'ambiguous';
        ambiguous_count := ambiguous_count + 1;
        review_count := review_count + 1;
      else
        outcome := 'review_required';
        review_count := review_count + 1;
      end if;
    end if;

    if outcome in ('reuse_customer', 'create_customer') then
      if target_customer_id is not null then
        dedupe_key := public.receivable_import_dedupe_key(
          target_customer_id,
          row_item.normalized_data->>'invoice_number',
          (row_item.normalized_data->>'issue_date')::date,
          (row_item.normalized_data->>'original_amount')::numeric
        );
      end if;

      preview_debt_key := coalesce(
        dedupe_key,
        encode(extensions.digest(concat_ws(
          '|',
          coalesce(create_identity_key, ''),
          coalesce(lower(btrim(row_item.normalized_data->>'invoice_number')), ''),
          coalesce(row_item.normalized_data->>'issue_date', ''),
          coalesce(row_item.normalized_data->>'original_amount', '')
        ), 'sha256'), 'hex')
      );

      if (dedupe_key is not null and exists (
        select 1 from public.accounts_receivable where import_dedupe_key = dedupe_key
      )) or preview_debt_key = any(seen_preview_debts) then
        outcome := 'duplicate';
        outcome_reason := 'La deuda ya existe y no volverá a crearse.';
        duplicate_count := duplicate_count + 1;
      else
        create_receivable_count := create_receivable_count + 1;
        seen_preview_debts := array_append(seen_preview_debts, preview_debt_key);
      end if;
    end if;

    preview_rows := preview_rows || jsonb_build_array(jsonb_build_object(
      'row_id', row_item.id,
      'outcome', outcome,
      'reason', outcome_reason
    ));
  end loop;

  return jsonb_build_object(
    'batch_status', target_batch.status,
    'create_customers', create_customer_count,
    'reuse_customers', reuse_customer_count,
    'create_receivables', create_receivable_count,
    'duplicates', duplicate_count,
    'ambiguous', ambiguous_count,
    'rejected', rejected_count,
    'review_required', review_count,
    'processable', create_receivable_count + duplicate_count,
    'rows', preview_rows
  );
end;
$$;

create or replace function public.confirm_and_apply_receivable_import_batch(target_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target_batch public.import_batches%rowtype;
  row_item public.import_rows%rowtype;
  resolution_row record;
  target_customer_id uuid;
  existing_receivable_id uuid;
  created_receivable_id uuid;
  normalized_tax_id text;
  normalized_email text;
  normalized_phone text;
  normalized_name text;
  normalized_invoice text;
  normalized_status text;
  normalized_method text;
  issue_date_value date;
  due_date_value date;
  original_amount_value numeric(12, 2);
  paid_amount_value numeric(12, 2);
  balance_due_value numeric(12, 2);
  dedupe_key text;
  row_created_customer boolean;
  row_reused_customer boolean;
  created_customers integer := 0;
  reused_customers integer := 0;
  created_receivables integer := 0;
  reused_receivables integer := 0;
  duplicates integer := 0;
  ambiguous integer := 0;
  rejected integer := 0;
  applied_row_count integer := 0;
  review_required_rows integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Debes iniciar sesión para confirmar esta importación.';
  end if;

  if not public.has_import_foundation_permission('accounts_receivable', 'apply') then
    raise exception 'No tienes permiso para confirmar importaciones de cuentas por cobrar.';
  end if;

  select * into target_batch
  from public.import_batches
  where id = target_batch_id
  for update;

  if target_batch.id is null or target_batch.module <> 'accounts_receivable' then
    raise exception 'Lote de cuentas por cobrar no encontrado.';
  end if;

  if target_batch.status = 'cancelled' then
    raise exception 'Este lote fue cancelado. Corrige el archivo y vuelve a importarlo.';
  end if;

  if target_batch.status in ('applied', 'rolled_back') then
    raise exception 'Este lote ya fue cerrado.';
  end if;

  for row_item in
    select *
    from public.import_rows
    where batch_id = target_batch_id
      and module = 'accounts_receivable'
      and apply_status in ('pending', 'ready', 'failed')
    order by row_number
    for update
  loop
    if row_item.validation_status = 'invalid' then
      rejected := rejected + 1;
      continue;
    end if;

    begin
      target_customer_id := null;
      existing_receivable_id := null;
      created_receivable_id := null;
      dedupe_key := null;
      row_created_customer := false;
      row_reused_customer := false;
      normalized_name := nullif(trim(row_item.normalized_data->>'customer_name'), '');
      normalized_invoice := nullif(trim(row_item.normalized_data->>'invoice_number'), '');
      normalized_tax_id := public.normalize_receivable_import_tax_id(row_item.normalized_data->>'customer_tax_id');
      normalized_email := public.normalize_receivable_import_email(row_item.normalized_data->>'customer_email');
      normalized_phone := public.normalize_receivable_import_phone(row_item.normalized_data->>'customer_phone');
      normalized_status := row_item.normalized_data->>'status';
      issue_date_value := (row_item.normalized_data->>'issue_date')::date;
      due_date_value := (row_item.normalized_data->>'due_date')::date;
      original_amount_value := round((row_item.normalized_data->>'original_amount')::numeric, 2);
      paid_amount_value := round(coalesce((row_item.normalized_data->>'paid_amount')::numeric, 0), 2);
      balance_due_value := round((row_item.normalized_data->>'balance_due')::numeric, 2);

      if normalized_name is null or char_length(normalized_name) < 2 then
        raise exception 'La fila requiere un nombre de cliente válido.';
      end if;
      if normalized_invoice is null then
        raise exception 'La fila requiere un número de factura o referencia.';
      end if;
      if due_date_value < issue_date_value then
        raise exception 'La fecha de vencimiento no puede ser anterior a la fecha de emisión.';
      end if;
      if original_amount_value <= 0 or paid_amount_value < 0 or balance_due_value < 0
         or abs(original_amount_value - paid_amount_value - balance_due_value) > 0.01 then
        raise exception 'Los montos de la fila no son consistentes.';
      end if;
      if normalized_status not in ('pending', 'partial', 'paid', 'overdue', 'cancelled') then
        raise exception 'El estado de la cuenta por cobrar no es válido.';
      end if;
      if (normalized_status = 'paid' and balance_due_value <> 0)
         or (normalized_status = 'partial' and (paid_amount_value <= 0 or balance_due_value <= 0))
         or (normalized_status in ('pending', 'overdue') and balance_due_value <= 0)
         or (normalized_status = 'cancelled' and balance_due_value <> 0) then
        raise exception 'El estado y el saldo de la fila no son consistentes.';
      end if;

      if row_item.assignment_status = 'confirmed' and row_item.assigned_customer_id is not null then
        select id into target_customer_id
        from public.customers
        where id = row_item.assigned_customer_id
          and active = true
          and status = 'active';
        if target_customer_id is null then
          raise exception 'El cliente asignado no está disponible.';
        end if;
        row_reused_customer := true;
      else
        if normalized_tax_id is not null then
          perform pg_advisory_xact_lock(hashtextextended('receivable-import-tax:' || normalized_tax_id, 0));
        end if;
        if normalized_email is not null then
          perform pg_advisory_xact_lock(hashtextextended('receivable-import-email:' || normalized_email, 0));
        end if;
        if normalized_phone is not null then
          perform pg_advisory_xact_lock(hashtextextended('receivable-import-phone:' || normalized_phone, 0));
        end if;

        select * into resolution_row
        from public.resolve_receivable_import_customer(row_item.normalized_data);

        if resolution_row.resolution = 'ambiguous' then
          update public.import_rows
          set assignment_status = 'unassigned',
              apply_status = 'pending',
              apply_error = resolution_row.reason,
              audit_metadata = audit_metadata || jsonb_build_object('direct_import_resolution', 'ambiguous'),
              updated_at = now()
          where id = row_item.id;
          ambiguous := ambiguous + 1;
          review_required_rows := review_required_rows + 1;
          continue;
        elsif resolution_row.resolution = 'review_required' then
          update public.import_rows
          set assignment_status = 'unassigned',
              apply_status = 'pending',
              apply_error = resolution_row.reason,
              audit_metadata = audit_metadata || jsonb_build_object('direct_import_resolution', 'review_required'),
              updated_at = now()
          where id = row_item.id;
          review_required_rows := review_required_rows + 1;
          continue;
        elsif resolution_row.resolution = 'reuse' then
          target_customer_id := resolution_row.customer_id;
          row_reused_customer := true;
        else
          insert into public.customers (
            user_id,
            business_name,
            company_name,
            contact_name,
            email,
            phone,
            tax_id,
            notes,
            is_wholesale,
            active,
            status,
            lead_status,
            source
          )
          values (
            null,
            normalized_name,
            normalized_name,
            normalized_name,
            normalized_email,
            normalized_phone,
            normalized_tax_id,
            'Cliente operativo creado desde importación histórica de cuentas por cobrar.',
            false,
            true,
            'active',
            'cliente',
            'historical_receivable_import'
          )
          returning id into target_customer_id;
          row_created_customer := true;
        end if;
      end if;

      dedupe_key := public.receivable_import_dedupe_key(
        target_customer_id,
        normalized_invoice,
        issue_date_value,
        original_amount_value
      );
      perform pg_advisory_xact_lock(hashtextextended('receivable-import-debt:' || dedupe_key, 0));

      select id into existing_receivable_id
      from public.accounts_receivable
      where import_dedupe_key = dedupe_key;

      if existing_receivable_id is not null then
        update public.import_rows
        set assigned_customer_id = target_customer_id,
            assigned_by = auth.uid(),
            assigned_at = coalesce(assigned_at, now()),
            assignment_status = 'confirmed',
            apply_status = 'applied',
            apply_error = null,
            audit_metadata = audit_metadata || jsonb_build_object(
              'direct_import_resolution', 'duplicate',
              'applied_receivable_id', existing_receivable_id
            ),
            updated_at = now()
        where id = row_item.id;

        insert into public.import_audit_events (batch_id, row_id, module, event_type, metadata, created_by)
        values (
          target_batch_id,
          row_item.id,
          'accounts_receivable',
          'row_reused',
          jsonb_build_object('receivable_id', existing_receivable_id, 'dedupe_key', dedupe_key),
          auth.uid()
        );

        if row_created_customer then
          created_customers := created_customers + 1;
        elsif row_reused_customer then
          reused_customers := reused_customers + 1;
        end if;
        reused_receivables := reused_receivables + 1;
        duplicates := duplicates + 1;
        applied_row_count := applied_row_count + 1;
        continue;
      end if;

      normalized_method := case row_item.normalized_data->>'payment_method'
        when 'bank_transfer' then 'bank_transfer'
        when 'card' then 'card'
        else 'cash'
      end;

      insert into public.accounts_receivable (
        customer_id,
        order_id,
        invoice_id,
        original_amount,
        balance_due,
        due_date,
        status,
        paid_at,
        overdue_at,
        payment_received_method,
        payment_received_reference,
        payment_recorded_by,
        historical_invoice_number,
        imported_from_batch_id,
        imported_from_row_id,
        imported_observations,
        imported_metadata,
        import_dedupe_key
      )
      values (
        target_customer_id,
        null,
        null,
        original_amount_value,
        balance_due_value,
        due_date_value,
        case when normalized_status = 'pending' then 'open' else normalized_status end,
        case when normalized_status = 'paid' then issue_date_value::timestamptz else null end,
        case when normalized_status = 'overdue' then now() else null end,
        case when paid_amount_value > 0 or normalized_status = 'paid' then normalized_method else null end,
        nullif(trim(row_item.normalized_data->>'reference'), ''),
        case when paid_amount_value > 0 or normalized_status = 'paid' then auth.uid() else null end,
        normalized_invoice,
        target_batch_id,
        row_item.id,
        nullif(trim(row_item.normalized_data->>'notes'), ''),
        jsonb_build_object(
          'source', 'historical_accounts_receivable_import',
          'issue_date', issue_date_value,
          'customer_code', nullif(trim(row_item.normalized_data->>'customer_code'), '')
        ),
        dedupe_key
      )
      returning id into created_receivable_id;

      if paid_amount_value > 0 then
        insert into public.accounts_receivable_payments (
          receivable_id,
          customer_id,
          order_id,
          amount,
          payment_method,
          reference,
          received_at,
          note,
          recorded_by,
          idempotency_key
        )
        values (
          created_receivable_id,
          target_customer_id,
          null,
          paid_amount_value,
          normalized_method,
          nullif(trim(row_item.normalized_data->>'reference'), ''),
          issue_date_value::timestamptz,
          'Pago histórico importado.',
          auth.uid(),
          'historical-ar-import:' || dedupe_key
        );
      end if;

      update public.import_rows
      set assigned_customer_id = target_customer_id,
          assigned_by = auth.uid(),
          assigned_at = coalesce(assigned_at, now()),
          assignment_status = 'confirmed',
          apply_status = 'applied',
          apply_error = null,
          audit_metadata = audit_metadata || jsonb_build_object(
            'direct_import_resolution', 'created',
            'applied_receivable_id', created_receivable_id
          ),
          updated_at = now()
      where id = row_item.id;

      insert into public.import_audit_events (batch_id, row_id, module, event_type, metadata, created_by)
      values (
        target_batch_id,
        row_item.id,
        'accounts_receivable',
        'row_applied',
        jsonb_build_object('receivable_id', created_receivable_id, 'dedupe_key', dedupe_key),
        auth.uid()
      );

      insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
      values (
        auth.uid(),
        public.current_actor_role(),
        'accounts_receivable',
        created_receivable_id,
        'historical_receivable_import.applied',
        jsonb_build_object(
          'batch_id', target_batch_id,
          'row_id', row_item.id,
          'customer_id', target_customer_id,
          'order_id', null,
          'receivable_kind', 'historical',
          'import_dedupe_key', dedupe_key
        )
      );

      if row_created_customer then
        created_customers := created_customers + 1;
      elsif row_reused_customer then
        reused_customers := reused_customers + 1;
      end if;
      created_receivables := created_receivables + 1;
      applied_row_count := applied_row_count + 1;
    exception
      when unique_violation then
        existing_receivable_id := null;
        if dedupe_key is not null then
          select id into existing_receivable_id
          from public.accounts_receivable
          where import_dedupe_key = dedupe_key;
        end if;

        if existing_receivable_id is null then
          update public.import_rows
          set apply_status = 'failed',
              apply_error = 'La fila entró en conflicto con otro registro y requiere revisión.',
              updated_at = now()
          where id = row_item.id;
          rejected := rejected + 1;
        else
          update public.import_rows
          set assigned_customer_id = target_customer_id,
              assigned_by = auth.uid(),
              assigned_at = coalesce(assigned_at, now()),
              assignment_status = 'confirmed',
              apply_status = 'applied',
              apply_error = null,
              audit_metadata = audit_metadata || jsonb_build_object(
                'direct_import_resolution', 'duplicate_concurrent',
                'applied_receivable_id', existing_receivable_id
              ),
              updated_at = now()
          where id = row_item.id;
          if row_reused_customer then
            reused_customers := reused_customers + 1;
          end if;
          reused_receivables := reused_receivables + 1;
          duplicates := duplicates + 1;
          applied_row_count := applied_row_count + 1;
        end if;
      when others then
        update public.import_rows
        set apply_status = 'failed',
            apply_error = case
              when sqlerrm in (
                'La fila requiere un nombre de cliente válido.',
                'La fila requiere un número de factura o referencia.',
                'La fecha de vencimiento no puede ser anterior a la fecha de emisión.',
                'Los montos de la fila no son consistentes.',
                'El estado de la cuenta por cobrar no es válido.',
                'El estado y el saldo de la fila no son consistentes.',
                'El cliente asignado no está disponible.'
              ) then sqlerrm
              else 'No se pudo aplicar la fila. Revisa sus datos e inténtalo de nuevo.'
            end,
            updated_at = now()
        where id = row_item.id;
        rejected := rejected + 1;
    end;
  end loop;

  perform public.recount_import_batch(target_batch_id);

  update public.import_batches
  set status = case
      when exists (
        select 1
        from public.import_rows
        where batch_id = target_batch_id
          and validation_status in ('valid', 'warning')
          and apply_status not in ('applied', 'skipped')
      ) then 'pending_assignment'
      else 'applied'
    end,
    applied_at = case when applied_row_count > 0 then coalesce(applied_at, now()) else applied_at end,
    completed_at = case
      when not exists (
        select 1
        from public.import_rows
        where batch_id = target_batch_id
          and validation_status in ('valid', 'warning')
          and apply_status not in ('applied', 'skipped')
      ) then now()
      else null
    end,
    metadata = metadata || jsonb_build_object(
      'last_direct_apply', jsonb_build_object(
        'created_customers', created_customers,
        'reused_customers', reused_customers,
        'created_receivables', created_receivables,
        'reused_receivables', reused_receivables,
        'duplicates', duplicates,
        'ambiguous', ambiguous,
        'rejected', rejected,
        'applied_rows', applied_row_count,
        'review_required_rows', review_required_rows
      )
    ),
    updated_at = now()
  where id = target_batch_id;

  insert into public.import_audit_events (batch_id, module, event_type, metadata, created_by)
  values (
    target_batch_id,
    'accounts_receivable',
    'batch_confirmed_and_applied',
    jsonb_build_object(
      'created_customers', created_customers,
      'reused_customers', reused_customers,
      'created_receivables', created_receivables,
      'reused_receivables', reused_receivables,
      'duplicates', duplicates,
      'ambiguous', ambiguous,
      'rejected', rejected,
      'applied_rows', applied_row_count,
      'review_required_rows', review_required_rows
    ),
    auth.uid()
  );

  return jsonb_build_object(
    'created_customers', created_customers,
    'reused_customers', reused_customers,
    'created_receivables', created_receivables,
    'reused_receivables', reused_receivables,
    'duplicates', duplicates,
    'ambiguous', ambiguous,
    'rejected', rejected,
    'applied_rows', applied_row_count,
    'review_required_rows', review_required_rows
  );
end;
$$;

revoke all on function public.normalize_receivable_import_email(text) from public;
revoke all on function public.normalize_receivable_import_tax_id(text) from public;
revoke all on function public.normalize_receivable_import_phone(text) from public;
revoke all on function public.receivable_import_dedupe_key(uuid, text, date, numeric) from public;
revoke all on function public.resolve_receivable_import_customer(jsonb) from public;
revoke all on function public.preview_historical_accounts_receivable_import(uuid) from public;
revoke all on function public.confirm_and_apply_receivable_import_batch(uuid) from public;

grant execute on function public.preview_historical_accounts_receivable_import(uuid) to authenticated;
grant execute on function public.confirm_and_apply_receivable_import_batch(uuid) to authenticated;

create or replace function public.register_credit_receivable_payment(
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
  receivable_status text,
  balance_due numeric,
  total_paid numeric,
  queued_email_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  actor_role_name text;
  receivable_row record;
  existing_payment public.accounts_receivable_payments%rowtype;
  saved_payment public.accounts_receivable_payments%rowtype;
  normalized_amount numeric(12, 2) := round(coalesce(payment_amount, 0), 2);
  normalized_method text;
  normalized_reference text := nullif(left(trim(coalesce(payment_reference, '')), 200), '');
  normalized_note text := nullif(left(trim(coalesce(payment_note, '')), 1000), '');
  normalized_receipt_url text := nullif(left(trim(coalesce(payment_receipt_url, '')), 1000), '');
  normalized_receipt_public_id text := nullif(left(trim(coalesce(payment_receipt_public_id, '')), 300), '');
  normalized_request_key text := nullif(left(trim(coalesce(request_key, '')), 200), '');
  normalized_received_at timestamptz := coalesce(payment_received_at, now());
  paid_total numeric(12, 2);
  remaining_balance numeric(12, 2);
  next_status text;
  notification_id uuid;
  receivable_kind text;
  receivable_label text;
begin
  select r.name
    into actor_role_name
    from public.users u
    left join public.roles r on r.id = u.role_id
    where u.id = actor_id;

  if actor_id is null or not public.has_permission('credit:mark_paid') then
    insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.payment_permission_denied',
      actor_id,
      jsonb_build_object('attempted_action', 'register_payment', 'role', actor_role_name)
    );
    raise exception 'No tienes permiso para registrar abonos de credito comercial.';
  end if;

  normalized_method := case lower(trim(coalesce(received_payment_method, '')))
    when 'bank_transfer' then 'bank_transfer'
    when 'transferencia bancaria' then 'bank_transfer'
    when 'transferencia' then 'bank_transfer'
    when 'card' then 'card'
    when 'tarjeta' then 'card'
    when 'cash' then 'cash'
    when 'efectivo' then 'cash'
    else null
  end;

  if normalized_method is null then
    raise exception 'Selecciona el metodo de pago del abono.';
  end if;

  if normalized_method = 'cash' then
    normalized_reference := null;
  end if;

  if normalized_amount <= 0 then
    raise exception 'El abono debe ser mayor que cero.';
  end if;

  if normalized_request_key is not null then
    select *
      into existing_payment
      from public.accounts_receivable_payments
      where idempotency_key = normalized_request_key
      limit 1;

    if existing_payment.id is not null then
      select coalesce(sum(amount), 0)
        into paid_total
        from public.accounts_receivable_payments
        where receivable_id = existing_payment.receivable_id
          and voided_at is null;

      select ar.status, ar.balance_due
        into receivable_status, balance_due
        from public.accounts_receivable ar
        where ar.id = existing_payment.receivable_id;

      payment_id := existing_payment.id;
      total_paid := paid_total;
      queued_email_id := null;
      return next;
      return;
    end if;
  end if;

  select
      ar.id,
      ar.customer_id,
      ar.order_id,
      ar.invoice_id,
      ar.historical_invoice_number,
      ar.imported_from_batch_id,
      ar.imported_from_row_id,
      ar.original_amount,
      ar.balance_due,
      ar.due_date,
      ar.status,
      ar.paid_at,
      ar.payment_received_method,
      ar.payment_received_reference,
      ar.payment_recorded_by,
      ar.created_at,
      ar.updated_at,
      c.user_id as customer_user_id,
      c.email as customer_email,
      c.contact_name as customer_contact_name,
      c.business_name as customer_business_name,
      o.order_number,
      i.status as invoice_status
    into receivable_row
    from public.accounts_receivable ar
    join public.customers c on c.id = ar.customer_id
    left join public.orders o on o.id = ar.order_id
    left join public.invoices i on i.id = ar.invoice_id
    where ar.id = target_receivable_id
    for update of ar;

  if receivable_row.id is null then
    raise exception 'Cuenta por cobrar no encontrada.';
  end if;

  receivable_kind := case when receivable_row.order_id is null then 'historical' else 'normal' end;
  receivable_label := coalesce(
    nullif(receivable_row.order_number, ''),
    nullif(receivable_row.historical_invoice_number, ''),
    'CxC ' || left(receivable_row.id::text, 8)
  );

  if receivable_row.status = 'paid' then
    insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.payment_on_paid_denied',
      actor_id,
      jsonb_build_object('attempted_amount', normalized_amount, 'receivable_kind', receivable_kind)
    );
    raise exception 'Esta cuenta por cobrar ya esta pagada.';
  end if;

  if receivable_row.status = 'cancelled' then
    insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.payment_on_cancelled_denied',
      actor_id,
      jsonb_build_object('attempted_amount', normalized_amount, 'receivable_kind', receivable_kind)
    );
    raise exception 'Esta cuenta por cobrar esta cancelada.';
  end if;

  if receivable_row.invoice_status in ('anulada', 'cancelled') then
    insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.payment_on_void_invoice_denied',
      actor_id,
      jsonb_build_object('invoice_id', receivable_row.invoice_id, 'invoice_status', receivable_row.invoice_status, 'receivable_kind', receivable_kind)
    );
    raise exception 'Esta cuenta por cobrar tiene factura anulada y no acepta abonos.';
  end if;

  if normalized_amount > receivable_row.balance_due then
    insert into public.audit_logs (table_name, record_id, action, user_id, new_data)
    values (
      'accounts_receivable',
      target_receivable_id,
      'commercial_credit.overpayment_denied',
      actor_id,
      jsonb_build_object(
        'attempted_amount', normalized_amount,
        'balance_due', receivable_row.balance_due,
        'order_id', receivable_row.order_id,
        'receivable_kind', receivable_kind
      )
    );
    raise exception 'El abono no puede ser mayor que el saldo pendiente de esta cuenta por cobrar.';
  end if;

  begin
    insert into public.accounts_receivable_payments (
      receivable_id,
      customer_id,
      order_id,
      amount,
      payment_method,
      reference,
      received_at,
      note,
      receipt_url,
      receipt_public_id,
      recorded_by,
      idempotency_key
    )
    values (
      receivable_row.id,
      receivable_row.customer_id,
      receivable_row.order_id,
      normalized_amount,
      normalized_method,
      normalized_reference,
      normalized_received_at,
      normalized_note,
      normalized_receipt_url,
      normalized_receipt_public_id,
      actor_id,
      normalized_request_key
    )
    returning * into saved_payment;
  exception
    when unique_violation then
      if normalized_request_key is null then
        raise;
      end if;

      select *
        into saved_payment
        from public.accounts_receivable_payments
        where idempotency_key = normalized_request_key
        limit 1;

      if saved_payment.id is null then
        raise;
      end if;

      select round(coalesce(sum(amount), 0), 2)
        into paid_total
        from public.accounts_receivable_payments
        where receivable_id = saved_payment.receivable_id
          and voided_at is null;

      select ar.status, ar.balance_due
        into receivable_status, balance_due
        from public.accounts_receivable ar
        where ar.id = saved_payment.receivable_id;

      payment_id := saved_payment.id;
      total_paid := paid_total;
      queued_email_id := null;
      return next;
      return;
  end;

  select round(coalesce(sum(amount), 0), 2)
    into paid_total
    from public.accounts_receivable_payments
    where receivable_id = receivable_row.id
      and voided_at is null;

  remaining_balance := greatest(round(receivable_row.original_amount - paid_total, 2), 0);
  next_status := case
    when remaining_balance = 0 then 'paid'
    when receivable_row.due_date < current_date then 'overdue'
    else 'partial'
  end;

  update public.accounts_receivable
    set balance_due = remaining_balance,
        status = next_status,
        paid_at = case when remaining_balance = 0 then now() else null end,
        overdue_at = case
          when next_status = 'overdue' then coalesce(overdue_at, now())
          when next_status in ('partial', 'paid') then overdue_at
          else overdue_at
        end,
        payment_received_method = normalized_method,
        payment_received_reference = normalized_reference,
        payment_recorded_by = actor_id,
        updated_at = now()
    where id = receivable_row.id;

  if remaining_balance = 0 then
    if receivable_row.order_id is not null then
      update public.payments
        set payment_status = 'approved',
            status = 'approved',
            paid_at = now(),
            bank_reference_number = case when normalized_method = 'bank_transfer' then normalized_reference else bank_reference_number end,
            reference = case when normalized_method in ('bank_transfer', 'card') then normalized_reference else reference end,
            updated_at = now()
        where order_id = receivable_row.order_id
          and payment_method = 'commercial_credit';
    end if;

    update public.email_queue
      set status = 'cancelled',
          updated_at = now()
      where related_module = 'pagos'
        and related_id = receivable_row.id
        and status in ('pending', 'retrying')
        and template_key in (
          'commercial_credit.reminder_7_days',
          'commercial_credit.reminder_3_days',
          'commercial_credit.reminder_1_day',
          'commercial_credit.overdue'
        );
  end if;

  if receivable_row.customer_user_id is not null then
    insert into public.internal_notifications (
      event_type,
      notification_type,
      module,
      user_id,
      customer_id,
      order_id,
      title,
      message,
      severity,
      audience_roles,
      read_state,
      status,
      metadata,
      dedupe_key
    )
    values (
      case when remaining_balance = 0 then 'customer.commercial_credit.paid_complete' else 'customer.commercial_credit.payment_registered:' || saved_payment.id::text end,
      case when remaining_balance = 0 then 'commercial_credit.paid_complete' else 'commercial_credit.payment_registered' end,
      'pagos',
      receivable_row.customer_user_id,
      receivable_row.customer_id,
      receivable_row.order_id,
      case when remaining_balance = 0 then 'Credito pagado completamente' else 'Abono registrado' end,
      case
        when remaining_balance = 0 then 'Tu credito comercial fue pagado completamente.'
        else 'Hemos registrado un abono a tu credito comercial.'
      end,
      'info',
      array[]::text[],
      'unread',
      'open',
      jsonb_build_object(
        'receivable_id', receivable_row.id,
        'payment_id', saved_payment.id,
        'order_number', receivable_row.order_number,
        'receivable_label', receivable_label,
        'receivable_kind', receivable_kind,
        'amount', normalized_amount,
        'balance_due', remaining_balance,
        'action_path', '/cuenta'
      ),
      'credit-payment:' || saved_payment.id::text
    );
  end if;

  insert into public.internal_notifications (
    event_type,
    notification_type,
    module,
    customer_id,
    order_id,
    title,
    message,
    severity,
    audience_roles,
    read_state,
    status,
    metadata,
    dedupe_key
  )
  values (
    case when remaining_balance = 0 then 'commercial_credit.paid_complete' else 'commercial_credit.payment_registered:' || saved_payment.id::text end,
    case when remaining_balance = 0 then 'commercial_credit.paid_complete' else 'commercial_credit.payment_registered' end,
    'pagos',
    receivable_row.customer_id,
    receivable_row.order_id,
    case when remaining_balance = 0 then 'Credito comercial pagado' else 'Abono de credito registrado' end,
    receivable_label || ': abono L ' || normalized_amount::text || ', saldo L ' || remaining_balance::text || '.',
    case when remaining_balance = 0 then 'info' else 'warning' end,
    array['technical_owner','business_owner','admin']::text[],
    'unread',
    'open',
    jsonb_build_object(
      'receivable_id', receivable_row.id,
      'payment_id', saved_payment.id,
      'order_number', receivable_row.order_number,
      'receivable_label', receivable_label,
      'receivable_kind', receivable_kind,
      'amount', normalized_amount,
      'balance_due', remaining_balance
    ),
    'credit-payment-internal:' || saved_payment.id::text
  )
  returning id into notification_id;

  if coalesce(receivable_row.customer_email, '') like '%@%' then
    insert into public.email_queue (
      to_email,
      to_name,
      subject,
      template_key,
      payload,
      status,
      scheduled_at,
      idempotency_key,
      related_module,
      related_id,
      priority
    )
    values (
      lower(trim(receivable_row.customer_email)),
      coalesce(nullif(receivable_row.customer_business_name, ''), nullif(receivable_row.customer_contact_name, ''), receivable_row.customer_email),
      case when remaining_balance = 0 then 'Tu credito ha sido pagado completamente' else 'Hemos registrado tu abono' end,
      case when remaining_balance = 0 then 'commercial_credit.paid_complete' else 'commercial_credit.payment_registered' end,
      jsonb_build_object(
        'title', case when remaining_balance = 0 then 'Tu credito ha sido pagado completamente' else 'Hemos registrado tu abono' end,
        'message', case
          when remaining_balance = 0 then 'El saldo de esta cuenta por cobrar quedo pagado completamente.'
          else 'Registramos tu abono para esta cuenta por cobrar.'
        end,
        'customer_name', coalesce(nullif(receivable_row.customer_business_name, ''), nullif(receivable_row.customer_contact_name, ''), 'Cliente'),
        'order_number', receivable_row.order_number,
        'receivable_label', receivable_label,
        'receivable_kind', receivable_kind,
        'amount', normalized_amount,
        'balance_due', remaining_balance,
        'received_at', normalized_received_at,
        'payment_method', case
          when normalized_method = 'bank_transfer' then 'Transferencia bancaria'
          when normalized_method = 'card' then 'Tarjeta'
          else 'Efectivo'
        end,
        'reference', normalized_reference,
        'action_label', 'Ver mi cuenta',
        'action_path', '/cuenta'
      ),
      'pending',
      now(),
      'credit.payment:' || saved_payment.id::text,
      'pagos',
      receivable_row.id,
      2
    )
    returning id into queued_email_id;
  else
    queued_email_id := null;
  end if;

  insert into public.audit_logs (table_name, record_id, action, user_id, old_data, new_data)
  values (
    'accounts_receivable_payments',
    saved_payment.id,
    'commercial_credit.payment_registered',
    actor_id,
    null,
    to_jsonb(saved_payment)
  ), (
    'accounts_receivable',
    receivable_row.id,
    case when next_status = 'paid' then 'commercial_credit.receivable_paid' else 'commercial_credit.receivable_partial' end,
    actor_id,
    jsonb_build_object(
      'status', receivable_row.status,
      'balance_due', receivable_row.balance_due,
      'paid_at', receivable_row.paid_at
    ),
    jsonb_build_object(
      'status', next_status,
      'balance_due', remaining_balance,
      'total_paid', paid_total,
      'payment_id', saved_payment.id,
      'paid_at', case when remaining_balance = 0 then now() else null end,
      'receivable_kind', receivable_kind,
      'customer_id', receivable_row.customer_id,
      'order_id', receivable_row.order_id,
      'historical_invoice_number', receivable_row.historical_invoice_number,
      'payment_method', normalized_method,
      'reference', normalized_reference,
      'source', 'admin_accounts_receivable'
    )
  );

  payment_id := saved_payment.id;
  receivable_status := next_status;
  balance_due := remaining_balance;
  total_paid := paid_total;
  return next;
end;
$$;

grant execute on function public.register_credit_receivable_payment(uuid, numeric, text, text, timestamptz, text, text, text, text) to authenticated;
