import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");
const [phaseA, adjustment, service, actions, manager, detailManager, page, orderActions, permissions, creditService, profileSync, localPaymentTest] = await Promise.all([
  read("supabase/migrations/202607140002_direct_receivable_import_and_accountant_payments.sql"),
  read("supabase/migrations/202607140003_optional_customer_identity_for_receivable_import.sql"),
  read("src/services/supabase/accounts-receivable-import.service.ts"),
  read("src/app/admin/cuentas-por-cobrar/actions.ts"),
  read("src/components/admin/accounts-receivable-import-manager.tsx"),
  read("src/components/admin/accounts-receivable-manager.tsx"),
  read("src/app/admin/cuentas-por-cobrar/page.tsx"),
  read("src/app/admin/pedidos/actions.ts"),
  read("src/lib/auth/permissions.ts"),
  read("src/services/supabase/credit.service.ts"),
  read("src/lib/auth/profile-sync.ts"),
  read("scripts/test-historical-receivable-payments-local.mjs"),
]);

assert.match(phaseA, /add column if not exists import_dedupe_key text/);
assert.match(phaseA, /create unique index if not exists accounts_receivable_import_dedupe_key_idx/);
assert.match(phaseA, /where name = 'contadora'/);
assert.match(phaseA, /\["credit:mark_paid"\]/);
assert.doesNotMatch(phaseA, /where name = 'contadora'[\s\S]{0,300}credit:manage/);
assert.match(phaseA, /if actor_id is null or not public\.has_permission\('credit:mark_paid'\) then/);
assert.doesNotMatch(phaseA, /if actor_role_name not in \('technical_owner', 'business_owner', 'admin'\) then/);
assert.match(phaseA, /when unique_violation then[\s\S]*where idempotency_key = normalized_request_key/);
assert.match(phaseA, /saved_payment\.id/);
assert.match(phaseA, /customer\.commercial_credit\./);
assert.match(phaseA, /left join public\.orders o on o\.id = ar\.order_id/);
assert.match(phaseA, /grant execute on function public\.register_credit_receivable_payment/);

assert.match(adjustment, /alter column phone drop not null/);
assert.match(adjustment, /alter column email drop not null/);
assert.match(adjustment, /alter column tax_id drop not null/);
assert.match(adjustment, /alter column user_id drop not null/);
assert.match(adjustment, /historical_receivable_import_key text/);
assert.match(adjustment, /imported_from_receivable_row_id uuid references public\.import_rows/);
assert.match(adjustment, /create unique index if not exists customers_historical_receivable_import_key_idx/);
assert.match(adjustment, /receivable_import_customer_source_key/);
assert.match(adjustment, /receivable-import-source:/);
assert.match(adjustment, /is_generic_receivable_import_reference/);
assert.match(adjustment, /source_key,[\s\S]*row_item\.row_number/);
assert.match(adjustment, /Se creará un cliente operativo sin cuenta web\. RTN, correo y teléfono son opcionales\./);
assert.doesNotMatch(adjustment, /Completa RTN, correo o teléfono, o selecciona un cliente existente/);
assert.match(adjustment, /Se encontraron datos que apuntan a clientes diferentes\. Selecciona el cliente correcto\./);
assert.match(adjustment, /Se reutilizará el cliente existente\./);
assert.match(adjustment, /assignment_status = 'confirmed' and row_item\.assigned_customer_id is not null/);
assert.match(adjustment, /if target_batch\.status = 'cancelled'/);
assert.match(adjustment, /normalized_status = 'cancelled'[\s\S]*apply_status = 'skipped'/);
assert.match(adjustment, /for update/);
assert.match(adjustment, /exception[\s\S]*when unique_violation/);
assert.match(adjustment, /'historical-ar-import:' \|\| dedupe_key/);
assert.match(adjustment, /import_dedupe_key = dedupe_key/);
assert.match(adjustment, /'receivable_kind', 'historical'/);
assert.match(adjustment, /user_id,[\s\S]*values \([\s\S]*?null,/);
assert.match(adjustment, /source,[\s\S]*historical_receivable_import_key/);
assert.doesNotMatch(adjustment, /insert into auth\.users/i);
assert.doesNotMatch(adjustment, /insert into public\.customer_credit_accounts/i);
assert.doesNotMatch(adjustment, /insert into public\.orders/i);
assert.doesNotMatch(adjustment, /insert into public\.journal_entries/i);
assert.doesNotMatch(adjustment, /update public\.customers[\s\S]{0,250}user_id/i);

const authTrigger = adjustment.slice(adjustment.indexOf("create or replace function public.handle_new_user"), adjustment.indexOf("revoke all on function"));
assert.doesNotMatch(authTrigger, /(?:from|into|update) public\.customers/i);
const ensureRetailProfile = profileSync.slice(profileSync.indexOf("export async function ensureRetailProfile"), profileSync.indexOf("export async function getUserRole"));
assert.doesNotMatch(ensureRetailProfile, /pendingCustomer/);
assert.doesNotMatch(ensureRetailProfile, /\.is\("user_id", null\)/);
assert.doesNotMatch(ensureRetailProfile, /from\("customers"\)\.insert/);

assert.match(service, /preview_historical_accounts_receivable_import/);
assert.match(service, /confirm_and_apply_receivable_import_batch/);
assert.match(service, /updateHistoricalReceivableImportIdentity/);
assert.doesNotMatch(service, /Completa RTN, correo o teléfono para identificar al cliente/);
assert.match(actions, /updateHistoricalReceivableIdentityAction/);
assert.match(actions, /summary\.created_receivables/);
assert.match(manager, /Confirmar e importar cuentas por cobrar/);
assert.match(manager, /Importando cuentas por cobrar\.\.\./);
assert.match(manager, /Revisar datos/);
for (const label of ["Válidas", "Crearán cliente", "Reutilizarán cliente", "CxC por crear", "Revisión requerida", "Duplicadas", "Con error", "Canceladas"]) {
  assert.match(manager, new RegExp(label));
}
assert.match(manager, /Los clientes operativos no necesitan una cuenta web\. La vinculación con una cuenta del portal será manual y opcional\./);
assert.match(manager, /filas requieren revisión y no serán procesadas/);
assert.match(manager, /filas duplicadas serán omitidas/);
assert.match(manager, /filas con error serán omitidas/);
assert.match(manager, /filas canceladas no serán procesadas/);
assert.match(manager, /AccessibleSheet/);
assert.match(manager, /role="table"/);
assert.match(manager, /rowTotalPages/);
assert.doesNotMatch(manager, /sticky right-0/);
assert.doesNotMatch(manager, /min-w-\[1180px\]/);
assert.match(detailManager, /No registrado/);
assert.match(page, /const canMarkPaid = hasEffectivePermission/);
assert.doesNotMatch(page, /\["technical_owner", "business_owner", "admin"\]\.includes\(profile\.role\)[\s\S]{0,100}credit:mark_paid/);
assert.match(orderActions, /new Set<AppRole>\(\["technical_owner", "business_owner", "admin", "contadora"\]\)/);
assert.match(orderActions, /hasEffectivePermission\(role, permissions, "credit:mark_paid", email\)/);
assert.match(permissions, /contadora:[\s\S]*?"credit:read"[\s\S]*?"credit:mark_paid"/);
assert.match(creditService, /historical_invoice_number,[\s\S]*accounts_receivable_payments/);
assert.match(localPaymentTest, /car-zone-phase-a-postgres/);

console.log("Direct receivable import structure checks passed.", {
  optionalIdentity: true,
  nameOnlyCustomer: true,
  safeMatching: true,
  nameMatchingForbidden: true,
  manualSelectionPriority: true,
  stableCustomerIdentity: true,
  customerWithoutAuth: true,
  noAutomaticAuthLink: true,
  receivableDedupe: true,
  genericReferenceDedupe: true,
  explicitConfirmation: true,
  accountantPayments: true,
  cancelledRowsAndBatchesBlocked: true,
  noAutoPost: true,
});
