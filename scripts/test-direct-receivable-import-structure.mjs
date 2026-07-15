import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
const [migration, service, actions, manager, page, orderActions, permissions, creditService, localPaymentTest] = await Promise.all([
  read("supabase/migrations/202607140002_direct_receivable_import_and_accountant_payments.sql"),
  read("src/services/supabase/accounts-receivable-import.service.ts"),
  read("src/app/admin/cuentas-por-cobrar/actions.ts"),
  read("src/components/admin/accounts-receivable-import-manager.tsx"),
  read("src/app/admin/cuentas-por-cobrar/page.tsx"),
  read("src/app/admin/pedidos/actions.ts"),
  read("src/lib/auth/permissions.ts"),
  read("src/services/supabase/credit.service.ts"),
  read("scripts/test-historical-receivable-payments-local.mjs"),
]);

assert.match(migration, /add column if not exists import_dedupe_key text/);
assert.match(migration, /create unique index if not exists accounts_receivable_import_dedupe_key_idx/);
assert.match(migration, /extensions\.digest\([\s\S]*?'sha256'/);
assert.match(migration, /alter column phone drop not null/);
assert.doesNotMatch(migration, /update public\.customers/i);
assert.doesNotMatch(migration, /insert into auth\.users/i);
assert.doesNotMatch(migration, /insert into public\.customer_credit_accounts/i);
assert.match(migration, /where name = 'contadora'/);
assert.match(migration, /\["credit:mark_paid"\]/);
assert.doesNotMatch(migration, /where name = 'contadora'[\s\S]{0,300}credit:manage/);
assert.match(migration, /if actor_id is null or not public\.has_permission\('credit:mark_paid'\) then/);
assert.doesNotMatch(migration, /if actor_role_name not in \('technical_owner', 'business_owner', 'admin'\) then/);

assert.match(migration, /create or replace function public\.preview_historical_accounts_receivable_import/);
assert.match(migration, /create or replace function public\.confirm_and_apply_receivable_import_batch/);
assert.match(migration, /has_import_foundation_permission\('accounts_receivable', 'apply'\)/);
assert.match(migration, /if target_batch\.status = 'cancelled'/);
assert.match(migration, /Este lote fue cancelado\. Corrige el archivo y vuelve a importarlo\./);
assert.match(migration, /for update/);
assert.match(migration, /exception[\s\S]*when unique_violation/);
assert.match(migration, /pg_advisory_xact_lock/);
assert.match(migration, /resolution_row\.resolution = 'ambiguous'/);
assert.match(migration, /resolution_row\.resolution = 'review_required'/);
assert.match(migration, /Completa RTN, correo o teléfono, o selecciona un cliente existente/);
assert.match(migration, /'historical-ar-import:' \|\| dedupe_key/);
assert.match(migration, /import_dedupe_key = dedupe_key/);
assert.match(migration, /'receivable_kind', 'historical'/);
assert.doesNotMatch(migration, /insert into public\.orders/i);
assert.doesNotMatch(migration, /insert into public\.journal_entries/i);

assert.match(migration, /when unique_violation then[\s\S]*where idempotency_key = normalized_request_key/);
assert.match(migration, /saved_payment\.id/);
assert.match(migration, /customer\.commercial_credit\./);
assert.match(migration, /left join public\.orders o on o\.id = ar\.order_id/);
assert.match(migration, /grant execute on function public\.register_credit_receivable_payment/);

assert.match(service, /preview_historical_accounts_receivable_import/);
assert.match(service, /confirm_and_apply_receivable_import_batch/);
assert.match(service, /updateHistoricalReceivableImportIdentity/);
assert.match(actions, /updateHistoricalReceivableIdentityAction/);
assert.match(actions, /summary\.created_receivables/);
assert.match(manager, /Confirmar e importar cuentas por cobrar/);
assert.match(manager, /Importando cuentas por cobrar\.\.\./);
assert.match(manager, /Completar identidad/);
assert.match(manager, /Próximo paso/);
for (const label of ["Válidas", "Crearán cliente", "Reutilizarán cliente", "Ambiguas", "Duplicadas", "Con error", "Canceladas"]) {
  assert.match(manager, new RegExp(label));
}
assert.match(manager, /sticky right-0/);
assert.match(manager, /md:hidden/);
assert.match(migration, /seen_create_identities/);
assert.match(migration, /seen_preview_debts/);
assert.match(manager, /setApplyConfirmationOpen\(true\)/);
assert.match(page, /const canMarkPaid = hasEffectivePermission/);
assert.doesNotMatch(page, /\["technical_owner", "business_owner", "admin"\]\.includes\(profile\.role\)[\s\S]{0,100}credit:mark_paid/);
assert.match(orderActions, /return hasEffectivePermission\(role, permissions, "credit:mark_paid", email\)/);
assert.match(permissions, /contadora:[\s\S]*?"credit:read"[\s\S]*?"credit:mark_paid"/);
assert.match(creditService, /historical_invoice_number,[\s\S]*accounts_receivable_payments/);
assert.match(localPaymentTest, /car-zone-phase-a-postgres/);

console.log("Direct receivable import structure checks passed.", {
  safeMatching: true,
  customerWithoutAuth: true,
  receivableDedupe: true,
  explicitConfirmation: true,
  accountantPayments: true,
  cancelledBatchesBlocked: true,
  noAutoPost: true,
});
