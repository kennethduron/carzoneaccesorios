-- Canonical duplicate matching and server-calculated merge preview.

create or replace function public.customer_merge_sha256_v1(value jsonb)
returns text language sql immutable parallel safe set search_path = public, pg_temp as $$
  select encode(extensions.digest(convert_to(coalesce(value, 'null'::jsonb)::text, 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function public.customer_merge_counts_v1(p_primary uuid, p_secondary uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with family as (
    select customer_id from public.get_customer_family_ids_v1(p_primary)
    union select customer_id from public.get_customer_family_ids_v1(p_secondary)
  ), family_orders as (
    select id, total from public.orders where customer_id in (select customer_id from family)
  ), family_entries as (
    select distinct je.id
    from public.journal_entries je join public.journal_entry_lines jel on jel.journal_entry_id = je.id
    where jel.customer_id in (select customer_id from family)
  )
  select jsonb_build_object(
    'customers', (select count(*) from family),
    'orders', (select count(*) from family_orders),
    'invoices', (select count(*) from public.invoices where customer_id in (select customer_id from family)),
    'payments', (select count(*) from public.payments where customer_id in (select customer_id from family)),
    'receivables', (select count(*) from public.accounts_receivable where customer_id in (select customer_id from family)),
    'receivablePayments', (select count(*) from public.accounts_receivable_payments where customer_id in (select customer_id from family)),
    'crmNotes', (select count(*) from public.crm_notes where customer_id in (select customer_id from family)),
    'crmFollowups', (select count(*) from public.crm_followups where customer_id in (select customer_id from family)),
    'wholesaleCodes', (select count(*) from public.wholesale_codes where customer_id in (select customer_id from family)),
    'checkoutRequests', (select count(*) from public.checkout_requests_v4 where customer_id in (select customer_id from family)),
    'activeCheckoutRequests', (select count(*) from public.checkout_requests_v4 where customer_id in (select customer_id from family) and status in ('started', 'processing')),
    'activePosDrafts', (select count(*) from public.pos_sale_drafts where customer_id in (select customer_id from family) and status = 'active'),
    'journalEntries', (select count(*) from family_entries),
    'journalLines', (select count(*) from public.journal_entry_lines where customer_id in (select customer_id from family)),
    'reservations', (select count(*) from public.inventory_reservations where order_id in (select id from family_orders)),
    'inventoryMovements', (select count(*) from public.inventory_movements where reference_id in (select id from family_orders))
  );
$$;

create or replace function public.customer_merge_financial_totals_v1(p_primary uuid, p_secondary uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with family as (
    select customer_id from public.get_customer_family_ids_v1(p_primary)
    union select customer_id from public.get_customer_family_ids_v1(p_secondary)
  ), family_orders as (select id from public.orders where customer_id in (select customer_id from family))
  select jsonb_build_object(
    'orderTotal', coalesce((select sum(total) from public.orders where customer_id in (select customer_id from family)), 0),
    'invoiceTotal', coalesce((select sum(total) from public.invoices where customer_id in (select customer_id from family)), 0),
    'paymentTotal', coalesce((select sum(amount) from public.payments where customer_id in (select customer_id from family)), 0),
    'receivableOriginalTotal', coalesce((select sum(original_amount) from public.accounts_receivable where customer_id in (select customer_id from family)), 0),
    'receivableOpenBalance', coalesce((select sum(balance_due) from public.accounts_receivable where customer_id in (select customer_id from family) and status in ('open', 'partial', 'overdue')), 0),
    'receivablePaymentTotal', coalesce((select sum(amount) from public.accounts_receivable_payments where customer_id in (select customer_id from family) and voided_at is null), 0),
    'journalDebit', coalesce((select sum(debit) from public.journal_entry_lines where customer_id in (select customer_id from family)), 0),
    'journalCredit', coalesce((select sum(credit) from public.journal_entry_lines where customer_id in (select customer_id from family)), 0),
    'reservedQuantity', coalesce((select sum(quantity) from public.inventory_reservations where order_id in (select id from family_orders)), 0),
    'inventoryMovementQuantity', coalesce((select sum(quantity) from public.inventory_movements where reference_id in (select id from family_orders)), 0)
  );
$$;

create or replace function public.customer_merge_fiscal_hashes_v1(p_primary uuid, p_secondary uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with family as (
    select customer_id from public.get_customer_family_ids_v1(p_primary)
    union select customer_id from public.get_customer_family_ids_v1(p_secondary)
  ), invoice_payload as (
    select jsonb_build_object(
      'id', i.id, 'orderId', i.order_id, 'customerId', i.customer_id, 'number', i.invoice_number,
      'status', i.status, 'subtotal', i.subtotal, 'tax', i.tax, 'total', i.total, 'issuedAt', i.issued_at,
      'lines', coalesce((select jsonb_agg(jsonb_build_object('id', ii.id, 'sku', ii.sku, 'quantity', ii.quantity, 'unitPrice', ii.unit_price, 'lineTotal', ii.line_total) order by ii.id) from public.invoice_items ii where ii.invoice_id = i.id), '[]'::jsonb)
    ) payload from public.invoices i where i.customer_id in (select customer_id from family) order by i.id
  )
  select jsonb_build_object(
    'invoices', public.customer_merge_sha256_v1(coalesce((select jsonb_agg(payload) from invoice_payload), '[]'::jsonb))
  );
$$;

create or replace function public.customer_merge_accounting_hashes_v1(p_primary uuid, p_secondary uuid)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with family as (
    select customer_id from public.get_customer_family_ids_v1(p_primary)
    union select customer_id from public.get_customer_family_ids_v1(p_secondary)
  ), lines as (
    select jsonb_build_object(
      'entryId', je.id, 'entryNumber', je.entry_number, 'entryDate', je.entry_date, 'entryStatus', je.status,
      'lineId', jel.id, 'accountId', jel.account_id, 'customerId', jel.customer_id,
      'debit', jel.debit, 'credit', jel.credit, 'description', jel.description
    ) payload
    from public.journal_entry_lines jel join public.journal_entries je on je.id = jel.journal_entry_id
    where jel.customer_id in (select customer_id from family) and je.status in ('publicada', 'reversada')
    order by je.id, jel.id
  )
  select jsonb_build_object('publishedEntries', public.customer_merge_sha256_v1(coalesce((select jsonb_agg(payload) from lines), '[]'::jsonb)));
$$;

create or replace function public.preview_customer_merge_v1(p_primary_customer_id uuid, p_secondary_customer_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  actor_role text := public.current_actor_role();
  primary_root uuid; secondary_root uuid;
  p public.customers%rowtype; s public.customers%rowtype;
  identity jsonb; signals jsonb := '[]'::jsonb; warnings jsonb := '[]'::jsonb; blockers jsonb := '[]'::jsonb;
  decisions jsonb := '[]'::jsonb; counts jsonb; totals jsonb; fiscal jsonb; accounting jsonb;
  p_credit jsonb; s_credit jsonb; preview_core jsonb; preview_hash text;
  p_name text; s_name text; p_business text; s_business text;
begin
  if auth.uid() is null or actor_role not in ('technical_owner', 'business_owner', 'admin')
     or not (public.has_permission('customers:merge') or public.has_permission('customers:manage')) then
    raise exception using errcode = '42501', message = 'CUSTOMER_MERGE_PREVIEW_FORBIDDEN';
  end if;
  if p_primary_customer_id is null or p_secondary_customer_id is null or p_primary_customer_id = p_secondary_customer_id then
    raise exception using errcode = '22023', message = 'CUSTOMER_MERGE_DISTINCT_CUSTOMERS_REQUIRED';
  end if;

  primary_root := public.resolve_customer_root_v1(p_primary_customer_id);
  secondary_root := public.resolve_customer_root_v1(p_secondary_customer_id);
  if primary_root = secondary_root then raise exception using errcode = '22023', message = 'CUSTOMER_MERGE_ALREADY_SAME_FAMILY'; end if;
  select * into p from public.customers where id = primary_root;
  select * into s from public.customers where id = secondary_root;

  p_name := public.normalize_customer_name_v1(p.contact_name); s_name := public.normalize_customer_name_v1(s.contact_name);
  p_business := public.normalize_customer_name_v1(coalesce(p.company_name, p.business_name));
  s_business := public.normalize_customer_name_v1(coalesce(s.company_name, s.business_name));

  if p.user_id is not null and p.user_id = s.user_id then signals := signals || jsonb_build_array(jsonb_build_object('strength','strong','code','same_portal_account')); end if;
  if public.normalize_customer_tax_id_hn_v1(p.tax_id) is not null and public.normalize_customer_tax_id_hn_v1(p.tax_id) = public.normalize_customer_tax_id_hn_v1(s.tax_id) then signals := signals || jsonb_build_array(jsonb_build_object('strength','strong','code','same_tax_id')); end if;
  if public.normalize_customer_email_v1(p.email) is not null and public.normalize_customer_email_v1(p.email) = public.normalize_customer_email_v1(s.email) then signals := signals || jsonb_build_array(jsonb_build_object('strength','strong','code','same_email')); end if;
  if public.normalize_customer_phone_hn_v1(p.phone) is not null and public.normalize_customer_phone_hn_v1(p.phone) = public.normalize_customer_phone_hn_v1(s.phone) and (p_name = s_name or p_business = s_name or p_business = s_business) then signals := signals || jsonb_build_array(jsonb_build_object('strength','strong','code','same_phone_compatible_name')); end if;
  if p_business is not null and p_business = s_business then signals := signals || jsonb_build_array(jsonb_build_object('strength','probable','code','same_business_name')); end if;
  if p_name is not null and p_name = s_name then signals := signals || jsonb_build_array(jsonb_build_object('strength','weak','code','same_contact_name')); end if;

  if p.user_id is not null and s.user_id is not null and p.user_id <> s.user_id then blockers := blockers || '"CUSTOMER_MERGE_TWO_PORTAL_ACCOUNTS"'::jsonb; end if;
  if public.normalize_customer_tax_id_hn_v1(p.tax_id) is not null and public.normalize_customer_tax_id_hn_v1(s.tax_id) is not null and public.normalize_customer_tax_id_hn_v1(p.tax_id) <> public.normalize_customer_tax_id_hn_v1(s.tax_id) then
    warnings := warnings || '"CUSTOMER_MERGE_TAX_ID_CONFLICT"'::jsonb;
    decisions := decisions || '"tax_id"'::jsonb;
  end if;
  if exists (select 1 from public.checkout_requests_v4 where customer_id in (select customer_id from public.get_customer_family_ids_v1(primary_root) union select customer_id from public.get_customer_family_ids_v1(secondary_root)) and status in ('started','processing')) then blockers := blockers || '"CUSTOMER_MERGE_CHECKOUT_IN_PROGRESS"'::jsonb; end if;
  if exists (select 1 from public.pos_sale_drafts where customer_id in (select customer_id from public.get_customer_family_ids_v1(primary_root) union select customer_id from public.get_customer_family_ids_v1(secondary_root)) and status = 'active') then blockers := blockers || '"CUSTOMER_MERGE_POS_DRAFT_ACTIVE"'::jsonb; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'field', field_name, 'primaryValue', primary_value, 'secondaryValue', secondary_value,
    'primaryNormalized', primary_normalized, 'secondaryNormalized', secondary_normalized,
    'state', case when primary_normalized is not null and primary_normalized = secondary_normalized then 'equal' when primary_value is null and secondary_value is not null then 'missing_primary' when primary_value is not null and secondary_value is null then 'missing_secondary' when primary_value is null and secondary_value is null then 'empty' else 'conflict' end,
    'proposedAction', case when primary_normalized is not null and primary_normalized = secondary_normalized then 'keep_primary' when primary_value is null and secondary_value is not null then 'complete_primary' when primary_value is not null and secondary_value is null then 'keep_primary' when primary_value is null and secondary_value is null then 'none' else 'choose_and_preserve_alternate' end
  ) order by field_order), '[]'::jsonb) into identity
  from (values
    (1,'business_name',p.business_name,s.business_name,public.normalize_customer_name_v1(p.business_name),public.normalize_customer_name_v1(s.business_name)),
    (2,'company_name',p.company_name,s.company_name,public.normalize_customer_name_v1(p.company_name),public.normalize_customer_name_v1(s.company_name)),
    (3,'contact_name',p.contact_name,s.contact_name,public.normalize_customer_name_v1(p.contact_name),public.normalize_customer_name_v1(s.contact_name)),
    (4,'email',p.email,s.email,public.normalize_customer_email_v1(p.email),public.normalize_customer_email_v1(s.email)),
    (5,'phone',p.phone,s.phone,public.normalize_customer_phone_hn_v1(p.phone),public.normalize_customer_phone_hn_v1(s.phone)),
    (6,'tax_id',p.tax_id,s.tax_id,public.normalize_customer_tax_id_hn_v1(p.tax_id),public.normalize_customer_tax_id_hn_v1(s.tax_id)),
    (7,'address',p.address,s.address,public.normalize_customer_address_v1(p.address),public.normalize_customer_address_v1(s.address)),
    (8,'city',p.city,s.city,public.normalize_customer_address_v1(p.city),public.normalize_customer_address_v1(s.city))
  ) fields(field_order,field_name,primary_value,secondary_value,primary_normalized,secondary_normalized);

  select to_jsonb(c) - 'notes' into p_credit from public.customer_credit_accounts c where c.customer_id = primary_root;
  select to_jsonb(c) - 'notes' into s_credit from public.customer_credit_accounts c where c.customer_id = secondary_root;
  if p_credit is not null and s_credit is not null then decisions := decisions || '"credit"'::jsonb; warnings := warnings || '"CUSTOMER_MERGE_CREDIT_CONFLICT"'::jsonb; end if;
  if p.is_wholesale and s.is_wholesale and (p.wholesale_status, p.wholesale_customer_type) is distinct from (s.wholesale_status, s.wholesale_customer_type) then decisions := decisions || '"commercial"'::jsonb; warnings := warnings || '"CUSTOMER_MERGE_WHOLESALE_CONFLICT"'::jsonb; end if;

  counts := public.customer_merge_counts_v1(primary_root, secondary_root);
  totals := public.customer_merge_financial_totals_v1(primary_root, secondary_root);
  fiscal := public.customer_merge_fiscal_hashes_v1(primary_root, secondary_root);
  accounting := public.customer_merge_accounting_hashes_v1(primary_root, secondary_root);

  preview_core := jsonb_build_object(
    'primaryCustomerId', primary_root, 'secondaryCustomerId', secondary_root,
    'primaryCommercialVersion', p.commercial_version, 'secondaryCommercialVersion', s.commercial_version,
    'identity', identity, 'signals', signals, 'warnings', warnings, 'blockers', blockers,
    'requiredDecisions', decisions, 'counts', counts, 'financialTotals', totals,
    'fiscalHashes', fiscal, 'accountingHashes', accounting,
    'portal', jsonb_build_object('primaryUserId', p.user_id, 'secondaryUserId', s.user_id),
    'credit', jsonb_build_object('primary', p_credit, 'secondary', s_credit),
    'wholesale', jsonb_build_object('primary', jsonb_build_object('enabled',p.is_wholesale,'status',p.wholesale_status,'type',p.wholesale_customer_type), 'secondary', jsonb_build_object('enabled',s.is_wholesale,'status',s.wholesale_status,'type',s.wholesale_customer_type)),
    'relationPlan', jsonb_build_object('reassign',jsonb_build_array('crm_notes','crm_followups','accounts_receivable','accounts_receivable_payments'),'preserveHistorical',jsonb_build_array('orders','invoices','payments','published_journal_entries','financial_events','inventory_movements','import_rows'))
  );
  preview_hash := public.customer_merge_sha256_v1(preview_core);
  return preview_core || jsonb_build_object(
    'allowed', jsonb_array_length(blockers) = 0,
    'confidence', case when signals @> '[{"strength":"strong"}]'::jsonb then 'strong' when signals @> '[{"strength":"probable"}]'::jsonb then 'probable' else 'weak' end,
    'previewHash', preview_hash
  );
end;
$$;

create or replace function public.find_customer_match_candidates_v1(
  p_email text default null, p_phone text default null, p_tax_id text default null,
  p_business_name text default null, p_contact_name text default null, p_excluded_customer_id uuid default null,
  p_limit integer default 10
)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare enabled boolean; can_sensitive boolean;
begin
  if auth.uid() is null or not (public.has_permission('customers:manage') or public.has_permission('customers:merge') or public.has_permission('receivables:read') or public.has_permission('pos:customers:search')) then
    raise exception using errcode = '42501', message = 'CUSTOMER_MATCH_FORBIDDEN';
  end if;
  select flag.enabled into enabled from public.customer_feature_flags flag where key = 'customer_duplicate_prevention_v1';
  if not coalesce(enabled,false) then return jsonb_build_object('enabled',false,'candidates','[]'::jsonb); end if;
  can_sensitive := public.has_permission('customers:manage') or public.has_permission('customers:merge') or public.has_permission('receivables:read');
  return jsonb_build_object('enabled',true,'candidates',coalesce((
    select jsonb_agg(candidate order by (candidate->>'score')::integer desc, candidate->>'displayName') from (
      select jsonb_build_object(
        'id', c.id, 'displayName', coalesce(c.company_name,c.business_name,c.contact_name),
        'email', case when can_sensitive then c.email else public.mask_pos_customer_email_v1(c.email) end,
        'phone', case when can_sensitive then c.phone else public.mask_pos_customer_phone_v1(c.phone) end,
        'taxId', case when can_sensitive then c.tax_id else case when c.tax_id is null then null else '••••' || right(regexp_replace(c.tax_id,'[^0-9]','','g'),4) end end,
        'hasPortal', c.user_id is not null, 'wholesale', c.is_wholesale, 'status', c.status,
        'score',
          (case when public.normalize_customer_tax_id_hn_v1(p_tax_id) is not null and public.normalize_customer_tax_id_hn_v1(c.tax_id)=public.normalize_customer_tax_id_hn_v1(p_tax_id) then 100 else 0 end)+
          (case when public.normalize_customer_email_v1(p_email) is not null and public.normalize_customer_email_v1(c.email)=public.normalize_customer_email_v1(p_email) then 80 else 0 end)+
          (case when public.normalize_customer_phone_hn_v1(p_phone) is not null and public.normalize_customer_phone_hn_v1(c.phone)=public.normalize_customer_phone_hn_v1(p_phone) then 60 else 0 end)+
          (case when public.normalize_customer_name_v1(p_business_name) is not null and public.normalize_customer_name_v1(coalesce(c.company_name,c.business_name))=public.normalize_customer_name_v1(p_business_name) then 30 else 0 end)+
          (case when public.normalize_customer_name_v1(p_contact_name) is not null and public.normalize_customer_name_v1(c.contact_name)=public.normalize_customer_name_v1(p_contact_name) then 15 else 0 end),
        'reasons', jsonb_strip_nulls(jsonb_build_object(
          'taxId', case when public.normalize_customer_tax_id_hn_v1(p_tax_id)=public.normalize_customer_tax_id_hn_v1(c.tax_id) and public.normalize_customer_tax_id_hn_v1(p_tax_id) is not null then true end,
          'email', case when public.normalize_customer_email_v1(p_email)=public.normalize_customer_email_v1(c.email) and public.normalize_customer_email_v1(p_email) is not null then true end,
          'phone', case when public.normalize_customer_phone_hn_v1(p_phone)=public.normalize_customer_phone_hn_v1(c.phone) and public.normalize_customer_phone_hn_v1(p_phone) is not null then true end,
          'name', case when public.normalize_customer_name_v1(p_business_name)=public.normalize_customer_name_v1(coalesce(c.company_name,c.business_name)) and public.normalize_customer_name_v1(p_business_name) is not null then true end
        ))
      ) candidate
      from public.customers c
      where c.merged_into_customer_id is null and c.active
        and (p_excluded_customer_id is null or c.id <> public.resolve_customer_root_v1(p_excluded_customer_id))
        and (
          (public.normalize_customer_tax_id_hn_v1(p_tax_id) is not null and public.normalize_customer_tax_id_hn_v1(c.tax_id)=public.normalize_customer_tax_id_hn_v1(p_tax_id)) or
          (public.normalize_customer_email_v1(p_email) is not null and public.normalize_customer_email_v1(c.email)=public.normalize_customer_email_v1(p_email)) or
          (public.normalize_customer_phone_hn_v1(p_phone) is not null and public.normalize_customer_phone_hn_v1(c.phone)=public.normalize_customer_phone_hn_v1(p_phone)) or
          (public.normalize_customer_name_v1(p_business_name) is not null and public.normalize_customer_name_v1(coalesce(c.company_name,c.business_name))=public.normalize_customer_name_v1(p_business_name)) or
          (public.normalize_customer_name_v1(p_contact_name) is not null and public.normalize_customer_name_v1(c.contact_name)=public.normalize_customer_name_v1(p_contact_name))
        ) limit greatest(1,least(coalesce(p_limit,10),25))
    ) ranked
  ),'[]'::jsonb));
end;
$$;

revoke all on function public.customer_merge_counts_v1(uuid,uuid), public.customer_merge_financial_totals_v1(uuid,uuid), public.customer_merge_fiscal_hashes_v1(uuid,uuid), public.customer_merge_accounting_hashes_v1(uuid,uuid) from public, anon, authenticated;
revoke all on function public.preview_customer_merge_v1(uuid,uuid), public.find_customer_match_candidates_v1(text,text,text,text,text,uuid,integer) from public, anon;
grant execute on function public.preview_customer_merge_v1(uuid,uuid), public.find_customer_match_candidates_v1(text,text,text,text,text,uuid,integer) to authenticated, service_role;
