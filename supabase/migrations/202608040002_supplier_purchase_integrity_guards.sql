create or replace function public.validate_supplier_purchase_integrity_v1(
  target_supplier_id uuid,
  target_purchase_id uuid,
  target_supplier_invoice_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $function$
declare
  purchase_supplier_id uuid;
  purchase_status text;
  invoice_supplier_id uuid;
  invoice_purchase_id uuid;
  invoice_status text;
begin
  if target_supplier_id is null then
    raise exception using
      errcode = '23514',
      message = 'SUPPLIER_PURCHASE_MISMATCH: El proveedor es obligatorio.';
  end if;

  if target_purchase_id is not null then
    select supplier_id, status
    into purchase_supplier_id, purchase_status
    from public.purchases
    where id = target_purchase_id;

    if not found
      or purchase_status = 'cancelled'
      or purchase_supplier_id <> target_supplier_id
    then
      raise exception using
        errcode = '23514',
        message = 'SUPPLIER_PURCHASE_MISMATCH: La compra seleccionada pertenece a otro proveedor. Seleccione una compra del mismo proveedor antes de continuar.';
    end if;
  end if;

  if target_supplier_invoice_id is not null then
    select supplier_id, purchase_id, status
    into invoice_supplier_id, invoice_purchase_id, invoice_status
    from public.supplier_invoices
    where id = target_supplier_invoice_id;

    if not found
      or invoice_status = 'cancelled'
      or invoice_supplier_id <> target_supplier_id
    then
      raise exception using
        errcode = '23514',
        message = 'SUPPLIER_PURCHASE_MISMATCH: La factura seleccionada pertenece a otro proveedor.';
    end if;

    if invoice_purchase_id is not null then
      perform public.validate_supplier_purchase_integrity_v1(
        invoice_supplier_id,
        invoice_purchase_id,
        null
      );
    end if;
  end if;
end;
$function$;

revoke all on function public.validate_supplier_purchase_integrity_v1(
  uuid,
  uuid,
  uuid
) from public, anon, authenticated;

create or replace function public.guard_supplier_invoice_purchase_integrity_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  perform public.validate_supplier_purchase_integrity_v1(
    new.supplier_id,
    new.purchase_id,
    null
  );
  return new;
end;
$function$;

create or replace function public.guard_accounts_payable_purchase_integrity_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  perform public.validate_supplier_purchase_integrity_v1(
    new.supplier_id,
    new.purchase_id,
    new.supplier_invoice_id
  );
  return new;
end;
$function$;

create or replace function public.guard_purchase_supplier_change_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
begin
  if new.supplier_id is distinct from old.supplier_id
    and (
      exists (
        select 1
        from public.supplier_invoices
        where purchase_id = new.id
          and supplier_id <> new.supplier_id
      )
      or exists (
        select 1
        from public.accounts_payable
        where purchase_id = new.id
          and supplier_id <> new.supplier_id
      )
    )
  then
    raise exception using
      errcode = '23514',
      message = 'SUPPLIER_PURCHASE_MISMATCH: La compra tiene facturas u obligaciones de otro proveedor.';
  end if;
  return new;
end;
$function$;

create or replace function public.guard_supplier_payment_purchase_integrity_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  payable public.accounts_payable%rowtype;
begin
  if new.accounts_payable_id is null then
    return new;
  end if;

  select * into payable
  from public.accounts_payable
  where id = new.accounts_payable_id;

  if not found or payable.supplier_id <> new.supplier_id then
    raise exception using
      errcode = '23514',
      message = 'SUPPLIER_PURCHASE_MISMATCH: El pago y la obligación pertenecen a proveedores distintos.';
  end if;

  perform public.validate_supplier_purchase_integrity_v1(
    payable.supplier_id,
    payable.purchase_id,
    payable.supplier_invoice_id
  );
  return new;
end;
$function$;

create or replace function public.guard_supplier_payment_application_integrity_v1()
returns trigger
language plpgsql
security definer
set search_path = public
as $function$
declare
  payable public.accounts_payable%rowtype;
  payment_supplier_id uuid;
begin
  select supplier_id into payment_supplier_id
  from public.supplier_payments
  where id = new.supplier_payment_id;

  select * into payable
  from public.accounts_payable
  where id = new.accounts_payable_id;

  if payment_supplier_id is null
    or not found
    or payment_supplier_id <> payable.supplier_id
  then
    raise exception using
      errcode = '23514',
      message = 'SUPPLIER_PURCHASE_MISMATCH: La aplicación y la obligación pertenecen a proveedores distintos.';
  end if;

  perform public.validate_supplier_purchase_integrity_v1(
    payable.supplier_id,
    payable.purchase_id,
    payable.supplier_invoice_id
  );
  return new;
end;
$function$;

drop trigger if exists supplier_invoices_purchase_integrity_v1
  on public.supplier_invoices;
create trigger supplier_invoices_purchase_integrity_v1
before insert or update of supplier_id, purchase_id
on public.supplier_invoices
for each row
execute function public.guard_supplier_invoice_purchase_integrity_v1();

drop trigger if exists accounts_payable_purchase_integrity_v1
  on public.accounts_payable;
create trigger accounts_payable_purchase_integrity_v1
before insert or update of supplier_id, purchase_id, supplier_invoice_id
on public.accounts_payable
for each row
execute function public.guard_accounts_payable_purchase_integrity_v1();

drop trigger if exists purchases_supplier_integrity_v1
  on public.purchases;
create trigger purchases_supplier_integrity_v1
before update of supplier_id
on public.purchases
for each row
execute function public.guard_purchase_supplier_change_v1();

drop trigger if exists supplier_payments_purchase_integrity_v1
  on public.supplier_payments;
create trigger supplier_payments_purchase_integrity_v1
before insert or update of accounts_payable_id, supplier_id
on public.supplier_payments
for each row
execute function public.guard_supplier_payment_purchase_integrity_v1();

drop trigger if exists supplier_payment_applications_purchase_integrity_v1
  on public.supplier_payment_applications;
create trigger supplier_payment_applications_purchase_integrity_v1
before insert or update of supplier_payment_id, accounts_payable_id
on public.supplier_payment_applications
for each row
execute function public.guard_supplier_payment_application_integrity_v1();

do $validation$
begin
  if exists (
    select 1
    from public.supplier_invoices invoice
    join public.purchases purchase on purchase.id = invoice.purchase_id
    where invoice.supplier_id <> purchase.supplier_id
  ) or exists (
    select 1
    from public.accounts_payable payable
    join public.purchases purchase on purchase.id = payable.purchase_id
    where payable.supplier_id <> purchase.supplier_id
  ) or exists (
    select 1
    from public.accounts_payable payable
    join public.supplier_invoices invoice
      on invoice.id = payable.supplier_invoice_id
    where payable.supplier_id <> invoice.supplier_id
  ) then
    raise exception using
      errcode = '23514',
      message = 'SUPPLIER_PURCHASE_MISMATCH: Existen relaciones cruzadas antes de activar los guards.';
  end if;
end;
$validation$;
