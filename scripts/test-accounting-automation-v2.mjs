import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const [
  base,
  sales,
  supplier,
  hardening,
  orderActions,
  checkoutActions,
  payableActions,
  payableUi,
  worker,
  centerService,
  centerUi,
  vercelConfig,
  cronRoute,
  cronJob,
] = await Promise.all([
  read("supabase/migrations/202607280002_accounting_outbox_v2.sql"),
  read("supabase/migrations/202607280003_sales_cogs_accounting_v2.sql"),
  read("supabase/migrations/202607280004_supplier_payment_accounting_v2.sql"),
  read("supabase/migrations/202607280005_supplier_payment_method_hardening.sql"),
  read("src/app/admin/pedidos/actions.ts"),
  read("src/app/checkout/actions.ts"),
  read("src/app/admin/cuentas-por-pagar/actions.ts"),
  read("src/components/admin/accounts-payable-manager.tsx"),
  read("src/services/accounting/accounting-outbox-v2.ts"),
  read("src/services/supabase/financial-center.service.ts"),
  read("src/components/admin/financial-center-manager.tsx"),
  read("vercel.json"),
  read("src/app/api/cron/process-accounting-outbox-v2/route.ts"),
  read("src/lib/accounting/cron-jobs.ts"),
]);

const mustContain = (text, values, contract) => {
  for (const value of values) {
    assert.ok(text.includes(value), `${contract}: missing ${value}`);
  }
};

mustContain(base, [
  "sales_draft_v2",
  "cogs_draft_v2",
  "supplier_payment_draft_v2",
  "'disabled'",
  "'shadow'",
  "'enabled'",
  "accounting_shadow_observations",
  "accounting_outbox_v2",
  "constraint accounting_outbox_v2_fact_unique unique",
  "constraint accounting_outbox_v2_idempotency_unique unique",
  "'pending_mapping'",
  "'pending_data'",
  "'shadow_validated'",
  "occurred_at >= cutover_at",
  "retry_accounting_outbox_v2",
  "accounting:manage",
], "base outbox");
assert.ok(!/update\s+public\.accounting_automation_settings/i.test(base), "V2 must not change automation_mode.");

mustContain(sales, [
  "payments_enqueue_sale_recognition_v2",
  "orders_enqueue_credit_sale_on_delivery_v2",
  "inventory_movements_enqueue_cogs_v2",
  "'sale_recognized'",
  "'inventory_cogs'",
  "commercial_credit_on_delivery",
  "cash_or_cod_after_delivery",
  "new.quantity >= 0",
  "new.stock_after >= new.stock_before",
  "new.reference_type <> 'orders'",
  "cancel_accounting_fact_v2",
  "'accounting.compensation'",
  "status = 'anulada'",
], "sales and COGS routing");
assert.ok(!sales.includes("invoice_issued"), "Invoice issuance must not recognize V2 income.");

mustContain(supplier, [
  "register_supplier_payment_v2",
  "void_supplier_payment_v2",
  "request_fingerprint",
  "pg_advisory_xact_lock",
  "supplier_payments_enqueue_accounting_v2",
  "process_accounting_outbox_v2",
  "for update skip locked",
  "interval '15 minutes'",
  "max_attempts",
  "power(2",
  "'sale_shipping_fee'",
  "'sale_cod_fee'",
  "'sale_external_charge'",
  "'sale_other_charge'",
  "'supplier_payment_card'",
  "when 'card_debit' then 'supplier_payment_bank'",
  "movement.total_cost_snapshot",
  "public.calculate_sale_financials_v1",
  "'borrador'",
  "'manual_publication_required', true",
], "worker and supplier payments");
assert.ok(!/set\s+status\s*=\s*'publicada'/i.test(supplier), "Normal V2 worker must never publish a journal entry.");

mustContain(hardening, [
  "require_supplier_payment_method_v2",
  "'cash', 'bank_transfer', 'card_credit', 'card_debit'",
  "revoke all on function public.register_supplier_payment(",
  "repair_existing_supplier_card_payment_v1",
  "'pending_dependency'",
  "recognized_liability < 73200.00",
  "date '2026-07-12'",
  "'supplier_payment_card'",
  "'manual_publication_required', true",
], "method hardening and directed repair");

mustContain(payableActions, [
  'rpc("register_supplier_payment_v2"',
  "idempotency_key",
  "processAccountingOutboxV2",
  'rpc("void_supplier_payment_v2"',
], "payables server actions");
assert.ok(!payableActions.includes('rpc("register_supplier_payment",'), "Free-text supplier RPC must not remain in the UI action.");

mustContain(payableUi, [
  "globalThis.crypto.randomUUID()",
  'option value="cash"',
  'option value="bank_transfer"',
  'option value="card_credit"',
  'option value="card_debit"',
  "voidKeysRef",
  "disabled={!canManage || isPending}",
], "payables UI");
assert.ok(!payableUi.includes('placeholder="Transferencia, cheque, efectivo"'), "Free-text payment method input must be removed.");

mustContain(orderActions, [
  "processAccountingOutboxesForOrderV2",
], "order worker handoff");
assert.ok(!orderActions.includes("dispatchPaymentReceivedAccountingEventForOrder"), "Approved web sales must not dispatch payment_received/v1.");
assert.ok(!orderActions.includes('eventPurpose: "sale_revenue"'), "Order confirmation must not dispatch sale_revenue/v1.");
assert.ok(!checkoutActions.includes("dispatchCommercialCreditAccountingEventForOrder"), "Credit checkout must not recognize revenue before delivery.");

mustContain(worker, [
  'import "server-only"',
  "getSupabaseAdminClient",
  "process_accounting_outbox_v2",
  "claim_due_accounting_outbox_v2",
], "server-only worker");

mustContain(centerService, [
  "accounting_feature_flags",
  "accounting_outbox_v2",
  "sale_shipping_fee",
  "sale_cod_fee",
  "sale_external_charge",
  "sale_other_charge",
], "financial center data");
mustContain(centerUi, [
  "Ventas V2",
  "COGS V2",
  "Proveedores V2",
  "Duplicado evitado",
  "Evento compensatorio",
  "Reintentar V2",
  "Corte:",
], "financial center UI");

mustContain(vercelConfig, ["/api/cron/process-accounting-outbox-v2", "*/5 * * * *"], "V2 recovery schedule");
mustContain(cronRoute, ["runProtectedCronJob", "processAccountingOutboxV2Job"], "protected V2 cron route");
mustContain(cronJob, ["processDueAccountingOutboxesV2(20)", "pendingMapping", "pendingData"], "bounded V2 cron worker");

console.log("Accounting automation V2 structural contracts: OK");
