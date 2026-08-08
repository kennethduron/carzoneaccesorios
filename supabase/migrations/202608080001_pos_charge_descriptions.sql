-- Additive, presentation-only POS charge descriptions.
-- Certified economic calculations and accounting mappings remain delegated to
-- save_pos_sale_draft_with_charges_v1 and confirm_pos_sale_v1.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

alter table public.pos_sale_drafts
  add column if not exists additional_charge_description text,
  add column if not exists other_charge_description text;

alter table public.pos_sale_drafts
  add constraint pos_sale_drafts_additional_charge_description_check check (
    additional_charge_description is null
    or (
      char_length(additional_charge_description) between 2 and 120
      and additional_charge_description = trim(additional_charge_description)
      and additional_charge_description !~ '[<>]'
      and additional_charge_description !~ E'[\n\r\t]'
    )
  ),
  add constraint pos_sale_drafts_other_charge_description_check check (
    other_charge_description is null
    or (
      char_length(other_charge_description) between 2 and 120
      and other_charge_description = trim(other_charge_description)
      and other_charge_description !~ '[<>]'
      and other_charge_description !~ E'[\n\r\t]'
    )
  );

comment on column public.pos_sale_drafts.additional_charge_description is
  'Commercial/documentary label for additional_charge. Never used to resolve accounting mappings.';
comment on column public.pos_sale_drafts.other_charge_description is
  'Commercial/documentary label for other_charge. Never used to resolve accounting mappings.';

create or replace function public.build_pos_sale_draft_payload_v1(p_draft_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.build_pos_sale_draft_payload_pre_charges_v1(p_draft_id)
    || jsonb_build_object(
      'additionalCharge', draft.additional_charge,
      'additionalChargeDescription', draft.additional_charge_description,
      'otherChargeDescription', draft.other_charge_description
    )
  from public.pos_sale_drafts draft
  where draft.id = p_draft_id
$$;

revoke all on function public.build_pos_sale_draft_payload_v1(uuid)
  from public, anon, authenticated;

create or replace function public.enforce_pos_charge_description_write_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Existing historical rows stay readable and may receive unrelated updates.
  -- New rows and any write touching a charge/description must satisfy the rule.
  if tg_op = 'INSERT' then
    if new.additional_charge > 0 and new.additional_charge_description is null then
      raise exception using errcode = '22023', message = 'POS_ADDITIONAL_CHARGE_DESCRIPTION_REQUIRED';
    end if;
    if new.other_charge > 0 and new.other_charge_description is null then
      raise exception using errcode = '22023', message = 'POS_OTHER_CHARGE_DESCRIPTION_REQUIRED';
    end if;
    return new;
  end if;
  if (new.additional_charge is distinct from old.additional_charge
      or new.additional_charge_description is distinct from old.additional_charge_description)
    and new.additional_charge > 0 and new.additional_charge_description is null then
    raise exception using errcode = '22023', message = 'POS_ADDITIONAL_CHARGE_DESCRIPTION_REQUIRED';
  end if;
  if (new.other_charge is distinct from old.other_charge
      or new.other_charge_description is distinct from old.other_charge_description)
    and new.other_charge > 0 and new.other_charge_description is null then
    raise exception using errcode = '22023', message = 'POS_OTHER_CHARGE_DESCRIPTION_REQUIRED';
  end if;
  return new;
end;
$$;

drop trigger if exists pos_sale_drafts_require_charge_descriptions
  on public.pos_sale_drafts;
create trigger pos_sale_drafts_require_charge_descriptions
before insert or update on public.pos_sale_drafts
for each row execute function public.enforce_pos_charge_description_write_v1();

revoke all on function public.enforce_pos_charge_description_write_v1()
  from public, anon, authenticated;

create or replace function public.save_pos_sale_draft_with_charge_descriptions_v1(
  p_request_key uuid,
  p_draft_id uuid,
  p_expected_version bigint,
  p_customer_id uuid,
  p_expected_customer_commercial_version integer,
  p_items jsonb,
  p_delivery_mode text default 'store_immediate',
  p_delivery_address text default null,
  p_delivery_notes text default null,
  p_internal_notes text default null,
  p_delivery_charge numeric default 0,
  p_cash_on_delivery_charge numeric default 0,
  p_additional_charge numeric default 0,
  p_other_charge numeric default 0,
  p_additional_charge_description text default null,
  p_other_charge_description text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  additional_value numeric(12,2) := round(coalesce(p_additional_charge, 0), 2);
  other_value numeric(12,2) := round(coalesce(p_other_charge, 0), 2);
  additional_description_value text := nullif(
    regexp_replace(trim(coalesce(p_additional_charge_description, '')), '[[:space:]]+', ' ', 'g'),
    ''
  );
  other_description_value text := nullif(
    regexp_replace(trim(coalesce(p_other_charge_description, '')), '[[:space:]]+', ' ', 'g'),
    ''
  );
  payload_hash text;
  claim record;
  saved jsonb;
  result jsonb;
begin
  if coalesce(p_additional_charge_description, '') ~ '[<>]'
    or coalesce(p_additional_charge_description, '') ~ E'[\n\r\t]'
    or coalesce(p_other_charge_description, '') ~ '[<>]'
    or coalesce(p_other_charge_description, '') ~ E'[\n\r\t]' then
    raise exception using errcode = '22023', message = 'POS_CHARGE_DESCRIPTION_INVALID';
  end if;

  if additional_value = 0 then
    additional_description_value := null;
  end if;
  if other_value = 0 then
    other_description_value := null;
  end if;

  if additional_value > 0 and (
    additional_description_value is null
    or char_length(additional_description_value) not between 2 and 120
  ) then
    raise exception using errcode = '22023', message = 'POS_ADDITIONAL_CHARGE_DESCRIPTION_REQUIRED';
  end if;
  if other_value > 0 and (
    other_description_value is null
    or char_length(other_description_value) not between 2 and 120
  ) then
    raise exception using errcode = '22023', message = 'POS_OTHER_CHARGE_DESCRIPTION_REQUIRED';
  end if;
  payload_hash := encode(extensions.digest(convert_to(jsonb_build_object(
    'draft_id', p_draft_id,
    'expected_version', p_expected_version,
    'customer_id', p_customer_id,
    'customer_version', p_expected_customer_commercial_version,
    'items', p_items,
    'delivery_mode', p_delivery_mode,
    'delivery_address', nullif(trim(coalesce(p_delivery_address, '')), ''),
    'delivery_notes', nullif(trim(coalesce(p_delivery_notes, '')), ''),
    'internal_notes', nullif(trim(coalesce(p_internal_notes, '')), ''),
    'delivery_charge', p_delivery_charge,
    'cod_charge', p_cash_on_delivery_charge,
    'additional_charge', additional_value,
    'additional_charge_description', additional_description_value,
    'other_charge', other_value,
    'other_charge_description', other_description_value
  )::text, 'UTF8'), 'sha256'), 'hex');

  select * into claim from public.claim_pos_idempotency_v1(
    p_request_key,
    'save_pos_sale_draft_with_charge_descriptions_v1',
    payload_hash
  );
  if claim.request_status = 'succeeded' then
    return claim.stored_result || jsonb_build_object('idempotentReplay', true);
  elsif not claim.acquired then
    raise exception using errcode = '55000', message = 'El guardado todavia esta en proceso.';
  end if;

  -- Stage positive-charge labels in the same transaction so the certified
  -- legacy save cannot be used to bypass the new-write guard. Zero-value labels
  -- are cleared after the certified save changes their amount to zero.
  update public.pos_sale_drafts
  set additional_charge_description = case
        when additional_value > 0 then additional_description_value
        else additional_charge_description
      end,
      other_charge_description = case
        when other_value > 0 then other_description_value
        else other_charge_description
      end,
      updated_at = now()
  where id = p_draft_id and status = 'active';
  if not found then
    raise exception using errcode = 'PT409', message = 'El borrador ya no esta activo.';
  end if;

  saved := public.save_pos_sale_draft_with_charges_v1(
    public.pos_child_request_key_v1(p_request_key, 'charge-descriptions-v1'),
    p_draft_id,
    p_expected_version,
    p_customer_id,
    p_expected_customer_commercial_version,
    p_items,
    p_delivery_mode,
    p_delivery_address,
    p_delivery_notes,
    p_internal_notes,
    p_delivery_charge,
    p_cash_on_delivery_charge,
    additional_value,
    other_value
  );

  update public.pos_sale_drafts
  set additional_charge_description = additional_description_value,
      other_charge_description = other_description_value,
      updated_at = now()
  where id = p_draft_id and status = 'active';
  if not found then
    raise exception using errcode = 'PT409', message = 'El borrador ya no esta activo.';
  end if;

  result := public.build_pos_sale_draft_payload_v1(p_draft_id)
    || jsonb_build_object('idempotentReplay', false);
  perform public.write_audit_log(
    'pos_sale_drafts',
    p_draft_id,
    'pos.draft.charge_descriptions_saved',
    null,
    jsonb_build_object(
      'request_key', p_request_key,
      'additional_charge_description', additional_description_value,
      'other_charge_description', other_description_value,
      'accounting_mapping_changed', false
    )
  );
  perform public.complete_pos_idempotency_v1(
    p_request_key,
    'save_pos_sale_draft_with_charge_descriptions_v1',
    payload_hash,
    result
  );
  return result;
end;
$$;

revoke all on function public.save_pos_sale_draft_with_charge_descriptions_v1(
  uuid, uuid, bigint, uuid, integer, jsonb, text, text, text, text,
  numeric, numeric, numeric, numeric, text, text
) from public, anon;
grant execute on function public.save_pos_sale_draft_with_charge_descriptions_v1(
  uuid, uuid, bigint, uuid, integer, jsonb, text, text, text, text,
  numeric, numeric, numeric, numeric, text, text
) to authenticated;

create or replace function public.apply_pos_charge_descriptions_to_document_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_draft_id uuid;
  draft_record public.pos_sale_drafts%rowtype;
begin
  if tg_table_name = 'orders' then
    target_draft_id := new.pos_draft_id;
  else
    select target_order.pos_draft_id into target_draft_id
    from public.orders target_order
    where target_order.id = new.order_id;
  end if;

  if target_draft_id is null or jsonb_array_length(coalesce(new.additional_fees, '[]'::jsonb)) = 0 then
    return new;
  end if;

  select * into draft_record
  from public.pos_sale_drafts
  where id = target_draft_id;
  if draft_record.id is null then
    return new;
  end if;

  if draft_record.additional_charge > 0
    and draft_record.additional_charge_description is null then
    raise exception using errcode = '22023', message = 'POS_ADDITIONAL_CHARGE_DESCRIPTION_REQUIRED';
  end if;
  if draft_record.other_charge > 0
    and draft_record.other_charge_description is null then
    raise exception using errcode = '22023', message = 'POS_OTHER_CHARGE_DESCRIPTION_REQUIRED';
  end if;

  select coalesce(jsonb_agg(
    case lower(trim(fee.value->>'label'))
      when 'cargo adicional' then
        fee.value || jsonb_build_object(
          'label', coalesce(draft_record.additional_charge_description, 'Cargo adicional'),
          'category', 'additional_charge'
        )
      when 'otro cargo' then
        fee.value || jsonb_build_object(
          'label', coalesce(draft_record.other_charge_description, 'Otro cargo'),
          'category', 'other_charge'
        )
      else fee.value
    end
    order by fee.ordinality
  ), '[]'::jsonb)
  into new.additional_fees
  from jsonb_array_elements(coalesce(new.additional_fees, '[]'::jsonb))
    with ordinality as fee(value, ordinality);

  return new;
end;
$$;

drop trigger if exists orders_apply_pos_charge_descriptions_before_insert
  on public.orders;
create trigger orders_apply_pos_charge_descriptions_before_insert
before insert on public.orders
for each row execute function public.apply_pos_charge_descriptions_to_document_v1();

drop trigger if exists invoices_apply_pos_charge_descriptions_before_insert
  on public.invoices;
create trigger invoices_apply_pos_charge_descriptions_before_insert
before insert on public.invoices
for each row execute function public.apply_pos_charge_descriptions_to_document_v1();

revoke all on function public.apply_pos_charge_descriptions_to_document_v1()
  from public, anon, authenticated;

comment on function public.apply_pos_charge_descriptions_to_document_v1() is
  'Decorates POS charge labels before immutable order/invoice snapshots are inserted; it never resolves accounting mappings or changes amounts.';

create or replace function public.confirm_pos_sale_with_charge_descriptions_v1(
  p_draft_id uuid,
  p_request_key uuid,
  p_expected_draft_version bigint,
  p_invoice_date date,
  p_payment_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set timezone = 'America/Tegucigalpa'
as $$
declare
  result jsonb;
  draft_record public.pos_sale_drafts%rowtype;
begin
  result := public.confirm_selectable_pos_sale_v1(
    p_draft_id,
    public.pos_child_request_key_v1(p_request_key, 'charge-descriptions-confirmation-v1'),
    p_expected_draft_version,
    p_invoice_date,
    p_payment_payload
  );

  select * into strict draft_record
  from public.pos_sale_drafts
  where id = p_draft_id;

  if coalesce((result->>'replayed')::boolean, false) = false
    and (draft_record.additional_charge > 0 or draft_record.other_charge > 0) then
    perform public.write_audit_log(
      'pos_sale_drafts',
      p_draft_id,
      'pos.sale.charge_descriptions_attached',
      null,
      jsonb_build_object(
        'order_id', result->>'order_id',
        'invoice_id', result->>'invoice_id',
        'additional_charge_description', draft_record.additional_charge_description,
        'other_charge_description', draft_record.other_charge_description,
        'accounting_mapping_changed', false
      )
    );
  end if;

  return result;
end;
$$;

revoke all on function public.confirm_pos_sale_with_charge_descriptions_v1(
  uuid, uuid, bigint, date, jsonb
) from public, anon, authenticated;
grant execute on function public.confirm_pos_sale_with_charge_descriptions_v1(
  uuid, uuid, bigint, date, jsonb
) to authenticated;

commit;
