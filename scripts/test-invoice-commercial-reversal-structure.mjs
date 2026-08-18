import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [migration, action, ui, adapter, repair, packageJson] = await Promise.all([
  read("supabase/migrations/202608170001_full_invoice_commercial_reversal.sql"),
  read("src/app/admin/facturas/actions.ts"),
  read("src/components/admin/admin-invoices-manager.tsx"),
  read("src/services/accounting/adapters/inventory-financial-events.ts"),
  read("scripts/auto-centro-ext100-commercial-reversal.mjs"),
  read("package.json"),
]);

const includesAll = (text, values, label) => {
  for (const value of values) assert.ok(text.includes(value), `${label}: missing ${value}`);
};

includesAll(migration, [
  "create unique index if not exists inventory_movements_sale_reversal_once_idx",
  "reversal_of_movement_id",
  "create table if not exists public.invoice_commercial_reversals",
  "invoice_commercial_reversals_append_only",
  "create or replace function public.cancel_sale_invoice_v1",
  "for update",
  "SALE_REVERSAL_REQUIRES_PAYMENT_REFUND",
  "SALE_REVERSAL_REQUIRES_RECEIVABLE_REFUND",
  "SALE_REVERSAL_UNLINKED_RETURN_EXISTS",
  "public.cancel_fiscal_invoice(invoice_row.id, normalized_reason)",
  "set status = 'cancelado', tracking_status = 'cancelado'",
  "commercial_reversal_invoice_id = invoice_row.id",
  "movement_type, quantity, stock_before, stock_after",
  "'return', abs(movement_row.quantity)",
  "public.accounts_receivable_payments",
  "public.accounting_outbox_v2",
  "sale.invoice.full_commercial_reversal",
  "p_recovery_mode",
  "SALE_REVERSAL_RECOVERY_LATER_MOVEMENT_FOUND",
  "SALE_REVERSAL_RECOVERY_PAYMENT_FOUND",
  "SALE_REVERSAL_RECOVERY_ACCOUNTING_MISMATCH",
  "revoke execute on function public.cancel_fiscal_invoice",
], "transactional migration");
assert.ok(/unique index[\s\S]+reversal_of_movement_id/i.test(migration));
assert.ok(!/update\s+public\.products\s+set\s+stock\s*=\s*4/i.test(migration), "No incident-specific stock patch is allowed.");
assert.ok(!/delete\s+from\s+public\.(orders|invoices|inventory_movements|accounts_receivable)/i.test(migration));

includesAll(action, [
  'rpc("cancel_sale_invoice_v1"',
  "p_recovery_mode: false",
  "Ningún cambio fue aplicado",
], "server action");
assert.ok(!action.includes('rpc("cancel_fiscal_invoice"'), "Operator action must not use fiscal-only primitive.");
assert.ok(!action.includes("dispatchAccountingEvent"), "Accounting cannot be a separate application-side call.");

includesAll(ui, [
  "Anular factura y revertir venta",
  "Los productos regresarán al inventario",
  "la CxC abierta se anulará",
  "los efectos contables se compensarán",
  "isPending || !canSubmit",
  "sm:flex",
  "max-w-xl",
], "operator UX");

includesAll(adapter, ["reversal_of_movement_id", "!row.reversal_of_movement_id"], "accounting duplicate guard");

includesAll(repair, [
  "--dry-run",
  "--execute",
  "AUTO-CENTRO-EXT100-APPROVED",
  "CARZONE_REPAIR_USER_ACCESS_TOKEN",
  "p_recovery_mode: true",
  "original_movement_count: 1",
  'order_status: "entregado"',
  "noLaterProductMovement",
  "accountingActiveAndUnreversed",
], "controlled incident repair");
assert.ok(!repair.includes("UPDATE products SET stock"));
assert.ok(!repair.includes(".from(\"products\").update"));

const scripts = JSON.parse(packageJson).scripts;
assert.equal(scripts["audit:auto-centro-ext100-reversal"].includes("--dry-run"), true);
assert.equal(scripts["repair:auto-centro-ext100-reversal"].includes("--execute"), true);

console.log("Invoice full commercial reversal structural contracts: PASS", {
  fiscalOnlyPrimitivePreserved: migration.includes("public.cancel_fiscal_invoice"),
  operatorUsesFullAuthority: true,
  directIncidentStockPatch: false,
  duplicateReturnAccountingGuard: true,
  controlledRepairDefaultsReadOnly: true,
});
