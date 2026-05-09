alter table public.payments
  add column if not exists payment_method public.payment_method,
  add column if not exists bank_reference_number text,
  add column if not exists transfer_receipt_url text,
  add column if not exists payment_status public.payment_status;

update public.payments
set
  payment_method = coalesce(payment_method, method),
  payment_status = coalesce(payment_status, status),
  bank_reference_number = coalesce(bank_reference_number, reference)
where payment_method is null
   or payment_status is null
   or bank_reference_number is null;

alter table public.payments
  alter column payment_method set default 'bank_transfer',
  alter column payment_method set not null,
  alter column payment_status set default 'pending',
  alter column payment_status set not null,
  alter column method set default 'bank_transfer',
  alter column status set default 'pending';

create or replace function public.sync_payment_transfer_fields()
returns trigger
language plpgsql
as $$
begin
  new.payment_method := coalesce(new.payment_method, new.method, 'bank_transfer');
  new.method := coalesce(new.method, new.payment_method);
  new.payment_status := coalesce(new.payment_status, new.status, 'pending');
  new.status := coalesce(new.status, new.payment_status);
  new.bank_reference_number := coalesce(new.bank_reference_number, new.reference);
  new.reference := coalesce(new.reference, new.bank_reference_number);
  return new;
end;
$$;

drop trigger if exists sync_payment_transfer_fields_trigger on public.payments;

create trigger sync_payment_transfer_fields_trigger
before insert or update on public.payments
for each row
execute function public.sync_payment_transfer_fields();

alter table public.payments
  drop constraint if exists payments_bank_reference_required_for_transfer;

alter table public.payments
  add constraint payments_bank_reference_required_for_transfer
  check (
    payment_method <> 'bank_transfer'
    or length(trim(coalesce(bank_reference_number, ''))) > 0
  ) not valid;

create index if not exists payments_payment_method_idx on public.payments(payment_method);
create index if not exists payments_payment_status_idx on public.payments(payment_status);
create index if not exists payments_bank_reference_number_idx on public.payments(bank_reference_number);

comment on column public.payments.payment_method is 'Metodo de pago normalizado. Para transferencias usar bank_transfer.';
comment on column public.payments.bank_reference_number is 'Numero de referencia bancaria. Obligatorio solo cuando payment_method = bank_transfer.';
comment on column public.payments.transfer_receipt_url is 'URL opcional del comprobante de transferencia.';
comment on column public.payments.payment_status is 'Estado normalizado del pago.';
