create or replace function public.advance_fiscal_invoice_number(expected_invoice_number text, next_invoice_number text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (
    public.has_permission('invoices:create')
    or public.has_permission('invoices:manage')
    or public.has_permission('settings:manage')
  ) then
    raise exception 'Permission denied';
  end if;

  update public.fiscal_settings
  set
    current_invoice_number = next_invoice_number,
    updated_at = now()
  where id = true
    and current_invoice_number = expected_invoice_number;

  if not found then
    raise exception 'Fiscal invoice number changed before update';
  end if;
end;
$$;

grant execute on function public.advance_fiscal_invoice_number(text, text) to authenticated;
