select pg_advisory_xact_lock(
  hashtextextended(
    '202608040001:repair_cromos_invoice_purchase_relationship',
    0
  )
);

do $repair$
declare
  target_supplier_id constant uuid :=
    '335b38ff-d06d-4bf1-88f0-ea51f034ee5f';
  wrong_purchase_supplier_id constant uuid :=
    'ae12f73b-a9bf-49cb-b5b8-f015d0b305bb';
  target_invoice_id constant uuid :=
    '00bd93df-88cc-412d-b8d5-63d66b93feee';
  target_payable_id constant uuid :=
    'c1b65061-78ba-4c97-adca-a0591acb6f4d';
  wrong_purchase_id constant uuid :=
    'b8d1cd9e-1916-43e5-aa11-30271c65c52e';
  protected_purchase_id constant uuid :=
    'e1c7d312-ec94-4002-9458-754d723a131a';
  invoice_before public.supplier_invoices%rowtype;
  payable_before public.accounts_payable%rowtype;
  purchase_before public.purchases%rowtype;
  target_count integer;
begin
  select
    (select count(*) from public.supplier_invoices where id = target_invoice_id)
    + (select count(*) from public.accounts_payable where id = target_payable_id)
    + (select count(*) from public.purchases where id = wrong_purchase_id)
  into target_count;

  -- A clean local database does not contain the production incident.
  if target_count = 0 then
    return;
  end if;
  if target_count <> 3 then
    raise exception using
      errcode = '23514',
      message = 'CROMOS_REPAIR_PRECONDITION_FAILED: incomplete target set';
  end if;

  select * into strict invoice_before
  from public.supplier_invoices
  where id = target_invoice_id
  for update;

  select * into strict payable_before
  from public.accounts_payable
  where id = target_payable_id
  for update;

  select * into strict purchase_before
  from public.purchases
  where id = wrong_purchase_id
  for update;

  perform 1
  from public.suppliers
  where id = target_supplier_id
    and name = 'CROMOS TORRE FUERTE'
    and is_active;
  if not found then
    raise exception using
      errcode = '23514',
      message = 'CROMOS_REPAIR_PRECONDITION_FAILED: supplier';
  end if;

  if invoice_before.supplier_id <> target_supplier_id
    or invoice_before.purchase_id <> wrong_purchase_id
    or invoice_before.invoice_number <> '1'
    or invoice_before.invoice_date <> date '2026-07-28'
    or invoice_before.total <> 2800.00
    or invoice_before.status <> 'posted_to_ap'
  then
    raise exception using
      errcode = '23514',
      message = 'CROMOS_REPAIR_PRECONDITION_FAILED: supplier invoice';
  end if;

  if payable_before.supplier_id <> target_supplier_id
    or payable_before.supplier_invoice_id <> target_invoice_id
    or payable_before.purchase_id <> wrong_purchase_id
    or payable_before.total_amount <> 2800.00
    or payable_before.paid_amount <> 0.00
    or payable_before.balance <> 2800.00
    or payable_before.status <> 'pending'
    or payable_before.due_date <> date '2026-07-28'
  then
    raise exception using
      errcode = '23514',
      message = 'CROMOS_REPAIR_PRECONDITION_FAILED: accounts payable';
  end if;

  if purchase_before.supplier_id <> wrong_purchase_supplier_id
    or purchase_before.purchase_number <> '1'
    or purchase_before.purchase_date <> date '2026-07-29'
    or purchase_before.total <> 2800.00
    or purchase_before.status <> 'confirmed'
  then
    raise exception using
      errcode = '23514',
      message = 'CROMOS_REPAIR_PRECONDITION_FAILED: Franklin purchase';
  end if;

  if exists (
    select 1
    from public.purchases
    where supplier_id = target_supplier_id
      and total = 2800.00
      and purchase_date between date '2026-07-27' and date '2026-07-29'
  ) then
    raise exception using
      errcode = '23514',
      message = 'CROMOS_REPAIR_PRECONDITION_FAILED: canonical purchase now exists';
  end if;

  if exists (
    select 1
    from public.supplier_payments
    where accounts_payable_id = target_payable_id
  ) or exists (
    select 1
    from public.supplier_payment_applications
    where accounts_payable_id = target_payable_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'CROMOS_REPAIR_PRECONDITION_FAILED: payment activity exists';
  end if;

  perform 1
  from public.purchases
  where id = protected_purchase_id
    and supplier_id = target_supplier_id
    and purchase_number = '0090915'
    and total = 3100.00;
  if not found then
    raise exception using
      errcode = '23514',
      message = 'CROMOS_REPAIR_PRECONDITION_FAILED: protected 0090915';
  end if;

  update public.supplier_invoices
  set purchase_id = null
  where id = target_invoice_id
    and purchase_id = wrong_purchase_id;
  if not found then
    raise exception using
      errcode = '23514',
      message = 'CROMOS_REPAIR_PRECONDITION_FAILED: invoice update';
  end if;

  update public.accounts_payable
  set purchase_id = null
  where id = target_payable_id
    and purchase_id = wrong_purchase_id;
  if not found then
    raise exception using
      errcode = '23514',
      message = 'CROMOS_REPAIR_PRECONDITION_FAILED: payable update';
  end if;

  insert into public.audit_logs (
    user_id,
    actor_role,
    table_name,
    record_id,
    action,
    old_data,
    new_data
  ) values
    (
      null,
      'system',
      'supplier_invoices',
      target_invoice_id,
      'supplier_invoice.purchase_relationship_repaired',
      jsonb_build_object(
        'supplier_id', invoice_before.supplier_id,
        'purchase_id', invoice_before.purchase_id,
        'invoice_number', invoice_before.invoice_number,
        'total', invoice_before.total
      ),
      jsonb_build_object(
        'supplier_id', invoice_before.supplier_id,
        'purchase_id', null,
        'invoice_number', invoice_before.invoice_number,
        'total', invoice_before.total,
        'repair', 'CAMINO_B_NO_CANONICAL_PURCHASE'
      )
    ),
    (
      null,
      'system',
      'accounts_payable',
      target_payable_id,
      'accounts_payable.purchase_relationship_repaired',
      jsonb_build_object(
        'supplier_id', payable_before.supplier_id,
        'purchase_id', payable_before.purchase_id,
        'supplier_invoice_id', payable_before.supplier_invoice_id,
        'paid_amount', payable_before.paid_amount,
        'balance', payable_before.balance,
        'status', payable_before.status
      ),
      jsonb_build_object(
        'supplier_id', payable_before.supplier_id,
        'purchase_id', null,
        'supplier_invoice_id', payable_before.supplier_invoice_id,
        'paid_amount', payable_before.paid_amount,
        'balance', payable_before.balance,
        'status', payable_before.status,
        'repair', 'CAMINO_B_NO_CANONICAL_PURCHASE'
      )
    );

  if exists (
    select 1
    from public.supplier_invoices
    where id = target_invoice_id
      and (
        supplier_id <> target_supplier_id
        or purchase_id is not null
        or total <> 2800.00
        or status <> 'posted_to_ap'
      )
  ) or exists (
    select 1
    from public.accounts_payable
    where id = target_payable_id
      and (
        supplier_id <> target_supplier_id
        or purchase_id is not null
        or paid_amount <> 0.00
        or balance <> 2800.00
        or status <> 'pending'
      )
  ) then
    raise exception using
      errcode = '23514',
      message = 'CROMOS_REPAIR_POSTCONDITION_FAILED';
  end if;
end;
$repair$;
