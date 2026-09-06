import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [
  migration,
  effectiveMigration,
  orderActions,
  receivablesManager,
  accountPage,
  importManager,
  importLabels,
  accountingDispatcher,
] = await Promise.all([
  read("supabase/migrations/202607140001_historical_receivable_payments_rpc.sql"),
  read("supabase/migrations/202607140002_direct_receivable_import_and_accountant_payments.sql"),
  read("src/app/admin/pedidos/actions.ts"),
  read("src/components/admin/accounts-receivable-manager.tsx"),
  read("src/app/cuenta/page.tsx"),
  read("src/components/admin/accounts-receivable-import-manager.tsx"),
  read("src/utils/import-labels.ts"),
  read("src/services/accounting/accounting-event-dispatcher.ts"),
]);

const withoutFunctionBody = migration.replace(/as \$\$[\s\S]*?\$\$;/, "as $$ function body omitted $$;");

assert.match(migration, /create or replace function public\.register_credit_receivable_payment\(/);
assert.match(migration, /security definer/);
assert.match(migration, /set search_path = public/);
assert.match(migration, /grant execute on function public\.register_credit_receivable_payment\(uuid, numeric, text, text, timestamptz, text, text, text, text\) to authenticated;/);
assert.doesNotMatch(withoutFunctionBody, /\b(alter|drop|truncate|update|delete|insert)\b/i);

assert.match(migration, /if actor_role_name not in \('technical_owner', 'business_owner', 'admin'\) then/);
assert.doesNotMatch(migration, /or not public\.has_permission\('credit:mark_paid'\) then/);
assert.match(migration, /raise exception 'No tienes permiso para registrar abonos de credito comercial\.'/);

assert.match(effectiveMigration, /create or replace function public\.register_credit_receivable_payment\(/);
assert.match(effectiveMigration, /if actor_id is null or not public\.has_permission\('credit:mark_paid'\) then/);
assert.doesNotMatch(effectiveMigration, /if actor_role_name not in \('technical_owner', 'business_owner', 'admin'\) then/);
assert.match(effectiveMigration, /when unique_violation then[\s\S]*where idempotency_key = normalized_request_key[\s\S]*payment_id := saved_payment\.id;[\s\S]*return next;/);
assert.match(effectiveMigration, /customer\.commercial_credit\.payment_registered:' \|\| saved_payment\.id::text/);
assert.match(effectiveMigration, /'credit-payment:' \|\| saved_payment\.id::text/);
assert.match(effectiveMigration, /left join public\.orders o on o\.id = ar\.order_id/);
assert.match(effectiveMigration, /security definer/);
assert.match(effectiveMigration, /set search_path = public/);
assert.match(effectiveMigration, /grant execute on function public\.register_credit_receivable_payment\(uuid, numeric, text, text, timestamptz, text, text, text, text\) to authenticated;/);

assert.match(migration, /when unique_violation then/);
assert.match(migration, /when unique_violation then[\s\S]*where idempotency_key = normalized_request_key[\s\S]*payment_id := saved_payment\.id;[\s\S]*return next;/);
assert.match(migration, /case when remaining_balance = 0 then 'customer\.commercial_credit\.paid_complete' else 'customer\.commercial_credit\.payment_registered:' \|\| saved_payment\.id::text end,/);
assert.match(migration, /case when remaining_balance = 0 then 'commercial_credit\.paid_complete' else 'commercial_credit\.payment_registered:' \|\| saved_payment\.id::text end,/);
assert.match(migration, /case when remaining_balance = 0 then 'commercial_credit\.paid_complete' else 'commercial_credit\.payment_registered' end,/);
assert.match(migration, /'credit-payment:' \|\| saved_payment\.id::text/);
assert.match(migration, /'credit-payment-internal:' \|\| saved_payment\.id::text/);
assert.doesNotMatch(migration, /insert into public\.orders/i);
assert.doesNotMatch(migration, /insert into public\.journal_entries/i);

assert.match(migration, /left join public\.orders o on o\.id = ar\.order_id/);
assert.doesNotMatch(migration, /\n\s*join public\.orders o on o\.id = ar\.order_id/);
assert.match(migration, /receivable_kind := case when receivable_row\.order_id is null then 'historical' else 'normal' end;/);
assert.match(migration, /receivable_label := coalesce\(/);
assert.match(migration, /values \(\s*receivable_row\.id,\s*receivable_row\.customer_id,\s*receivable_row\.order_id,/);
assert.match(migration, /if receivable_row\.order_id is not null then\s*update public\.payments/);
assert.match(migration, /El abono no puede ser mayor que el saldo pendiente de esta cuenta por cobrar\./);
assert.match(migration, /'receivable_kind', receivable_kind/);
assert.match(migration, /'source', 'admin_accounts_receivable'/);

assert.match(orderActions, /rpc\("register_credit_receivable_payment"/);
assert.match(orderActions, /findLatestReceivablePaymentOutboxId/);
assert.match(orderActions, /processReceivablePaymentAccountingOutbox/);
assert.match(orderActions, /sourceType: "accounts_receivable"/);
assert.match(orderActions, /eventPurpose: "receivable_paid"/);

assert.match(receivablesManager, /row\.status !== "paid" && row\.status !== "cancelled" && row\.balance_due > 0/);
assert.match(receivablesManager, /saldo pendiente de esta cuenta por cobrar/);
assert.match(receivablesManager, /Cuenta histórica/);
assert.doesNotMatch(receivablesManager, /saldo pendiente de este pedido/);

assert.match(accountPage, /creditReceivables\.length > 0/);
assert.match(accountPage, /No representan una nueva línea de crédito/);
assert.match(accountPage, /const openReceivables = creditReceivables\.filter\(\(item\) => item\.status !== "paid" && item\.status !== "cancelled" && item\.balance_due > 0\)/);
assert.match(accountPage, /const paidReceivables = creditReceivables\.filter\(\(item\) => item\.status === "paid" \|\| item\.balance_due <= 0\)/);
assert.match(accountPage, /function ReceivablesList/);

for (const label of [
  "Total de filas",
  "Válidas",
  "Revisión requerida",
  "Con error",
  "Aplicadas",
  "Canceladas",
  "Revertidas",
  "Acción",
  "Monto original",
  "Abonado",
  "Saldo",
  "Importación",
  "Historial",
]) {
  assert.match(importManager, new RegExp(label));
}

for (const englishLabel of [
  "Total Rows",
  "Validated",
  "Pending Assignment",
  "Pending Confirmation",
  "Rows With Errors",
  "Ready To Apply",
  "Rollback Available",
  "Accion",
]) {
  assert.doesNotMatch(importManager, new RegExp(englishLabel));
}

assert.match(importLabels, /pending_assignment: "Pendiente de asignación"/);
assert.match(importLabels, /ready: "Listo para aplicar"/);
assert.match(importLabels, /applied:/);
assert.match(importLabels, /cancelled:/);
assert.match(importLabels, /rolled_back:/);
assert.match(importManager, /row\.assignment_status!=="confirmed"/);
assert.match(importManager, /Revisión requerida/);
assert.match(importManager, /row\.apply_status==="applied"/);
assert.match(importManager, /row\.apply_status==="rolled_back"/);

assert.match(accountingDispatcher, /order_id: string \| null;/);
assert.match(accountingDispatcher, /historical_invoice_number: string \| null;/);
assert.match(accountingDispatcher, /sourceNumber: row\.orders\?\.order_number \?\? row\.historical_invoice_number \?\? row\.id/);
assert.match(accountingDispatcher, /historical_invoice_number: row\.historical_invoice_number/);

console.log("Historical receivable payment structure checks passed.", {
  rpcSupportsNullOrderId: true,
  portalShowsReceivablesWithoutCreditLine: true,
  importLabelsSpanish: true,
  noMigrationTimeDataDml: true,
  currentRpcPatchesPreserved: true,
});
