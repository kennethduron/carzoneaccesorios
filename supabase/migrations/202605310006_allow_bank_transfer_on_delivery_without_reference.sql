alter table public.payments
  drop constraint if exists payments_bank_reference_required_for_transfer;

alter table public.payments
  add constraint payments_bank_reference_required_for_transfer
  check (
    payment_method <> 'bank_transfer'
    or payment_timing = 'on_delivery'
    or trim(coalesce(bank_reference_number, '')) ~ '^[[:alnum:] -]{4,80}$'
  ) not valid;

comment on column public.payments.bank_reference_number is
  'Numero de referencia obligatorio para transferencia anticipada. Se captura despues de la entrega cuando payment_timing = on_delivery.';
