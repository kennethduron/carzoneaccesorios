-- CAI emission deadlines are inclusive and must use the Honduras calendar day.
-- This prevents UTC from marking a CAI as expired before the day ends in Honduras.
alter function public.generate_fiscal_invoice_from_order(uuid)
  set timezone = 'America/Tegucigalpa';

comment on function public.generate_fiscal_invoice_from_order(uuid) is
  'Generates fiscal invoices. CAI emission deadline is inclusive and current_date is evaluated in America/Tegucigalpa.';
