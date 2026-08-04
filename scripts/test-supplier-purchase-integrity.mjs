import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  formatCivilDate,
  isCivilDate,
  todayCivilDate,
} from "../src/lib/civil-date.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [
  repair,
  guards,
  sqlTests,
  actions,
  service,
  manager,
  wizard,
] = await Promise.all([
  read("supabase/migrations/202608040001_repair_cromos_invoice_purchase_relationship.sql"),
  read("supabase/migrations/202608040002_supplier_purchase_integrity_guards.sql"),
  read("supabase/tests/supplier_purchase_integrity_guards.sql"),
  read("src/app/admin/cuentas-por-pagar/actions.ts"),
  read("src/services/supabase/supplier-multi-payment.service.ts"),
  read("src/components/admin/accounts-payable-manager.tsx"),
  read("src/components/admin/supplier-multi-payment-wizard.tsx"),
]);

const mustContain = (text, values, label) => {
  for (const value of values) {
    assert.ok(text.includes(value), label + ": missing " + value);
  }
};

mustContain(repair, [
  "pg_advisory_xact_lock",
  "CAMINO_B_NO_CANONICAL_PURCHASE",
  "purchase_id = null",
  "paid_amount <> 0.00",
  "balance <> 2800.00",
  "supplier_payment_applications",
  "protected 0090915",
  "supplier_invoice.purchase_relationship_repaired",
  "accounts_payable.purchase_relationship_repaired",
], "guarded repair");

mustContain(guards, [
  "validate_supplier_purchase_integrity_v1",
  "SUPPLIER_PURCHASE_MISMATCH",
  "supplier_invoices_purchase_integrity_v1",
  "accounts_payable_purchase_integrity_v1",
  "purchases_supplier_integrity_v1",
  "supplier_payments_purchase_integrity_v1",
  "supplier_payment_applications_purchase_integrity_v1",
], "database guards");

mustContain(actions, [
  "ensureSupplierRelationship",
  "isSupplierPurchaseMismatch",
  "supplierPurchaseMismatchMessage",
  "supplierPaymentMismatchMessage",
  "isCivilDate(paidAt)",
], "server actions");

mustContain(service, [
  "assertSupplierPaymentApplicationsIntegrity",
  "SupplierPurchaseMismatchError",
  "await assertSupplierPaymentApplicationsIntegrity(input)",
], "payment service");

mustContain(manager, [
  "invoicePurchaseOptions",
  "payablePurchaseOptions",
  "purchase.supplier_id === invoiceDraft.supplier_id",
  "purchase.supplier_id === payableDraft.supplier_id",
  "selectSupplierForInvoice",
  "selectSupplierForPayable",
  "purchase_id: \"\"",
  "Este proveedor no tiene compras compatibles.",
], "supplier-filtered selectors");

mustContain(wizard, [
  "supplier_multi_invoice_payment_v2:draft",
  "legacyStorageKey",
  "reviewedPaidDate",
  "isCivilDate(draft.reviewedPaidDate)",
  "paid_date: draft.reviewedPaidDate",
  "Fecha efectiva del pago:",
], "civil-date review contract");

mustContain(sqlTests, [
  "CROMOS-INTEGRITY-LOCAL-ONLY",
  "individual payment RPC is protected",
  "multi-invoice payment RPC rejects",
  "zero payments",
  "zero applications",
  "balance unchanged",
], "local SQL coverage");

for (const productionId of [
  "00bd93df-88cc-412d-b8d5-63d66b93feee",
  "c1b65061-78ba-4c97-adca-a0591acb6f4d",
  "b8d1cd9e-1916-43e5-aa11-30271c65c52e",
]) {
  assert.ok(repair.includes(productionId), "repair must pin exact production ids");
  assert.ok(
    !guards.includes(productionId) &&
      !actions.includes(productionId) &&
      !service.includes(productionId),
    "permanent guards and application code must remain generic",
  );
}

assert.equal(isCivilDate("2026-07-28"), true);
assert.equal(isCivilDate("2026-02-30"), false);
assert.equal(isCivilDate("07/28/2026"), false);
assert.match(formatCivilDate("2026-07-28"), /28/);
assert.equal(
  todayCivilDate(
    "America/Tegucigalpa",
    new Date("2026-07-29T05:30:00.000Z"),
  ),
  "2026-07-28",
  "civil date must remain July 28 before local midnight",
);
assert.equal(
  todayCivilDate(
    "America/Tegucigalpa",
    new Date("2026-07-29T06:30:00.000Z"),
  ),
  "2026-07-29",
  "civil date must advance after local midnight",
);
assert.ok(
  !wizard.includes("T00:00:00-06:00"),
  "wizard must not parse a commercial date through a UTC-sensitive string",
);

console.log("Supplier purchase integrity and civil-date contracts: OK");
