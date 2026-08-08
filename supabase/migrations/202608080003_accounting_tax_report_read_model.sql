-- Canonical, read-only tax report for the accounting workspace.
-- This migration intentionally changes no commercial or accounting data.

create or replace function public.get_accounting_tax_report_summary_v1(
  p_date_from date,
  p_date_to date
)
returns table (
  date_from date,
  date_to date,
  currency text,
  sales_invoice_count bigint,
  sales_tax numeric(20, 2),
  sales_total numeric(20, 2),
  purchase_invoice_count bigint,
  purchase_tax numeric(20, 2),
  purchase_total numeric(20, 2),
  tax_difference numeric(20, 2),
  amount_to_pay numeric(20, 2),
  sales_accounted_count bigint,
  sales_pending_accounting_count bigint,
  purchase_accounted_count bigint,
  purchase_pending_accounting_count bigint,
  sales_reversed_accounting_count bigint,
  purchase_reversed_accounting_count bigint,
  purchases_without_supplier_invoice_count bigint,
  excluded_currency_count bigint,
  calculated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null
     or not (
       public.has_permission('tax:read')
       or public.has_permission('reports:fiscal_read')
     ) then
    raise exception using errcode = '42501', message = 'TAX_REPORT_PERMISSION_DENIED';
  end if;

  if p_date_from is null or p_date_to is null or p_date_from > p_date_to then
    raise exception using errcode = '22023', message = 'TAX_REPORT_DATE_RANGE_INVALID';
  end if;

  return query
  with sale_documents as (
    select
      invoice.id,
      invoice.tax,
      invoice.total,
      case
        when coalesce(event.status, '') = 'reversed' or coalesce(entry.status, '') = 'reversada' then 'reversed'
        when event.status = 'posted' and entry.status = 'publicada' then 'accounted'
        else 'pending'
      end as accounting_status
    from public.invoices invoice
    left join lateral (
      select candidate.id, candidate.status, candidate.journal_entry_id
      from public.financial_events candidate
      where candidate.source_type = 'order'
        and candidate.source_id = invoice.order_id::text
        and candidate.event_purpose in ('sale_recognized', 'sale_revenue')
      order by case candidate.posting_version when 'v2' then 0 else 1 end, candidate.created_at desc
      limit 1
    ) event on true
    left join public.journal_entries entry on entry.id = event.journal_entry_id
    where invoice.invoice_date between p_date_from and p_date_to
      and invoice.status::text in ('emitida', 'issued', 'paid')
  ),
  purchase_documents as (
    select
      supplier_invoice.id,
      supplier_invoice.tax_amount,
      supplier_invoice.total,
      case
        when coalesce(event.status, '') = 'reversed' or coalesce(entry.status, '') = 'reversada' then 'reversed'
        when event.status = 'posted' and entry.status = 'publicada' then 'accounted'
        else 'pending'
      end as accounting_status
    from public.supplier_invoices supplier_invoice
    left join lateral (
      select payable.id
      from public.accounts_payable payable
      where payable.supplier_invoice_id = supplier_invoice.id
      order by payable.created_at desc
      limit 1
    ) payable on true
    left join lateral (
      select candidate.id, candidate.status, candidate.journal_entry_id
      from public.financial_events candidate
      where candidate.source_type = 'accounts_payable'
        and candidate.source_id = payable.id::text
        and candidate.event_purpose = 'accounts_payable_created'
      order by case candidate.posting_version when 'v2' then 0 else 1 end, candidate.created_at desc
      limit 1
    ) event on true
    left join public.journal_entries entry on entry.id = event.journal_entry_id
    where supplier_invoice.invoice_date between p_date_from and p_date_to
      and supplier_invoice.status in ('received', 'posted_to_ap', 'paid')
      and supplier_invoice.currency = 'HNL'
  ),
  sales as (
    select count(*) count_value, coalesce(sum(tax), 0) tax_value, coalesce(sum(total), 0) total_value,
      count(*) filter (where accounting_status = 'accounted') accounted_value,
      count(*) filter (where accounting_status = 'pending') pending_value,
      count(*) filter (where accounting_status = 'reversed') reversed_value
    from sale_documents
  ),
  purchases as (
    select count(*) count_value, coalesce(sum(tax_amount), 0) tax_value, coalesce(sum(total), 0) total_value,
      count(*) filter (where accounting_status = 'accounted') accounted_value,
      count(*) filter (where accounting_status = 'pending') pending_value,
      count(*) filter (where accounting_status = 'reversed') reversed_value
    from purchase_documents
  )
  select
    p_date_from,
    p_date_to,
    'HNL'::text,
    sales.count_value,
    round(sales.tax_value, 2),
    round(sales.total_value, 2),
    purchases.count_value,
    round(purchases.tax_value, 2),
    round(purchases.total_value, 2),
    round(sales.tax_value - purchases.tax_value, 2),
    greatest(round(sales.tax_value - purchases.tax_value, 2), 0),
    sales.accounted_value,
    sales.pending_value,
    purchases.accounted_value,
    purchases.pending_value,
    sales.reversed_value,
    purchases.reversed_value,
    (select count(*) from public.purchases purchase
      where purchase.purchase_date between p_date_from and p_date_to
        and purchase.status in ('confirmed', 'received')
        and not exists (select 1 from public.supplier_invoices document where document.purchase_id = purchase.id)),
    (select count(*) from public.supplier_invoices document
      where document.invoice_date between p_date_from and p_date_to
        and document.status in ('received', 'posted_to_ap', 'paid')
        and document.currency <> 'HNL'),
    statement_timestamp()
  from sales cross join purchases;
end;
$$;

create or replace function public.get_accounting_tax_report_documents_v1(
  p_document_type text,
  p_date_from date,
  p_date_to date,
  p_search text default null,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  document_id uuid,
  document_number text,
  document_date date,
  counterparty_name text,
  tax_amount numeric(20, 2),
  total_amount numeric(20, 2),
  status text,
  accounting_status text,
  journal_entry_id uuid,
  currency text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  normalized_search text := nullif(trim(coalesce(p_search, '')), '');
  normalized_limit integer := coalesce(p_limit, 20);
  normalized_offset integer := coalesce(p_offset, 0);
begin
  if auth.uid() is null
     or not (
       public.has_permission('tax:read')
       or public.has_permission('reports:fiscal_read')
     ) then
    raise exception using errcode = '42501', message = 'TAX_REPORT_PERMISSION_DENIED';
  end if;

  if p_document_type not in ('sale', 'purchase')
     or p_date_from is null or p_date_to is null or p_date_from > p_date_to
     or normalized_limit not in (20, 50)
     or normalized_offset < 0 then
    raise exception using errcode = '22023', message = 'TAX_REPORT_QUERY_INVALID';
  end if;

  return query
  with documents as (
    select
      invoice.id as document_id_value,
      invoice.invoice_number as document_number,
      invoice.invoice_date as document_date,
      coalesce(nullif(trim(invoice.customer_name), ''), 'Consumidor final') as party_name,
      invoice.tax::numeric(20, 2) as tax_value,
      invoice.total::numeric(20, 2) as total_value,
      invoice.status::text as document_status,
      case
        when coalesce(event.status, '') = 'reversed' or coalesce(entry.status, '') = 'reversada' then 'reversed'
        when event.status = 'posted' and entry.status = 'publicada' then 'accounted'
        else 'pending'
      end as accounting_value,
      entry.id as entry_id,
      'HNL'::text as document_currency
    from public.invoices invoice
    left join lateral (
      select candidate.status, candidate.journal_entry_id
      from public.financial_events candidate
      where candidate.source_type = 'order'
        and candidate.source_id = invoice.order_id::text
        and candidate.event_purpose in ('sale_recognized', 'sale_revenue')
      order by case candidate.posting_version when 'v2' then 0 else 1 end, candidate.created_at desc
      limit 1
    ) event on true
    left join public.journal_entries entry on entry.id = event.journal_entry_id
    where p_document_type = 'sale'
      and invoice.invoice_date between p_date_from and p_date_to
      and invoice.status::text in ('emitida', 'issued', 'paid')

    union all

    select
      supplier_invoice.id as document_id_value,
      supplier_invoice.invoice_number as document_number,
      supplier_invoice.invoice_date as document_date,
      supplier.name as party_name,
      supplier_invoice.tax_amount::numeric(20, 2),
      supplier_invoice.total::numeric(20, 2),
      supplier_invoice.status,
      case
        when coalesce(event.status, '') = 'reversed' or coalesce(entry.status, '') = 'reversada' then 'reversed'
        when event.status = 'posted' and entry.status = 'publicada' then 'accounted'
        else 'pending'
      end,
      entry.id,
      supplier_invoice.currency
    from public.supplier_invoices supplier_invoice
    join public.suppliers supplier on supplier.id = supplier_invoice.supplier_id
    left join lateral (
      select payable.id
      from public.accounts_payable payable
      where payable.supplier_invoice_id = supplier_invoice.id
      order by payable.created_at desc
      limit 1
    ) payable on true
    left join lateral (
      select candidate.status, candidate.journal_entry_id
      from public.financial_events candidate
      where candidate.source_type = 'accounts_payable'
        and candidate.source_id = payable.id::text
        and candidate.event_purpose = 'accounts_payable_created'
      order by case candidate.posting_version when 'v2' then 0 else 1 end, candidate.created_at desc
      limit 1
    ) event on true
    left join public.journal_entries entry on entry.id = event.journal_entry_id
    where p_document_type = 'purchase'
      and supplier_invoice.invoice_date between p_date_from and p_date_to
      and supplier_invoice.status in ('received', 'posted_to_ap', 'paid')
      and supplier_invoice.currency = 'HNL'
  ), filtered as (
    select * from documents
    where normalized_search is null
       or documents.document_number ilike '%' || normalized_search || '%'
       or documents.party_name ilike '%' || normalized_search || '%'
  )
  select
    filtered.document_id_value,
    filtered.document_number,
    filtered.document_date,
    filtered.party_name,
    filtered.tax_value,
    filtered.total_value,
    filtered.document_status,
    filtered.accounting_value,
    filtered.entry_id,
    filtered.document_currency,
    count(*) over ()
  from filtered
  order by filtered.document_date desc, filtered.document_number desc, filtered.document_id_value
  limit normalized_limit offset normalized_offset;
end;
$$;

revoke all on function public.get_accounting_tax_report_summary_v1(date, date) from public, anon, authenticated, service_role;
revoke all on function public.get_accounting_tax_report_documents_v1(text, date, date, text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.get_accounting_tax_report_summary_v1(date, date) to authenticated, service_role;
grant execute on function public.get_accounting_tax_report_documents_v1(text, date, date, text, integer, integer) to authenticated, service_role;

comment on function public.get_accounting_tax_report_summary_v1(date, date) is
  'Read-only HNL tax report summary. Persisted invoice taxes are authoritative; accounting is traceability only.';
comment on function public.get_accounting_tax_report_documents_v1(text, date, date, text, integer, integer) is
  'Read-only paginated HNL sale or supplier-invoice documents composing the accounting tax report.';
