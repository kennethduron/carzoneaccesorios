import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createSupplierPaymentSelectionRequest,
  isEligibleSupplierPaymentPayable,
  isSameSupplierPaymentSelection,
} from "../src/components/admin/supplier-payment-wizard-selection.ts";

const supplierA = "97000000-0000-4000-8000-000000000001";
const supplierB = "97000000-0000-4000-8000-000000000002";
const payableA = "97000000-0000-4000-8000-000000000011";
const payableB = "97000000-0000-4000-8000-000000000012";
const request = createSupplierPaymentSelectionRequest(1, supplierA, payableA);

assert.deepEqual(request, {
  requestId: 1,
  supplierId: supplierA,
  accountsPayableId: payableA,
});
assert.equal(isSameSupplierPaymentSelection(request, supplierA, payableA), true);
assert.equal(isSameSupplierPaymentSelection(request, supplierA, payableB), false);
assert.equal(isSameSupplierPaymentSelection(request, supplierB, payableA), false);

const openPayable = {
  id: payableA,
  supplier_id: supplierA,
  status: "partial",
  balance: 626_938.41,
};
assert.equal(isEligibleSupplierPaymentPayable(openPayable, request), true);
assert.equal(
  isEligibleSupplierPaymentPayable({ ...openPayable, supplier_id: supplierB }, request),
  false,
);
assert.equal(
  isEligibleSupplierPaymentPayable({ ...openPayable, id: payableB }, request),
  false,
);
assert.equal(
  isEligibleSupplierPaymentPayable({ ...openPayable, status: "paid" }, request),
  false,
);
assert.equal(
  isEligibleSupplierPaymentPayable({ ...openPayable, status: "cancelled" }, request),
  false,
);
assert.equal(
  isEligibleSupplierPaymentPayable({ ...openPayable, balance: 0 }, request),
  false,
);

const root = new URL("../", import.meta.url);
const [manager, wizard, service, schema] = await Promise.all([
  readFile(new URL("src/components/admin/accounts-payable-manager.tsx", root), "utf8"),
  readFile(new URL("src/components/admin/supplier-multi-payment-wizard.tsx", root), "utf8"),
  readFile(new URL("src/services/supabase/supplier-multi-payment.service.ts", root), "utf8"),
  readFile(new URL("src/schemas/supplier-multi-payment.ts", root), "utf8"),
]);

for (const value of [
  "wizardOpen",
  "wizardSelectionRequest",
  "isSameSupplierPaymentSelection",
  "setWizardOpen(true)",
]) {
  assert.ok(manager.includes(value), `manager missing ${value}`);
}
for (const value of [
  "selectionRequest",
  "accounts_payable_id: selectionRequest.accountsPayableId",
  "isEligibleSupplierPaymentPayable",
  "requestAnimationFrame",
  "scrollIntoView",
  "focus({ preventScroll: true })",
  "Saldo preseleccionado",
  "Sin factura",
  "Sin compra",
  "Saldo inicial o registro manual reconocido",
  "openedFromPayableRow ? newDraft() : readDraft()",
]) {
  assert.ok(wizard.includes(value), `wizard missing ${value}`);
}
assert.ok(schema.includes("accounts_payable_id: z.uuid().optional()"));
assert.ok(service.includes('query = query.eq("id", input.accounts_payable_id)'));
assert.ok(!manager.includes("Usa Registrar pago para distribuir"));

console.log("Supplier payment row wizard unit and structural contracts: OK");
