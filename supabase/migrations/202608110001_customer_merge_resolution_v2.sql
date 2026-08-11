-- Customer Merge Resolution V2.
-- Adds two explicit, server-validated resolutions without weakening the normal merge contract:
--   1. over-limit credit -> disable the canonical account and set its limit to zero;
--   2. inactive pending secondary without Auth/economy -> archive it as the merged alias.

create or replace function public.customer_merge_secondary_economy_v2(p_customer_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with source_orders as (
    select id from public.orders where customer_id = p_customer_id
  ), source_entries as (
    select distinct line.journal_entry_id
    from public.journal_entry_lines line
    where line.customer_id = p_customer_id
  ), metrics as (
    select
      (select count(*) from source_orders)::integer as orders,
      (select count(*) from public.invoices where customer_id = p_customer_id)::integer as invoices,
      (select count(*) from public.payments where customer_id = p_customer_id)::integer as payments,
      (select count(*) from public.accounts_receivable where customer_id = p_customer_id)::integer as receivables,
      (select count(*) from public.accounts_receivable_payments where customer_id = p_customer_id)::integer as receivable_payments,
      (select count(*) from public.customer_credit_accounts where customer_id = p_customer_id)::integer as credit_accounts,
      (select count(*) from public.wholesale_codes where customer_id = p_customer_id)::integer as wholesale_codes,
      (select count(*) from public.checkout_requests_v4 where customer_id = p_customer_id)::integer as checkout_requests,
      (select count(*) from public.pos_sale_drafts where customer_id = p_customer_id and status = 'active')::integer as active_pos_drafts,
      (select count(*) from source_entries)::integer as journal_entries,
      (select count(*) from public.journal_entry_lines where customer_id = p_customer_id)::integer as journal_lines,
      (select count(*) from public.inventory_reservations where order_id in (select id from source_orders))::integer as reservations,
      (select count(*) from public.inventory_movements where reference_id in (select id from source_orders))::integer as inventory_movements,
      (select count(*) from public.crm_notes where customer_id = p_customer_id)::integer as crm_notes,
      (select count(*) from public.crm_followups where customer_id = p_customer_id)::integer as crm_followups
  )
  select jsonb_build_object(
    'orders', orders,
    'invoices', invoices,
    'payments', payments,
    'receivables', receivables,
    'receivablePayments', receivable_payments,
    'creditAccounts', credit_accounts,
    'wholesaleCodes', wholesale_codes,
    'checkoutRequests', checkout_requests,
    'activePosDrafts', active_pos_drafts,
    'journalEntries', journal_entries,
    'journalLines', journal_lines,
    'reservations', reservations,
    'inventoryMovements', inventory_movements,
    'crmNotes', crm_notes,
    'crmFollowups', crm_followups,
    'blockingCount', orders + invoices + payments + receivables + receivable_payments
      + credit_accounts + wholesale_codes + checkout_requests + active_pos_drafts
      + journal_entries + journal_lines + reservations + inventory_movements
  )
  from metrics;
$$;

alter function public.preview_customer_merge_v1(uuid, uuid)
  rename to preview_customer_merge_v1_base_resolution_v2;

create or replace function public.preview_customer_merge_v1(
  p_primary_customer_id uuid,
  p_secondary_customer_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  base_preview jsonb;
  preview_core jsonb;
  warnings jsonb;
  blockers jsonb;
  decisions jsonb;
  primary_root uuid;
  secondary_root uuid;
  primary_customer public.customers%rowtype;
  secondary_customer public.customers%rowtype;
  primary_credit public.customer_credit_accounts%rowtype;
  secondary_credit public.customer_credit_accounts%rowtype;
  pending_economy jsonb := '{}'::jsonb;
  pending_candidate boolean := false;
  pending_eligible boolean := false;
  target_open_balance numeric(14,2) := 0;
  source_open_balance numeric(14,2) := 0;
  consolidated_open_balance numeric(14,2) := 0;
  reference_limit numeric(14,2);
  over_limit_required boolean := false;
  credit_exposure jsonb;
begin
  base_preview := public.preview_customer_merge_v1_base_resolution_v2(
    p_primary_customer_id,
    p_secondary_customer_id
  );
  primary_root := (base_preview->>'primaryCustomerId')::uuid;
  secondary_root := (base_preview->>'secondaryCustomerId')::uuid;
  select * into primary_customer from public.customers where id = primary_root;
  select * into secondary_customer from public.customers where id = secondary_root;
  select * into primary_credit from public.customer_credit_accounts where customer_id = primary_root;
  select * into secondary_credit from public.customer_credit_accounts where customer_id = secondary_root;

  warnings := coalesce(base_preview->'warnings', '[]'::jsonb);
  blockers := coalesce(base_preview->'blockers', '[]'::jsonb);
  decisions := coalesce(base_preview->'requiredDecisions', '[]'::jsonb);

  pending_candidate := secondary_customer.status = 'pending_account' and not secondary_customer.active;
  if pending_candidate then
    pending_economy := public.customer_merge_secondary_economy_v2(secondary_root);
    pending_eligible := secondary_customer.merged_into_customer_id is null
      and secondary_customer.user_id is null
      and coalesce((pending_economy->>'blockingCount')::integer, 0) = 0;
    if secondary_customer.user_id is not null then
      blockers := blockers || '"CUSTOMER_MERGE_PENDING_SECONDARY_HAS_AUTH"'::jsonb;
    end if;
    if coalesce((pending_economy->>'blockingCount')::integer, 0) > 0 then
      blockers := blockers || '"CUSTOMER_MERGE_PENDING_SECONDARY_HAS_ECONOMY"'::jsonb;
    end if;
    if pending_eligible then
      warnings := warnings || '"CUSTOMER_MERGE_PENDING_SECONDARY_REQUIRES_ARCHIVE"'::jsonb;
      decisions := decisions || '"pendingSecondaryResolution"'::jsonb;
    end if;
  elsif not secondary_customer.active or secondary_customer.status <> 'active' then
    blockers := blockers || '"CUSTOMER_MERGE_SECONDARY_NOT_ACTIVE_ROOT"'::jsonb;
  end if;

  select coalesce(sum(receivable.balance_due), 0)
    into target_open_balance
  from public.accounts_receivable receivable
  where receivable.customer_id in (select customer_id from public.get_customer_family_ids_v1(primary_root))
    and receivable.status in ('open', 'partial', 'overdue');
  select coalesce(sum(receivable.balance_due), 0)
    into source_open_balance
  from public.accounts_receivable receivable
  where receivable.customer_id in (select customer_id from public.get_customer_family_ids_v1(secondary_root))
    and receivable.status in ('open', 'partial', 'overdue');
  consolidated_open_balance := round(target_open_balance + source_open_balance, 2);

  if primary_credit.id is not null then
    reference_limit := primary_credit.credit_limit;
  elsif secondary_credit.id is not null then
    reference_limit := secondary_credit.credit_limit;
  end if;
  over_limit_required :=
    (primary_credit.id is not null and primary_credit.is_credit_enabled and primary_credit.status = 'active'
      and consolidated_open_balance > primary_credit.credit_limit)
    or (secondary_credit.id is not null and secondary_credit.is_credit_enabled and secondary_credit.status = 'active'
      and consolidated_open_balance > secondary_credit.credit_limit);

  credit_exposure := jsonb_build_object(
    'targetOpenBalance', round(target_open_balance, 2),
    'sourceOpenBalance', round(source_open_balance, 2),
    'consolidatedOpenBalance', consolidated_open_balance,
    'currentCreditLimit', reference_limit,
    'overexposure', case when reference_limit is null then 0 else greatest(round(consolidated_open_balance - reference_limit, 2), 0) end,
    'enabled', case when primary_credit.id is not null then primary_credit.is_credit_enabled else secondary_credit.is_credit_enabled end,
    'status', case when primary_credit.id is not null then primary_credit.status else secondary_credit.status end,
    'termsDays', case when primary_credit.id is not null then primary_credit.terms_days else secondary_credit.terms_days end,
    'canonicalCreditAccountId', coalesce(primary_credit.id, secondary_credit.id),
    'resolutionRequired', over_limit_required,
    'requiredResolution', case when over_limit_required then 'DISABLE_AND_ZERO_LIMIT' end
  );
  if over_limit_required then
    warnings := warnings || '"CUSTOMER_MERGE_CREDIT_EXPOSURE_EXCEEDS_LIMIT"'::jsonb;
    decisions := decisions || '"creditOverLimitResolution"'::jsonb;
  end if;

  preview_core := (base_preview - 'allowed' - 'confidence' - 'previewHash')
    || jsonb_build_object(
      'warnings', warnings,
      'blockers', blockers,
      'requiredDecisions', decisions,
      'creditExposure', credit_exposure,
      'pendingSecondary', jsonb_build_object(
        'candidate', pending_candidate,
        'eligible', pending_eligible,
        'status', secondary_customer.status,
        'active', secondary_customer.active,
        'userId', secondary_customer.user_id,
        'economy', pending_economy
      ),
      'resolutionContract', jsonb_build_object(
        'version', 2,
        'creditOverLimitResolution', 'DISABLE_AND_ZERO_LIMIT',
        'pendingSecondaryResolution', 'ARCHIVE_PENDING_SECONDARY_AS_MERGED'
      )
    );
  return preview_core || jsonb_build_object(
    'allowed', jsonb_array_length(blockers) = 0,
    'confidence', base_preview->>'confidence',
    'previewHash', public.customer_merge_sha256_v1(preview_core)
  );
end;
$$;

create or replace function public.merge_customers_v1(
  p_request_key text,
  p_primary_customer_id uuid,
  p_secondary_customer_id uuid,
  p_expected_primary_commercial_version integer,
  p_expected_secondary_commercial_version integer,
  p_preview_hash text,
  p_identity_decisions jsonb,
  p_credit_decision jsonb,
  p_commercial_decision jsonb,
  p_reason text,
  p_source text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
#variable_conflict use_variable
declare
  actor_id uuid := auth.uid(); actor_role text := public.current_actor_role(); flag_enabled boolean;
  primary_root uuid; secondary_root uuid; p public.customers%rowtype; s public.customers%rowtype;
  existing_op public.customer_merge_operations%rowtype; op_id uuid; payload jsonb; payload_hash text;
  preview jsonb; counts_before jsonb; counts_after jsonb; totals_before jsonb; totals_after jsonb;
  fiscal_before jsonb; fiscal_after jsonb; accounting_before jsonb; accounting_after jsonb;
  family_secondary uuid[]; field_row jsonb; field_name text; field_state text; chosen_source text;
  chosen_business text; chosen_company text; chosen_contact text; chosen_email text; chosen_phone text; chosen_tax text; chosen_address text; chosen_city text;
  p_credit public.customer_credit_accounts%rowtype; s_credit public.customer_credit_accounts%rowtype;
  canonical_credit public.customer_credit_accounts%rowtype;
  credit_source text; commercial_source text; result jsonb; error_code text;
  pending_secondary boolean := false; pending_economy jsonb := '{}'::jsonb;
  credit_resolution_required boolean := false;
  credit_resolution text; pending_resolution text;
begin
  if actor_id is null or actor_role not in ('technical_owner','business_owner','admin') or not public.has_permission('customers:merge') then
    raise exception using errcode = '42501', message = 'CUSTOMER_MERGE_FORBIDDEN';
  end if;
  select enabled into flag_enabled from public.customer_feature_flags where key = 'customer_merge_execution_v1';
  if not coalesce(flag_enabled,false) then raise exception using errcode = '55000', message = 'CUSTOMER_MERGE_EXECUTION_DISABLED'; end if;
  if nullif(trim(p_request_key),'') is null or char_length(trim(p_request_key)) not between 12 and 200 then raise exception using errcode='22023', message='CUSTOMER_MERGE_INVALID_REQUEST_KEY'; end if;
  if p_primary_customer_id is null or p_secondary_customer_id is null or p_primary_customer_id = p_secondary_customer_id then raise exception using errcode='22023', message='CUSTOMER_MERGE_DISTINCT_CUSTOMERS_REQUIRED'; end if;
  if p_preview_hash !~ '^[0-9a-f]{64}$' then raise exception using errcode='22023', message='CUSTOMER_MERGE_INVALID_PREVIEW_HASH'; end if;
  if jsonb_typeof(coalesce(p_identity_decisions,'{}'::jsonb)) <> 'object' or jsonb_typeof(coalesce(p_credit_decision,'{}'::jsonb)) <> 'object' or jsonb_typeof(coalesce(p_commercial_decision,'{}'::jsonb)) <> 'object' then raise exception using errcode='22023', message='CUSTOMER_MERGE_INVALID_DECISIONS'; end if;
  if char_length(trim(coalesce(p_reason,''))) not between 10 and 1000 then raise exception using errcode='22023', message='CUSTOMER_MERGE_REASON_REQUIRED'; end if;
  if p_source not in ('crm','customers','receivables','pos','support','controlled_production') then raise exception using errcode='22023', message='CUSTOMER_MERGE_INVALID_SOURCE'; end if;

  payload := jsonb_build_object(
    'primaryCustomerId',p_primary_customer_id,'secondaryCustomerId',p_secondary_customer_id,
    'expectedPrimaryCommercialVersion',p_expected_primary_commercial_version,'expectedSecondaryCommercialVersion',p_expected_secondary_commercial_version,
    'previewHash',p_preview_hash,'identityDecisions',coalesce(p_identity_decisions,'{}'::jsonb),
    'creditDecision',coalesce(p_credit_decision,'{}'::jsonb),'commercialDecision',coalesce(p_commercial_decision,'{}'::jsonb),
    'reason',trim(p_reason),'source',p_source
  );
  payload_hash := public.customer_merge_sha256_v1(payload);
  perform pg_advisory_xact_lock(hashtextextended('customer-merge-request:' || trim(p_request_key),0));
  select * into existing_op from public.customer_merge_operations where request_key = trim(p_request_key);
  if existing_op.id is not null then
    if existing_op.payload_hash <> payload_hash then raise exception using errcode='23505', message='CUSTOMER_MERGE_REQUEST_KEY_PAYLOAD_MISMATCH'; end if;
    if existing_op.status in ('completed','failed') then return coalesce(existing_op.result,'{}'::jsonb) || jsonb_build_object('idempotentReplay',true,'operationId',existing_op.id,'status',existing_op.status); end if;
    raise exception using errcode='55000', message='CUSTOMER_MERGE_REQUEST_IN_PROGRESS';
  end if;

  primary_root := public.resolve_customer_root_v1(p_primary_customer_id);
  secondary_root := public.resolve_customer_root_v1(p_secondary_customer_id);
  if primary_root = secondary_root then raise exception using errcode='22023', message='CUSTOMER_MERGE_ALREADY_SAME_FAMILY'; end if;
  for field_name in select value from unnest(array[primary_root::text,secondary_root::text]) value order by value loop
    perform pg_advisory_xact_lock(hashtextextended('customer-root:' || field_name,0));
  end loop;
  perform 1 from public.customers where id in (primary_root,secondary_root) order by id for update;
  select * into p from public.customers where id=primary_root;
  select * into s from public.customers where id=secondary_root;
  if not p.active or p.status <> 'active' or p.merged_into_customer_id is not null then raise exception using errcode='23514', message='CUSTOMER_MERGE_PRIMARY_NOT_ACTIVE_ROOT'; end if;
  pending_secondary := s.status = 'pending_account' and not s.active and s.merged_into_customer_id is null;
  if not pending_secondary and (not s.active or s.status <> 'active' or s.merged_into_customer_id is not null) then raise exception using errcode='23514', message='CUSTOMER_MERGE_SECONDARY_NOT_ACTIVE_ROOT'; end if;

  select * into p_credit from public.customer_credit_accounts where customer_id=primary_root for update;
  select * into s_credit from public.customer_credit_accounts where customer_id=secondary_root for update;
  perform 1 from public.accounts_receivable
    where customer_id in (select customer_id from public.get_customer_family_ids_v1(primary_root) union select customer_id from public.get_customer_family_ids_v1(secondary_root))
    order by id for update;
  perform 1 from public.accounts_receivable_payments
    where customer_id in (select customer_id from public.get_customer_family_ids_v1(primary_root) union select customer_id from public.get_customer_family_ids_v1(secondary_root))
    order by id for update;

  preview := public.preview_customer_merge_v1(primary_root,secondary_root);
  if p.commercial_version <> p_expected_primary_commercial_version or s.commercial_version <> p_expected_secondary_commercial_version then raise exception using errcode='40001', message='CUSTOMER_MERGE_COMMERCIAL_VERSION_CONFLICT'; end if;
  if preview->>'previewHash' <> p_preview_hash then raise exception using errcode='40001', message='CUSTOMER_MERGE_PREVIEW_STALE'; end if;
  if jsonb_array_length(preview->'blockers') > 0 then raise exception using errcode='55000', message=preview->'blockers'->>0; end if;
  if p.user_id is not null and s.user_id is not null and p.user_id <> s.user_id then raise exception using errcode='23514', message='CUSTOMER_MERGE_TWO_PORTAL_ACCOUNTS'; end if;

  pending_resolution := coalesce(p_commercial_decision->>'pendingSecondaryResolution', p_commercial_decision->>'pending_secondary_resolution');
  if pending_secondary then
    pending_economy := public.customer_merge_secondary_economy_v2(secondary_root);
    if s.user_id is not null then raise exception using errcode='23514', message='CUSTOMER_MERGE_PENDING_SECONDARY_HAS_AUTH'; end if;
    if coalesce((pending_economy->>'blockingCount')::integer, 0) <> 0 then raise exception using errcode='23514', message='CUSTOMER_MERGE_PENDING_SECONDARY_HAS_ECONOMY'; end if;
    if pending_resolution is distinct from 'ARCHIVE_PENDING_SECONDARY_AS_MERGED' then raise exception using errcode='22023', message='CUSTOMER_MERGE_PENDING_SECONDARY_DECISION_REQUIRED'; end if;
  elsif pending_resolution is not null then
    raise exception using errcode='22023', message='CUSTOMER_MERGE_PENDING_SECONDARY_DECISION_NOT_APPLICABLE';
  end if;

  credit_resolution_required := coalesce((preview->'creditExposure'->>'resolutionRequired')::boolean, false);
  credit_resolution := coalesce(p_credit_decision->>'overLimitResolution', p_credit_decision->>'over_limit_resolution');
  if credit_resolution_required and credit_resolution is distinct from 'DISABLE_AND_ZERO_LIMIT' then
    raise exception using errcode='22023', message='CUSTOMER_MERGE_CREDIT_OVER_LIMIT_DECISION_REQUIRED';
  elsif not credit_resolution_required and credit_resolution is not null then
    raise exception using errcode='22023', message='CUSTOMER_MERGE_CREDIT_OVER_LIMIT_DECISION_NOT_APPLICABLE';
  end if;

  for field_row in select value from jsonb_array_elements(preview->'identity') loop
    field_name := field_row->>'field'; field_state := field_row->>'state';
    if field_state = 'conflict' then
      chosen_source := coalesce(p_identity_decisions->field_name->>'primaryValueSource',p_identity_decisions->field_name->>'primary_value_source');
      if chosen_source not in ('primary','secondary') then raise exception using errcode='22023', message='CUSTOMER_MERGE_IDENTITY_DECISION_REQUIRED:'||field_name; end if;
      if field_name='tax_id' and not coalesce((p_identity_decisions->field_name->>'preserveOtherAsHistorical')::boolean,(p_identity_decisions->field_name->>'preserve_other_as_historical')::boolean,false) then raise exception using errcode='22023', message='CUSTOMER_MERGE_TAX_ID_DECISION_REQUIRED'; end if;
    end if;
  end loop;

  counts_before := public.customer_merge_counts_v1(primary_root,secondary_root);
  totals_before := public.customer_merge_financial_totals_v1(primary_root,secondary_root);
  fiscal_before := public.customer_merge_fiscal_hashes_v1(primary_root,secondary_root);
  accounting_before := public.customer_merge_accounting_hashes_v1(primary_root,secondary_root);
  select array_agg(customer_id order by customer_id) into family_secondary from public.get_customer_family_ids_v1(secondary_root);

  insert into public.customer_merge_operations(
    request_key,primary_customer_id,secondary_customer_id,primary_root_customer_id,secondary_root_customer_id,
    expected_primary_commercial_version,expected_secondary_commercial_version,preview_hash,payload_hash,source,reason,
    identity_decisions,credit_decision,commercial_decision,relation_plan,counts_before,financial_totals_before,
    fiscal_hashes_before,accounting_hashes_before,status,requested_by,executed_by,executed_role,started_at,merge_snapshot
  ) values (
    trim(p_request_key),p_primary_customer_id,p_secondary_customer_id,primary_root,secondary_root,
    p_expected_primary_commercial_version,p_expected_secondary_commercial_version,p_preview_hash,payload_hash,p_source,trim(p_reason),
    coalesce(p_identity_decisions,'{}'),coalesce(p_credit_decision,'{}'),coalesce(p_commercial_decision,'{}'),preview->'relationPlan',counts_before,totals_before,
    fiscal_before,accounting_before,'processing',actor_id,actor_id,actor_role,now(),jsonb_build_object(
      'primary',to_jsonb(p),'secondary',to_jsonb(s),'secondaryFamily',to_jsonb(family_secondary),
      'resolutionV2',jsonb_build_object('creditExposure',preview->'creditExposure','pendingSecondary',preview->'pendingSecondary','contract',preview->'resolutionContract')
    )
  ) returning id into op_id;

  begin
    perform set_config('app.customer_merge_operation',op_id::text,true);
    chosen_business := case when p.business_name is null then s.business_name when s.business_name is null or public.normalize_customer_name_v1(p.business_name)=public.normalize_customer_name_v1(s.business_name) then p.business_name when coalesce(p_identity_decisions->'business_name'->>'primaryValueSource',p_identity_decisions->'business_name'->>'primary_value_source')='secondary' then s.business_name else p.business_name end;
    chosen_company := case when p.company_name is null then s.company_name when s.company_name is null or public.normalize_customer_name_v1(p.company_name)=public.normalize_customer_name_v1(s.company_name) then p.company_name when coalesce(p_identity_decisions->'company_name'->>'primaryValueSource',p_identity_decisions->'company_name'->>'primary_value_source')='secondary' then s.company_name else p.company_name end;
    chosen_contact := case when p.contact_name is null then s.contact_name when s.contact_name is null or public.normalize_customer_name_v1(p.contact_name)=public.normalize_customer_name_v1(s.contact_name) then p.contact_name when coalesce(p_identity_decisions->'contact_name'->>'primaryValueSource',p_identity_decisions->'contact_name'->>'primary_value_source')='secondary' then s.contact_name else p.contact_name end;
    chosen_email := case when p.email is null then s.email when s.email is null or public.normalize_customer_email_v1(p.email)=public.normalize_customer_email_v1(s.email) then p.email when coalesce(p_identity_decisions->'email'->>'primaryValueSource',p_identity_decisions->'email'->>'primary_value_source')='secondary' then s.email else p.email end;
    chosen_phone := case when p.phone is null then s.phone when s.phone is null or public.normalize_customer_phone_hn_v1(p.phone)=public.normalize_customer_phone_hn_v1(s.phone) then p.phone when coalesce(p_identity_decisions->'phone'->>'primaryValueSource',p_identity_decisions->'phone'->>'primary_value_source')='secondary' then s.phone else p.phone end;
    chosen_tax := case when p.tax_id is null then s.tax_id when s.tax_id is null or public.normalize_customer_tax_id_hn_v1(p.tax_id)=public.normalize_customer_tax_id_hn_v1(s.tax_id) then p.tax_id when coalesce(p_identity_decisions->'tax_id'->>'primaryValueSource',p_identity_decisions->'tax_id'->>'primary_value_source')='secondary' then s.tax_id else p.tax_id end;
    chosen_address := case when p.address is null then s.address when s.address is null or public.normalize_customer_address_v1(p.address)=public.normalize_customer_address_v1(s.address) then p.address when coalesce(p_identity_decisions->'address'->>'primaryValueSource',p_identity_decisions->'address'->>'primary_value_source')='secondary' then s.address else p.address end;
    chosen_city := case when p.city is null then s.city when s.city is null or public.normalize_customer_address_v1(p.city)=public.normalize_customer_address_v1(s.city) then p.city when coalesce(p_identity_decisions->'city'->>'primaryValueSource',p_identity_decisions->'city'->>'primary_value_source')='secondary' then s.city else p.city end;

    insert into public.customer_identity_values(customer_id,identity_type,raw_value,normalized_value,is_primary,status,source_customer_id,source_type,verified_at,verified_by,created_by,metadata)
    select primary_root,identity_type,raw_value,public.customer_identity_normalized_value_v1(identity_type,raw_value),false,
      case when source_id=secondary_root then 'historical' else 'active' end,source_id,'merge',now(),actor_id,actor_id,jsonb_build_object('mergeOperationId',op_id)
    from (values
      ('business_name',p.business_name,primary_root),('business_name',s.business_name,secondary_root),('company_name',p.company_name,primary_root),('company_name',s.company_name,secondary_root),
      ('contact_name',p.contact_name,primary_root),('contact_name',s.contact_name,secondary_root),('email',p.email,primary_root),('email',s.email,secondary_root),
      ('phone',p.phone,primary_root),('phone',s.phone,secondary_root),('tax_id',p.tax_id,primary_root),('tax_id',s.tax_id,secondary_root),
      ('address',p.address,primary_root),('address',s.address,secondary_root),('city',p.city,primary_root),('city',s.city,secondary_root)
    ) identity(identity_type,raw_value,source_id) where raw_value is not null on conflict do nothing;

    update public.customer_identity_values set is_primary=false where customer_id=primary_root and is_primary;
    update public.customer_identity_values civ set is_primary=true,status='active'
    from (values ('business_name',chosen_business),('company_name',chosen_company),('contact_name',chosen_contact),('email',chosen_email),('phone',chosen_phone),('tax_id',chosen_tax),('address',chosen_address),('city',chosen_city)) selected(identity_type,raw_value)
    where civ.customer_id=primary_root and civ.identity_type=selected.identity_type and civ.normalized_value=public.customer_identity_normalized_value_v1(selected.identity_type,selected.raw_value);

    if p_credit.id is not null and s_credit.id is not null then
      credit_source := coalesce(p_credit_decision->>'selectedSource',p_credit_decision->>'selected_source');
      if credit_source not in ('primary','secondary') then raise exception using errcode='22023', message='CUSTOMER_MERGE_CREDIT_CONFLICT'; end if;
      if credit_source='secondary' then
        update public.customer_credit_accounts set is_credit_enabled=s_credit.is_credit_enabled,credit_limit=s_credit.credit_limit,terms_days=s_credit.terms_days,status=s_credit.status,updated_at=now() where id=p_credit.id;
      end if;
      update public.customer_credit_accounts set is_credit_enabled=false,status='suspended',suspended_at=coalesce(suspended_at,now()),suspended_by=coalesce(suspended_by,actor_id),updated_at=now() where id=s_credit.id;
    elsif p_credit.id is null and s_credit.id is not null then
      update public.customer_credit_accounts set customer_id=primary_root,updated_at=now() where id=s_credit.id;
    end if;
    if credit_resolution_required then
      update public.customer_credit_accounts
      set is_credit_enabled=false, status='suspended', credit_limit=0,
          suspended_at=coalesce(suspended_at,now()), suspended_by=coalesce(suspended_by,actor_id), updated_at=now()
      where customer_id=primary_root
      returning * into canonical_credit;
      if canonical_credit.id is null then raise exception using errcode='23514', message='CUSTOMER_MERGE_CREDIT_ACCOUNT_REQUIRED'; end if;
    elsif exists(select 1 from public.customer_credit_accounts ca where ca.customer_id=primary_root and ca.is_credit_enabled and ca.status='active' and ca.credit_limit < coalesce((totals_before->>'receivableOpenBalance')::numeric,0)) then
      raise exception using errcode='23514', message='CUSTOMER_MERGE_CREDIT_LIMIT_BELOW_OPEN_BALANCE';
    end if;

    if pending_secondary then commercial_source := 'primary';
    elsif not p.is_wholesale and s.is_wholesale then commercial_source := 'secondary';
    elsif p.is_wholesale and s.is_wholesale and (p.wholesale_status,p.wholesale_customer_type) is distinct from (s.wholesale_status,s.wholesale_customer_type) then
      commercial_source := coalesce(p_commercial_decision->>'selectedSource',p_commercial_decision->>'selected_source');
      if commercial_source not in ('primary','secondary') then raise exception using errcode='22023', message='CUSTOMER_MERGE_WHOLESALE_CONFLICT'; end if;
    else commercial_source := 'primary'; end if;

    update public.crm_notes set original_customer_id=coalesce(original_customer_id,customer_id),customer_id=primary_root where customer_id=any(family_secondary);
    update public.crm_followups set original_customer_id=coalesce(original_customer_id,customer_id),customer_id=primary_root where customer_id=any(family_secondary);
    update public.accounts_receivable set customer_id=primary_root where customer_id=any(family_secondary);
    update public.accounts_receivable_payments set customer_id=primary_root where customer_id=any(family_secondary);

    if p.user_id is null and s.user_id is not null then update public.customers set user_id=null where id=secondary_root; end if;
    if p.user_id is not null and p.user_id=s.user_id then update public.customers set user_id=null where id=secondary_root; end if;

    update public.customers set
      user_id=coalesce(p.user_id,s.user_id),business_name=chosen_business,company_name=chosen_company,contact_name=chosen_contact,
      email=chosen_email,phone=chosen_phone,tax_id=chosen_tax,address=chosen_address,city=chosen_city,
      is_wholesale=case when commercial_source='secondary' then s.is_wholesale else p.is_wholesale end,
      wholesale_status=case when commercial_source='secondary' then s.wholesale_status else p.wholesale_status end,
      wholesale_requested_at=case when commercial_source='secondary' then s.wholesale_requested_at else p.wholesale_requested_at end,
      wholesale_request_source=case when commercial_source='secondary' then s.wholesale_request_source else p.wholesale_request_source end,
      wholesale_approved_at=case when commercial_source='secondary' then s.wholesale_approved_at else p.wholesale_approved_at end,
      wholesale_approved_notice_seen=case when commercial_source='secondary' then s.wholesale_approved_notice_seen else p.wholesale_approved_notice_seen end,
      wholesale_customer_type=case when commercial_source='secondary' then s.wholesale_customer_type else p.wholesale_customer_type end,
      wholesale_first_purchase_completed=case when commercial_source='secondary' then s.wholesale_first_purchase_completed else p.wholesale_first_purchase_completed end,
      wholesale_first_purchase_completed_at=case when commercial_source='secondary' then s.wholesale_first_purchase_completed_at else p.wholesale_first_purchase_completed_at end,
      commercial_version=p.commercial_version+1,updated_at=now()
    where id=primary_root;

    update public.customers set merged_into_customer_id=primary_root,merged_at=now(),merged_by=actor_id,merge_operation_id=op_id,merge_reason=trim(p_reason),active=false,status='merged',user_id=null,is_wholesale=false,wholesale_status='none',wholesale_approved_at=null,commercial_version=commercial_version+1,updated_at=now()
    where id=any(family_secondary);

    counts_after := public.customer_merge_counts_v1(primary_root,secondary_root);
    totals_after := public.customer_merge_financial_totals_v1(primary_root,secondary_root);
    fiscal_after := public.customer_merge_fiscal_hashes_v1(primary_root,secondary_root);
    accounting_after := public.customer_merge_accounting_hashes_v1(primary_root,secondary_root);
    if counts_before is distinct from counts_after or totals_before is distinct from totals_after or fiscal_before is distinct from fiscal_after or accounting_before is distinct from accounting_after then
      raise exception using errcode='23514', message='CUSTOMER_MERGE_INVARIANT_FAILED';
    end if;

    result := jsonb_build_object(
      'ok',true,'status','completed','operationId',op_id,'primaryCustomerId',primary_root,'secondaryCustomerId',secondary_root,
      'idempotentReplay',false,'counts',counts_after,'financialTotals',totals_after,'fiscalHashes',fiscal_after,'accountingHashes',accounting_after,
      'resolutionsApplied',jsonb_strip_nulls(jsonb_build_object(
        'creditOverLimit',case when credit_resolution_required then credit_resolution end,
        'pendingSecondary',case when pending_secondary then pending_resolution end
      ))
    );
    update public.customer_merge_operations set counts_after=counts_after,financial_totals_after=totals_after,fiscal_hashes_after=fiscal_after,accounting_hashes_after=accounting_after,status='completed',result=result,completed_at=now() where id=op_id;
    perform public.write_audit_log('customers',primary_root,'customer.canonical_merge_completed',jsonb_build_object('secondaryCustomerId',secondary_root),jsonb_build_object(
      'operationId',op_id,'requestKey',trim(p_request_key),'source',p_source,'reason',trim(p_reason),
      'creditDecision',coalesce(p_credit_decision,'{}'::jsonb),'commercialDecision',coalesce(p_commercial_decision,'{}'::jsonb),
      'resolutionSnapshot',jsonb_build_object('creditExposure',preview->'creditExposure','pendingSecondary',preview->'pendingSecondary')
    ));
    perform set_config('app.customer_merge_operation','',true);
    return result;
  exception when others then
    error_code := case when sqlerrm ~ '^[A-Z0-9_:-]+$' then split_part(sqlerrm,':',1) else 'CUSTOMER_MERGE_FAILED' end;
    result := jsonb_build_object('ok',false,'status','failed','operationId',op_id,'errorCode',error_code,'message','La unión fue revertida completamente. Revisa la vista previa e intenta nuevamente.','idempotentReplay',false);
    update public.customer_merge_operations set status='failed',error_code=error_code,error_detail_sanitized=left(error_code,1000),result=result,failed_at=now() where id=op_id;
    perform public.write_audit_log('customers',primary_root,'customer.canonical_merge_failed',null,jsonb_build_object('operationId',op_id,'errorCode',error_code,'source',p_source));
    perform set_config('app.customer_merge_operation','',true);
    return result;
  end;
end;
$$;

revoke all on function public.customer_merge_secondary_economy_v2(uuid) from public, anon, authenticated, service_role;
revoke all on function public.preview_customer_merge_v1_base_resolution_v2(uuid,uuid) from public, anon, authenticated, service_role;
revoke all on function public.preview_customer_merge_v1(uuid,uuid) from public, anon;
grant execute on function public.preview_customer_merge_v1(uuid,uuid) to authenticated, service_role;
revoke all on function public.merge_customers_v1(text,uuid,uuid,integer,integer,text,jsonb,jsonb,jsonb,text,text) from public, anon;
grant execute on function public.merge_customers_v1(text,uuid,uuid,integer,integer,text,jsonb,jsonb,jsonb,text,text) to authenticated, service_role;

comment on function public.preview_customer_merge_v1(uuid,uuid) is
  'Customer merge V2 preview. Hashes server snapshots and explicit resolution contracts for over-limit credit and safe pending secondaries.';
comment on function public.merge_customers_v1(text,uuid,uuid,integer,integer,text,jsonb,jsonb,jsonb,text,text) is
  'Customer merge V2 executor. Validates decisions, versions and fresh snapshots under customer, credit and receivable locks; preserves economic invariants.';
