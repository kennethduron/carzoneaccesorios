-- Transactional, idempotent canonical merge executor.

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
  credit_source text; commercial_source text; result jsonb; error_code text;
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
  if not s.active or s.status <> 'active' or s.merged_into_customer_id is not null then raise exception using errcode='23514', message='CUSTOMER_MERGE_SECONDARY_NOT_ACTIVE_ROOT'; end if;

  preview := public.preview_customer_merge_v1(primary_root,secondary_root);
  if p.commercial_version <> p_expected_primary_commercial_version or s.commercial_version <> p_expected_secondary_commercial_version then raise exception using errcode='40001', message='CUSTOMER_MERGE_COMMERCIAL_VERSION_CONFLICT'; end if;
  if preview->>'previewHash' <> p_preview_hash then raise exception using errcode='40001', message='CUSTOMER_MERGE_PREVIEW_STALE'; end if;
  if jsonb_array_length(preview->'blockers') > 0 then raise exception using errcode='55000', message=preview->'blockers'->>0; end if;
  if p.user_id is not null and s.user_id is not null and p.user_id <> s.user_id then raise exception using errcode='23514', message='CUSTOMER_MERGE_TWO_PORTAL_ACCOUNTS'; end if;

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
    fiscal_before,accounting_before,'processing',actor_id,actor_id,actor_role,now(),jsonb_build_object('primary',to_jsonb(p),'secondary',to_jsonb(s),'secondaryFamily',to_jsonb(family_secondary))
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

    select * into p_credit from public.customer_credit_accounts where customer_id=primary_root for update;
    select * into s_credit from public.customer_credit_accounts where customer_id=secondary_root for update;
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
    if exists(select 1 from public.customer_credit_accounts ca where ca.customer_id=primary_root and ca.is_credit_enabled and ca.status='active' and ca.credit_limit < coalesce((totals_before->>'receivableOpenBalance')::numeric,0)) then raise exception using errcode='23514', message='CUSTOMER_MERGE_CREDIT_LIMIT_BELOW_OPEN_BALANCE'; end if;

    if not p.is_wholesale and s.is_wholesale then commercial_source := 'secondary';
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
      wholesale_customer_type=case when commercial_source='secondary' then s.wholesale_customer_type else p.wholesale_customer_type end,
      commercial_version=p.commercial_version+1,updated_at=now()
    where id=primary_root;

    update public.customers set merged_into_customer_id=primary_root,merged_at=now(),merged_by=actor_id,merge_operation_id=op_id,merge_reason=trim(p_reason),active=false,status='merged',user_id=null,commercial_version=commercial_version+1,updated_at=now()
    where id=any(family_secondary);

    counts_after := public.customer_merge_counts_v1(primary_root,secondary_root);
    totals_after := public.customer_merge_financial_totals_v1(primary_root,secondary_root);
    fiscal_after := public.customer_merge_fiscal_hashes_v1(primary_root,secondary_root);
    accounting_after := public.customer_merge_accounting_hashes_v1(primary_root,secondary_root);
    if counts_before is distinct from counts_after or totals_before is distinct from totals_after or fiscal_before is distinct from fiscal_after or accounting_before is distinct from accounting_after then
      raise exception using errcode='23514', message='CUSTOMER_MERGE_INVARIANT_FAILED';
    end if;

    result := jsonb_build_object('ok',true,'status','completed','operationId',op_id,'primaryCustomerId',primary_root,'secondaryCustomerId',secondary_root,'idempotentReplay',false,'counts',counts_after,'financialTotals',totals_after,'fiscalHashes',fiscal_after,'accountingHashes',accounting_after);
    update public.customer_merge_operations set counts_after=counts_after,financial_totals_after=totals_after,fiscal_hashes_after=fiscal_after,accounting_hashes_after=accounting_after,status='completed',result=result,completed_at=now() where id=op_id;
    perform public.write_audit_log('customers',primary_root,'customer.canonical_merge_completed',jsonb_build_object('secondaryCustomerId',secondary_root),jsonb_build_object('operationId',op_id,'requestKey',trim(p_request_key),'source',p_source,'reason',trim(p_reason)));
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

revoke all on function public.merge_customers_v1(text,uuid,uuid,integer,integer,text,jsonb,jsonb,jsonb,text,text) from public, anon;
grant execute on function public.merge_customers_v1(text,uuid,uuid,integer,integer,text,jsonb,jsonb,jsonb,text,text) to authenticated, service_role;
comment on function public.merge_customers_v1(text,uuid,uuid,integer,integer,text,jsonb,jsonb,jsonb,text,text) is 'Canonical customer merge. Advisory locks, row locks, optimistic versions, preview hash, idempotent request ledger and invariant rollback.';
