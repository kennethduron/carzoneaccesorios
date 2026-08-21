import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [migration, actions, manager, payables, paymentService, paymentWizard, page, accountRoute, accountCombobox] = await Promise.all([
  read("supabase/migrations/202608190001_manual_accounts_payable_recognition_v1.sql"),
  read("src/app/admin/cuentas-por-pagar/actions.ts"),
  read("src/components/admin/accounts-payable-manager.tsx"),
  read("src/services/supabase/payables.service.ts"),
  read("src/services/supabase/supplier-multi-payment.service.ts"),
  read("src/components/admin/supplier-multi-payment-wizard.tsx"),
  read("src/app/admin/cuentas-por-pagar/page.tsx"),
  read("src/app/api/admin/accounting/accounts/search/route.ts"),
  read("src/components/admin/accounting-account-combobox.tsx"),
]);

const contains = (text, values, label) => values.forEach((value) => assert.ok(text.includes(value), `${label}: missing ${value}`));

contains(migration, [
  "manual_accounts_payable_recognitions",
  "pending_accounting_recognition",
  "draft_pending_publication",
  "recognized",
  "blocked",
  "create_manual_accounts_payable_v1",
  "complete_manual_accounts_payable_recognition_v1",
  "search_manual_payable_debit_accounts_v1",
  "for update",
  "manual_ap_recognition_payable_unique",
  "manual_ap_recognition_event_unique",
  "manual_ap_recognition_journal_unique",
  "manual_ap_recognition_creation_request_unique",
  "manual_ap_recognition_completion_request_unique",
  "grant select on table public.manual_accounts_payable_recognitions",
  "auth.uid()",
  "current_actor_role()",
  "technical_owner",
  "business_owner",
  "admin",
  "contadora",
  "create_journal_draft_from_financial_event",
  "is_date_in_closed_accounting_period",
  "manual_debit_account_id",
  "manual_accounts_payable_recognition.completed",
  "No historical rows are backfilled",
], "migration contract");

for (const forbidden of [
  "update public.accounts_payable set total_amount",
  "delete from public.accounts_payable",
  "insert into public.journal_entries",
  "insert into public.journal_entry_lines",
  "post_journal_entry(",
  "EDGAR JOEL LEIVA PAZ",
]) assert.ok(!migration.toLowerCase().includes(forbidden.toLowerCase()), `migration contains forbidden behavior: ${forbidden}`);

contains(actions, [
  "requirePermission(\"payables:manage\")",
  "requirePermission(\"accounting:manage\")",
  "create_manual_accounts_payable_v1",
  "complete_manual_accounts_payable_recognition_v1",
  "RECOGNITION_MODE_REQUIRED",
  "FISCAL_BREAKDOWN_INVALID",
], "server actions");
contains(manager + payables, [
  "Guardar como pendiente",
  "Crear con reconocimiento",
  "Completar reconocimiento",
  "Partida por publicar",
  "Reconocimiento pendiente",
  "recognition_state",
], "hybrid UI");
contains(paymentService + paymentWizard, [
  "resolve_accounts_payable_payment_recognition_v2",
  "effective_payment_date",
  "payment_eligible",
  "Complete el reconocimiento contable antes de pagar",
  "Publique la partida de reconocimiento antes de pagar",
], "early payment eligibility");
contains(page, ["technical_owner", "business_owner", "admin", "contadora", "accounting:manage"], "role matrix");
contains(accountRoute + accountCombobox, ["manual-payable-debit", "normalBalance === \"debit\"", "asset", "cost", "expense"], "account selector filtering");

assert.ok(!migration.includes("grant execute") || migration.includes("to authenticated"), "RPC must use authenticated sessions");
assert.ok(!migration.includes("to anon"), "anonymous execution must not be granted");
assert.ok(!manager.includes("bg-yellow") && !manager.includes("bg-amber"), "workflow must use compact state UI, not persistent warning banners");

console.log("manual CxP recognition structural contract: PASS");
