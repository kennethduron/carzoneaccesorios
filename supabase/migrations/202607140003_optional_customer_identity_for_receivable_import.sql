-- This migration changes schema and function definitions only. It never confirms
-- or applies an existing batch and does not create customers, receivables, or payments.

alter table public.customers
  alter column phone drop not null,
  alter column email drop not null,
  alter column tax_id drop not null,
  alter column user_id drop not null;

alter table public.customers
  add column if not exists historical_receivable_import_key text,
  add column if not exists imported_from_receivable_row_id uuid references public.import_rows(id) on delete set null;

create unique index if not exists customers_historical_receivable_import_key_idx
  on public.customers(historical_receivable_import_key)
  where historical_receivable_import_key is not null;

create unique index if not exists customers_imported_from_receivable_row_id_idx
  on public.customers(imported_from_receivable_row_id)
  where imported_from_receivable_row_id is not null;
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

create or replace function public.receivable_import_customer_source_key(
  row_data jsonb,
  source_row_number integer
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
        'historical_receivable_customer',
        lower(regexp_replace(trim(coalesce(row_data->>'customer_name', '')), '[[:space:]]+', ' ', 'g')),
        lower(trim(coalesce(row_data->>'customer_code', ''))),
        lower(regexp_replace(trim(coalesce(row_data->>'invoice_number', '')), '[[:space:]]+', '', 'g')),
        coalesce(row_data->>'issue_date', ''),
        coalesce(round((nullif(row_data->>'original_amount', ''))::numeric, 2)::text, ''),
        coalesce(source_row_number, 0)::text
      ),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function public.is_generic_receivable_import_reference(invoice_number text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select lower(regexp_replace(trim(coalesce(invoice_number, '')), '[^[:alnum:]]', '', 'g'))
    in ('saldoinicial', 'saldoanterior', 'saldo', 'apertura');
$$;

create or replace function public.receivable_import_dedupe_key(
  target_customer_id uuid,
  invoice_number text,
  issue_date date,
  original_amount numeric,
  source_key text,
  source_row_number integer
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
        round(original_amount, 2)::text,
        case when public.is_generic_receivable_import_reference(invoice_number)
          then coalesce(source_key, '')
          else ''
        end,
        case when public.is_generic_receivable_import_reference(invoice_number)
          then coalesce(source_row_number, 0)::text
          else ''
        end
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
    return query select
      'ambiguous'::text,
      null::uuid,
      'Se encontraron datos que apuntan a clientes diferentes. Selecciona el cliente correcto.'::text;
    return;
  end if;

  if coalesce(array_length(candidate_ids, 1), 0) = 1 then
    select * into matched_customer
    from public.customers
    where id = candidate_ids[1];

    if not coalesce(matched_customer.active, false) or matched_customer.status <> 'active' then
      return query select 'review_required'::text, null::uuid, 'El cliente coincidente no está activo.'::text;
    else
      return query select 'reuse'::text, matched_customer.id, 'Se reutilizará el cliente existente.'::text;
    end if;
    return;
  end if;

  return query select
    'create'::text,
    null::uuid,
    'Se creará un cliente operativo sin cuenta web. RTN, correo y teléfono son opcionales.'::text;
end;
$$;
create or replace function public.preview_historical_accounts_receivable_import(target_batch_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  target_batch public.import_batches%rowtype;
  row_item public.import_rows%rowtype;
  resolution_row record;
  source_customer public.customers%rowtype;
  target_customer_id uuid;
  source_key text;
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
    source_customer := null;
    source_key := public.receivable_import_customer_source_key(row_item.normalized_data, row_item.row_number);
    dedupe_key := null;
    outcome := null;
    outcome_reason := null;
    create_identity_key := null;

    if row_item.apply_status = 'applied' then
      outcome := 'applied';
      outcome_reason := 'La fila ya fue aplicada.';
    elsif row_item.apply_status in ('skipped', 'rolled_back')
       or row_item.normalized_data->>'status' = 'cancelled' then
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
        select * into source_customer
        from public.customers
        where historical_receivable_import_key = source_key;

        if source_customer.id is not null then
          if coalesce(source_customer.active, false) and source_customer.status = 'active' then
            target_customer_id := source_customer.id;
            outcome := 'reuse_customer';
            outcome_reason := 'Se reutilizará el cliente operativo creado previamente para esta misma fila de origen.';
            reuse_customer_count := reuse_customer_count + 1;
          else
            outcome := 'review_required';
            outcome_reason := 'El cliente operativo creado previamente para esta fila no está activo.';
            review_count := review_count + 1;
          end if;
        else
          outcome := 'create_customer';
          create_identity_key := coalesce(
            'tax:' || public.normalize_receivable_import_tax_id(row_item.normalized_data->>'customer_tax_id'),
            'email:' || public.normalize_receivable_import_email(row_item.normalized_data->>'customer_email'),
            'phone:' || public.normalize_receivable_import_phone(row_item.normalized_data->>'customer_phone'),
            'source:' || source_key
          );
          if not (create_identity_key = any(seen_create_identities)) then
            create_customer_count := create_customer_count + 1;
            seen_create_identities := array_append(seen_create_identities, create_identity_key);
          end if;
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
          (row_item.normalized_data->>'original_amount')::numeric,
          source_key,
          row_item.row_number
        );
      end if;

      preview_debt_key := coalesce(
        dedupe_key,
        encode(extensions.digest(concat_ws(
          '|',
          source_key,
          coalesce(lower(btrim(row_item.normalized_data->>'invoice_number')), ''),
          coalesce(row_item.normalized_data->>'issue_date', ''),
          coalesce(row_item.normalized_data->>'original_amount', ''),
          row_item.row_number::text
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
        if public.is_generic_receivable_import_reference(row_item.normalized_data->>'invoice_number') then
          outcome_reason := outcome_reason || ' La referencia genérica usa origen, fila, fecha y monto en su huella de deduplicación.';
        end if;
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
  source_customer public.customers%rowtype;
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
  source_key text;
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
      source_key := public.receivable_import_customer_source_key(row_item.normalized_data, row_item.row_number);
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

      if normalized_status = 'cancelled' then
        update public.import_rows
        set apply_status = 'skipped',
            apply_error = null,
            audit_metadata = audit_metadata || jsonb_build_object('direct_import_resolution', 'cancelled'),
            updated_at = now()
        where id = row_item.id;
        continue;
      end if;

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
        perform pg_advisory_xact_lock(hashtextextended('receivable-import-source:' || source_key, 0));
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
          select * into source_customer
          from public.customers
          where historical_receivable_import_key = source_key;

          if source_customer.id is not null and coalesce(source_customer.active, false) and source_customer.status = 'active' then
            target_customer_id := source_customer.id;
            row_reused_customer := true;
          elsif source_customer.id is not null then
            update public.import_rows
            set assignment_status = 'unassigned',
                apply_status = 'pending',
                apply_error = 'El cliente operativo creado previamente para esta fila no está activo.',
                audit_metadata = audit_metadata || jsonb_build_object('direct_import_resolution', 'review_required'),
                updated_at = now()
            where id = row_item.id;
            review_required_rows := review_required_rows + 1;
            continue;
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
              source,
              historical_receivable_import_key,
              imported_from_receivable_row_id
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
              'historical_receivable_import',
              source_key,
              row_item.id
            )
            returning id into target_customer_id;
            row_created_customer := true;

            insert into public.audit_logs (user_id, actor_role, table_name, record_id, action, new_data)
            values (
              auth.uid(),
              public.current_actor_role(),
              'customers',
              target_customer_id,
              'historical_receivable_import.customer_created',
              jsonb_build_object(
                'batch_id', target_batch_id,
                'row_id', row_item.id,
                'source', 'historical_receivable_import',
                'user_id', null
              )
            );
          end if;
        end if;
      end if;

      dedupe_key := public.receivable_import_dedupe_key(
        target_customer_id,
        normalized_invoice,
        issue_date_value,
        original_amount_value,
        source_key,
        row_item.row_number
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
-- Portal registration only creates/updates the public.users profile. It never
-- searches, creates, or links public.customers. Customer linking is a separate,
-- explicit administrative operation.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  customer_full_name text := nullif(trim(coalesce(new.raw_user_meta_data->>'full_name', '')), '');
  raw_username text := lower(trim(coalesce(new.raw_user_meta_data->>'username', '')));
  customer_username text := null;
  customer_phone text := regexp_replace(coalesce(new.raw_user_meta_data->>'phone', ''), '[^0-9]', '', 'g');
  customer_email text := lower(trim(coalesce(new.email, '')));
begin
  if raw_username ~ '^[a-z0-9._-]{3,30}$'
    and raw_username not in ('admin', 'soporte', 'root', 'carzone', 'mayorista', 'facturas', 'pedidos')
  then
    customer_username := raw_username;
  end if;

  if customer_full_name is null then
    customer_full_name := customer_email;
  end if;

  if nullif(customer_phone, '') is null then
    customer_phone := '00000000';
  end if;

  insert into public.users (id, role_id, full_name, username, email, phone, active)
  values (
    new.id,
    (select roles.id from public.roles where roles.name = 'cliente' limit 1),
    customer_full_name,
    customer_username,
    customer_email,
    customer_phone,
    true
  )
  on conflict (id) do update
  set
    full_name = excluded.full_name,
    username = coalesce(public.users.username, excluded.username),
    email = excluded.email,
    phone = excluded.phone,
    updated_at = now();

  return new;
end;
$$;

revoke all on function public.normalize_receivable_import_email(text) from public;
revoke all on function public.normalize_receivable_import_tax_id(text) from public;
revoke all on function public.normalize_receivable_import_phone(text) from public;
revoke all on function public.receivable_import_dedupe_key(uuid, text, date, numeric) from public;
revoke all on function public.receivable_import_customer_source_key(jsonb, integer) from public;
revoke all on function public.is_generic_receivable_import_reference(text) from public;
revoke all on function public.receivable_import_dedupe_key(uuid, text, date, numeric, text, integer) from public;
revoke all on function public.resolve_receivable_import_customer(jsonb) from public;
revoke all on function public.preview_historical_accounts_receivable_import(uuid) from public;
revoke all on function public.confirm_and_apply_receivable_import_batch(uuid) from public;

grant execute on function public.preview_historical_accounts_receivable_import(uuid) to authenticated;
grant execute on function public.confirm_and_apply_receivable_import_batch(uuid) to authenticated;
grant execute on function public.handle_new_user() to service_role;
