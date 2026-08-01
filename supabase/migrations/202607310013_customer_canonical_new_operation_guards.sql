-- New fiscal and commercial operations may reference only active canonical customers.
-- Existing rows are not rewritten.

create trigger orders_canonical_customer_guard
before insert or update of customer_id on public.orders
for each row execute function public.guard_canonical_customer_reference_v1();

create trigger payments_canonical_customer_guard
before insert or update of customer_id on public.payments
for each row execute function public.guard_canonical_customer_reference_v1();

create trigger invoices_canonical_customer_guard
before insert or update of customer_id on public.invoices
for each row execute function public.guard_canonical_customer_reference_v1();
