begin;

create or replace function public.search_pos_customers_v1(
  p_query text,
  p_limit integer default 25,
  p_offset integer default 0,
  p_include_inactive boolean default false
)
returns table (
  customer_id uuid,
  display_name text,
  business_name text,
  phone_masked text,
  email_masked text,
  customer_type text,
  wholesale_status text,
  has_portal_account boolean,
  is_blocked boolean,
  customer_status text,
  commercial_version integer,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  normalized_query text := public.normalize_pos_customer_text_v1(p_query);
  normalized_email text := public.normalize_pos_customer_email_v1(p_query);
  normalized_phone text := public.normalize_pos_customer_phone_v1(p_query);
  normalized_tax text := public.normalize_pos_customer_tax_id_v1(p_query);
  safe_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
  safe_offset integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
begin
  if not public.pos_permission_allowed('pos:customers:search') then
    raise exception using errcode = '42501', message = 'No tienes permiso para buscar clientes desde Punto de Venta.';
  end if;
  if normalized_query is null then return; end if;

  return query
  with candidates as (
    select
      customer.*,
      public.normalize_pos_customer_text_v1(customer.contact_name) as normalized_name,
      public.normalize_pos_customer_text_v1(coalesce(customer.company_name, customer.business_name)) as normalized_business,
      public.normalize_pos_customer_email_v1(customer.email) as normalized_customer_email,
      public.normalize_pos_customer_phone_v1(customer.phone) as normalized_customer_phone,
      public.normalize_pos_customer_tax_id_v1(customer.tax_id) as normalized_customer_tax,
      exists (
        select 1 from public.customer_credit_accounts credit
        where credit.customer_id = customer.id and credit.status = 'suspended'
      ) or exists (
        select 1 from public.accounts_receivable receivable
        where receivable.customer_id = customer.id
          and receivable.status = 'overdue' and receivable.balance_due > 0
      ) as financial_block
    from public.customers customer
    where customer.active
      and customer.status = 'active'
      and customer.merged_into_customer_id is null
      and customer.wholesale_status <> 'suspended'
      and (
        customer.id::text = trim(p_query)
        or public.normalize_pos_customer_text_v1(customer.contact_name) like '%' || normalized_query || '%'
        or public.normalize_pos_customer_text_v1(coalesce(customer.company_name, customer.business_name)) like '%' || normalized_query || '%'
        or public.normalize_pos_customer_email_v1(customer.email) like '%' || normalized_email || '%'
        or public.normalize_pos_customer_phone_v1(customer.phone) like '%' || normalized_phone || '%'
        or public.normalize_pos_customer_tax_id_v1(customer.tax_id) like '%' || normalized_tax || '%'
      )
  ), ranked as (
    select candidates.*,
      case
        when candidates.id::text = trim(p_query) then 0
        when candidates.normalized_customer_email = normalized_email
          or candidates.normalized_customer_phone = normalized_phone
          or candidates.normalized_customer_tax = normalized_tax
          or candidates.normalized_name = normalized_query
          or candidates.normalized_business = normalized_query then 1
        when candidates.normalized_name like normalized_query || '%'
          or candidates.normalized_business like normalized_query || '%'
          or candidates.normalized_customer_email like normalized_email || '%'
          or candidates.normalized_customer_phone like normalized_phone || '%'
          or candidates.normalized_customer_tax like normalized_tax || '%' then 2
        else 3
      end as match_rank
    from candidates
  )
  select
    ranked.id,
    coalesce(nullif(trim(ranked.contact_name), ''), nullif(trim(coalesce(ranked.company_name, ranked.business_name)), ''), 'Cliente'),
    nullif(trim(coalesce(ranked.company_name, ranked.business_name)), ''),
    public.mask_pos_customer_phone_v1(ranked.phone),
    public.mask_pos_customer_email_v1(ranked.email),
    case when ranked.is_wholesale then 'wholesale' else 'retail' end,
    ranked.wholesale_status,
    ranked.user_id is not null,
    ranked.financial_block,
    'active'::text,
    ranked.commercial_version,
    count(*) over()
  from ranked
  order by ranked.match_rank, ranked.normalized_name nulls last, ranked.normalized_business nulls last, ranked.id
  limit safe_limit offset safe_offset;
end;
$$;

create or replace function public.assert_pos_customer_selectable_v1(target_customer_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  customer_record public.customers%rowtype;
begin
  if not public.pos_permission_allowed('customers:read_commercial')
    or not public.pos_permission_allowed('customers:read_credit') then
    raise exception using errcode = '42501', message = 'No tienes permiso para consultar el contexto del cliente.';
  end if;
  select * into customer_record from public.customers where id = target_customer_id;
  if customer_record.id is null then
    raise exception using errcode = 'P0002', message = 'No se encontro el cliente.';
  end if;
  if not customer_record.active
    or customer_record.status <> 'active'
    or customer_record.merged_into_customer_id is not null
    or customer_record.wholesale_status = 'suspended' then
    raise exception using errcode = 'PT409', message = 'POS_CUSTOMER_SUSPENDED';
  end if;
end;
$$;

create or replace function public.get_selectable_pos_customer_context_v1(target_customer_id uuid)
returns table (
  customer_id uuid,
  display_name text,
  business_name text,
  phone text,
  email text,
  tax_id text,
  address text,
  city text,
  commercial_notes text,
  customer_type text,
  wholesale_status text,
  pricing_mode text,
  pricing_reason text,
  commercial_version integer,
  has_portal_account boolean,
  customer_status text,
  credit_status text,
  credit_enabled boolean,
  credit_limit numeric,
  open_balance numeric,
  available_credit numeric,
  overdue_balance numeric,
  receivable_count bigint,
  can_use_credit boolean,
  credit_reason text,
  order_count bigint,
  invoice_count bigint,
  total_billed numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.assert_pos_customer_selectable_v1(target_customer_id);
  return query select * from public.get_pos_customer_context_v1(target_customer_id);
end;
$$;

create or replace function public.enforce_pos_draft_customer_selectable_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  selectable boolean;
begin
  select customer.active
    and customer.status = 'active'
    and customer.merged_into_customer_id is null
    and customer.wholesale_status <> 'suspended'
  into selectable
  from public.customers customer
  where customer.id = new.customer_id;
  if not coalesce(selectable, false) then
    raise exception using errcode = 'PT409', message = 'POS_CUSTOMER_SUSPENDED';
  end if;
  return new;
end;
$$;

create or replace function public.create_selectable_pos_sale_draft_v1(
  p_request_key uuid,
  p_customer_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.assert_pos_customer_selectable_v1(p_customer_id);
  return public.create_pos_sale_draft_v1(p_request_key, p_customer_id);
end;
$$;

create or replace function public.confirm_selectable_pos_sale_v1(
  p_draft_id uuid,
  p_request_key uuid,
  p_expected_draft_version bigint,
  p_invoice_date date,
  p_payment_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_customer_id uuid;
begin
  if auth.uid() is null or not public.pos_permission_allowed('pos:confirm_sale') then
    raise exception using errcode = '42501', message = 'POS_PERMISSION_DENIED';
  end if;
  select draft.customer_id into target_customer_id
  from public.pos_sale_drafts draft
  where draft.id = p_draft_id
    and (draft.owner_user_id = auth.uid() or public.pos_permission_allowed('pos:drafts:edit_any'));
  if target_customer_id is null then
    raise exception using errcode = 'P0002', message = 'POS_DRAFT_NOT_FOUND';
  end if;
  perform public.assert_pos_customer_selectable_v1(target_customer_id);
  return public.confirm_pos_sale_v1(
    p_draft_id,
    p_request_key,
    p_expected_draft_version,
    p_invoice_date,
    p_payment_payload
  );
end;
$$;

drop trigger if exists enforce_pos_draft_customer_selectable_trigger on public.pos_sale_drafts;
create trigger enforce_pos_draft_customer_selectable_trigger
before insert or update of customer_id, customer_commercial_version
on public.pos_sale_drafts
for each row execute function public.enforce_pos_draft_customer_selectable_v1();

drop trigger if exists enforce_pos_confirmation_customer_selectable_trigger on public.pos_sale_drafts;
create trigger enforce_pos_confirmation_customer_selectable_trigger
before update of status on public.pos_sale_drafts
for each row
when (new.status = 'confirmed' and old.status is distinct from new.status)
execute function public.enforce_pos_draft_customer_selectable_v1();

revoke all on function public.assert_pos_customer_selectable_v1(uuid) from public, anon, authenticated;
revoke all on function public.get_selectable_pos_customer_context_v1(uuid) from public, anon;
revoke execute on function public.get_pos_customer_context_v1(uuid) from authenticated;
revoke all on function public.create_selectable_pos_sale_draft_v1(uuid, uuid) from public, anon;
revoke execute on function public.create_pos_sale_draft_v1(uuid, uuid) from authenticated;
revoke all on function public.confirm_selectable_pos_sale_v1(uuid, uuid, bigint, date, jsonb) from public, anon;
revoke execute on function public.confirm_pos_sale_v1(uuid, uuid, bigint, date, jsonb) from authenticated;
revoke all on function public.enforce_pos_draft_customer_selectable_v1() from public, anon, authenticated;
grant execute on function public.get_selectable_pos_customer_context_v1(uuid) to authenticated;
grant execute on function public.create_selectable_pos_sale_draft_v1(uuid, uuid) to authenticated;
grant execute on function public.confirm_selectable_pos_sale_v1(uuid, uuid, bigint, date, jsonb) to authenticated;

comment on function public.search_pos_customers_v1(text, integer, integer, boolean) is
  'Operational POS search. Always excludes inactive, suspended and merged customers; p_include_inactive is retained only for signature compatibility.';
comment on function public.get_selectable_pos_customer_context_v1(uuid) is
  'Returns POS customer context only when the customer is eligible for a new sale.';
comment on function public.create_selectable_pos_sale_draft_v1(uuid, uuid) is
  'Creates a POS draft only after validating that the customer is eligible for a new sale.';
comment on function public.confirm_selectable_pos_sale_v1(uuid, uuid, bigint, date, jsonb) is
  'Confirms a POS sale only after revalidating that the draft customer is eligible.';
comment on function public.enforce_pos_draft_customer_selectable_v1() is
  'Prevents new, reassigned, saved or confirmed POS drafts from using an inactive, suspended or merged customer.';

commit;
