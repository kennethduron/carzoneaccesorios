-- Supplier multi-invoice payment core.
-- Prospective only: legacy payments stay linked to their original payable and
-- no historical row, balance, fingerprint, event or journal entry is rebuilt.

alter table public.supplier_payments
  add column if not exists allocation_mode text not null default 'legacy_single',
  add column if not exists currency text not null default 'HNL',
  add column if not exists reference text,
  add column if not exists payment_account_id uuid
    references public.accounting_accounts(id) on delete restrict,
  add column if not exists receipt_public_id text;

alter table public.supplier_payments
  alter column accounts_payable_id drop not null,
  drop constraint if exists supplier_payments_allocation_mode_check,
  add constraint supplier_payments_allocation_mode_check check (
    allocation_mode in ('legacy_single', 'applications_v1')
  ),
  drop constraint if exists supplier_payments_allocation_contract_check,
  add constraint supplier_payments_allocation_contract_check check (
    (allocation_mode = 'legacy_single' and accounts_payable_id is not null)
    or
    (allocation_mode = 'applications_v1' and accounts_payable_id is null)
  ),
  drop constraint if exists supplier_payments_currency_hnl_check,
  add constraint supplier_payments_currency_hnl_check check (
    currency = 'HNL'
  ),
  drop constraint if exists supplier_payments_reference_check,
  add constraint supplier_payments_reference_check check (
    reference is null
    or (
      char_length(reference) between 1 and 160
      and reference = regexp_replace(btrim(reference), '\s+', ' ', 'g')
    )
  ),
  drop constraint if exists supplier_payments_bank_reference_check,
  add constraint supplier_payments_bank_reference_check check (
    allocation_mode <> 'applications_v1'
    or payment_method_v2 <> 'bank_transfer'
    or reference is not null
  ),
  drop constraint if exists supplier_payments_receipt_public_id_check,
  add constraint supplier_payments_receipt_public_id_check check (
    receipt_public_id is null
    or char_length(receipt_public_id) between 1 and 240
  ),
  drop constraint if exists supplier_payments_idempotency_length_check,
  add constraint supplier_payments_idempotency_length_check check (
    (idempotency_key is null or char_length(idempotency_key) between 8 and 200)
    and (
      request_fingerprint is null
      or char_length(request_fingerprint) in (32, 64)
    )
    and (
      void_idempotency_key is null
      or char_length(void_idempotency_key) between 8 and 200
    )
    and (
      void_request_fingerprint is null
      or char_length(void_request_fingerprint) in (32, 64)
    )
  );

create table public.supplier_payment_applications (
  id uuid primary key default gen_random_uuid(),
  supplier_payment_id uuid not null
    references public.supplier_payments(id) on delete restrict,
  accounts_payable_id uuid not null
    references public.accounts_payable(id) on delete restrict,
  supplier_invoice_id uuid
    references public.supplier_invoices(id) on delete restrict,
  applied_amount numeric(12, 2) not null,
  currency text not null,
  balance_before numeric(12, 2) not null,
  balance_after numeric(12, 2) not null,
  status_before text not null,
  status_after text not null,
  recognition_origin text not null,
  recognition_journal_entry_id uuid not null
    references public.journal_entries(id) on delete restrict,
  opening_balance_batch_id uuid
    references public.accounting_opening_balance_batches(id) on delete restrict,
  recognition_date date not null,
  status text not null default 'applied',
  voided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint supplier_payment_applications_payment_payable_key
    unique (supplier_payment_id, accounts_payable_id),
  constraint supplier_payment_applications_amount_positive
    check (applied_amount > 0),
  constraint supplier_payment_applications_balance_contract
    check (
      balance_before >= applied_amount
      and balance_after = balance_before - applied_amount
    ),
  constraint supplier_payment_applications_currency_hnl
    check (currency = 'HNL'),
  constraint supplier_payment_applications_status_before_check
    check (status_before in ('pending', 'partial', 'overdue')),
  constraint supplier_payment_applications_status_after_check
    check (status_after in ('partial', 'paid')),
  constraint supplier_payment_applications_recognition_origin_check
    check (recognition_origin in ('direct_event', 'opening_balance_control')),
  constraint supplier_payment_applications_status_check
    check (status in ('applied', 'voided')),
  constraint supplier_payment_applications_void_contract
    check (
      (status = 'applied' and voided_at is null)
      or
      (status = 'voided' and voided_at is not null)
    )
);

create or replace function public.guard_supplier_payment_application_history_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using
      errcode = '55000',
      message = 'Las aplicaciones de pago no se eliminan.';
  end if;

  if (
    to_jsonb(new) - 'status' - 'voided_at'
  ) is distinct from (
    to_jsonb(old) - 'status' - 'voided_at'
  ) then
    raise exception using
      errcode = '55000',
      message = 'Los snapshots economicos de una aplicacion son inmutables.';
  end if;

  if old.status = 'voided'
    or new.status <> 'voided'
    or old.voided_at is not null
    or new.voided_at is null
  then
    raise exception using
      errcode = '55000',
      message = 'La aplicacion solo admite la transicion applied a voided.';
  end if;

  return new;
end;
$$;

revoke all on function
  public.guard_supplier_payment_application_history_v1()
  from public, anon, authenticated;

create trigger supplier_payment_applications_guard_update
before update on public.supplier_payment_applications
for each row execute function
  public.guard_supplier_payment_application_history_v1();

create trigger supplier_payment_applications_guard_delete
before delete on public.supplier_payment_applications
for each row execute function
  public.guard_supplier_payment_application_history_v1();

create or replace function public.assert_supplier_payment_allocation_v1()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_payment_id uuid;
  payment public.supplier_payments%rowtype;
  active_count integer;
  total_count integer;
  active_total numeric(12, 2);
  historical_total numeric(12, 2);
begin
  if tg_table_name = 'supplier_payments' then
    target_payment_id := coalesce(new.id, old.id);
  else
    target_payment_id :=
      coalesce(new.supplier_payment_id, old.supplier_payment_id);
  end if;

  select * into payment
  from public.supplier_payments
  where id = target_payment_id;

  if payment.id is null or payment.allocation_mode <> 'applications_v1' then
    return null;
  end if;

  select
    count(*) filter (where application.status = 'applied'),
    count(*),
    coalesce(
      sum(application.applied_amount)
        filter (where application.status = 'applied'),
      0
    ),
    coalesce(sum(application.applied_amount), 0)
  into active_count, total_count, active_total, historical_total
  from public.supplier_payment_applications application
  where application.supplier_payment_id = payment.id;

  if payment.status = 'paid' then
    if active_count < 1 or active_total <> payment.amount then
      raise exception using
        errcode = '23514',
        message = 'La suma activa de aplicaciones debe ser exactamente igual al pago.';
    end if;
  elsif payment.status = 'voided' then
    if total_count < 1
      or active_count <> 0
      or historical_total <> payment.amount
    then
      raise exception using
        errcode = '23514',
        message = 'Una anulacion debe conservar y anular todas las aplicaciones del pago.';
    end if;
  else
    raise exception using
      errcode = '23514',
      message = 'Una cabecera applications_v1 no puede quedar en estado transitorio.';
  end if;

  return null;
end;
$$;

revoke all on function public.assert_supplier_payment_allocation_v1()
  from public, anon, authenticated;

create constraint trigger supplier_payments_allocation_total_v1
after insert on public.supplier_payments
deferrable initially deferred
for each row
when (new.allocation_mode = 'applications_v1')
execute function public.assert_supplier_payment_allocation_v1();

create constraint trigger supplier_payments_allocation_update_v1
after update on public.supplier_payments
deferrable initially deferred
for each row
when (
  new.allocation_mode = 'applications_v1'
  or old.allocation_mode = 'applications_v1'
)
execute function public.assert_supplier_payment_allocation_v1();

create constraint trigger supplier_payment_applications_total_v1
after insert or update or delete on public.supplier_payment_applications
deferrable initially deferred
for each row execute function public.assert_supplier_payment_allocation_v1();

create index supplier_payments_supplier_paid_id_v1_idx
  on public.supplier_payments (supplier_id, paid_at desc, id);

create index supplier_payment_applications_payable_created_v1_idx
  on public.supplier_payment_applications (
    accounts_payable_id,
    created_at desc
  );

create index accounts_payable_open_supplier_due_v1_idx
  on public.accounts_payable (supplier_id, due_date, id)
  where status in ('pending', 'partial', 'overdue') and balance > 0;

create or replace view public.supplier_payment_allocations_v1
with (security_invoker = true)
as
select
  application.id as application_id,
  payment.id as supplier_payment_id,
  payment.allocation_mode,
  payment.supplier_id,
  application.accounts_payable_id,
  application.supplier_invoice_id,
  application.applied_amount,
  application.currency,
  application.balance_before,
  application.balance_after,
  application.status_before,
  application.status_after,
  application.recognition_origin,
  application.recognition_journal_entry_id,
  application.opening_balance_batch_id,
  application.recognition_date,
  application.status as application_status,
  application.voided_at,
  application.created_at
from public.supplier_payment_applications application
join public.supplier_payments payment
  on payment.id = application.supplier_payment_id
union all
select
  payment.id as application_id,
  payment.id as supplier_payment_id,
  payment.allocation_mode,
  payment.supplier_id,
  payment.accounts_payable_id,
  payable.supplier_invoice_id,
  payment.amount as applied_amount,
  payment.currency,
  null::numeric(12, 2) as balance_before,
  null::numeric(12, 2) as balance_after,
  null::text as status_before,
  null::text as status_after,
  null::text as recognition_origin,
  null::uuid as recognition_journal_entry_id,
  null::uuid as opening_balance_batch_id,
  null::date as recognition_date,
  case when payment.status = 'voided' then 'voided' else 'applied' end,
  payment.voided_at,
  payment.created_at
from public.supplier_payments payment
join public.accounts_payable payable
  on payable.id = payment.accounts_payable_id
where payment.allocation_mode = 'legacy_single';

comment on view public.supplier_payment_allocations_v1 is
  'Canonical read-only allocation surface: stored applications_v1 rows plus synthetic legacy_single allocations; no backfill.';

alter table public.supplier_payment_applications enable row level security;

create policy supplier_payment_applications_select
  on public.supplier_payment_applications
  for select
  using (
    public.has_permission('payables:read')
    or public.has_permission('payables:manage')
  );

grant select on public.supplier_payment_applications to authenticated;
grant select on public.supplier_payment_allocations_v1 to authenticated;
grant select, insert, update, delete
  on public.supplier_payment_applications to service_role;
grant select on public.supplier_payment_allocations_v1 to service_role;

revoke insert, update, delete
  on public.supplier_payments from authenticated;
revoke insert, update, delete
  on public.supplier_payment_applications from authenticated;

alter table public.accounting_feature_flags
  drop constraint if exists accounting_feature_flags_key_check,
  add constraint accounting_feature_flags_key_check check (
    key in (
      'sales_draft_v2',
      'cogs_draft_v2',
      'supplier_payment_draft_v2',
      'supplier_multi_invoice_payment_v1'
    )
  );

insert into public.accounting_feature_flags (
  key,
  state,
  version,
  notes
)
values (
  'supplier_multi_invoice_payment_v1',
  'disabled',
  'v2',
  'Prospective multi-invoice supplier-payment registration and UI; no historical backfill.'
)
on conflict (key) do nothing;
