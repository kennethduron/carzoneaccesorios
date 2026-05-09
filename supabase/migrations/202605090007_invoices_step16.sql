alter type public.invoice_status add value if not exists 'emitida';
alter type public.invoice_status add value if not exists 'anulada';

alter table public.invoices
  add column if not exists rtn text,
  add column if not exists cai text,
  add column if not exists customer_rtn text,
  add column if not exists cancelled_at timestamptz;

create index if not exists invoices_invoice_number_status_idx on public.invoices(invoice_number, status);
create index if not exists invoices_rtn_idx on public.invoices(rtn);
create index if not exists invoices_cai_idx on public.invoices(cai);
