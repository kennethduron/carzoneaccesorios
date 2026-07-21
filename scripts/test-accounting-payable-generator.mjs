import assert from "node:assert/strict";
import { buildPurchasePayableJournalLines } from "../src/services/accounting/purchase-payable-journal-lines.ts";

const accounts = {
  costAccountId: "inventory",
  taxAccountId: "purchase-tax",
  discountAccountId: "purchase-discount",
  shippingAccountId: "purchase-shipping",
  payableAccountId: "accounts-payable",
};

const realCase = buildPurchasePayableJournalLines({
  subtotal: 8000, taxAmount: 1200, discountAmount: 0, shippingAmount: 0, totalAmount: 9200, ...accounts,
});
assert.equal(realCase.ok, true);
if (realCase.ok) {
  assert.deepEqual(realCase.lines, [
    { account_id: "inventory", debit: 8000, credit: 0, description: "Compra o gasto registrado" },
    { account_id: "purchase-tax", debit: 1200, credit: 0, description: "Impuesto de compras" },
    { account_id: "accounts-payable", debit: 0, credit: 9200, description: "Cuenta por pagar a proveedor" },
  ]);
  assert.equal(realCase.totalDebit, 9200);
  assert.equal(realCase.totalCredit, 9200);
}

const noTax = buildPurchasePayableJournalLines({
  subtotal: 8000, taxAmount: 0, discountAmount: 0, shippingAmount: 0, totalAmount: 8000, ...accounts, taxAccountId: null,
});
assert.equal(noTax.ok, true);
if (noTax.ok) assert.equal(noTax.lines.length, 2);

const missingTax = buildPurchasePayableJournalLines({
  subtotal: 8000, taxAmount: 1200, discountAmount: 0, shippingAmount: 0, totalAmount: 9200, ...accounts, taxAccountId: null,
});
assert.deepEqual(missingTax, { ok: false, error: "missing_tax_account" });

const discount = buildPurchasePayableJournalLines({
  subtotal: 8000, taxAmount: 1200, discountAmount: 200, shippingAmount: 0, totalAmount: 9000, ...accounts,
});
assert.equal(discount.ok, true);
if (discount.ok) {
  assert.equal(discount.lines.find((line) => line.account_id === "purchase-discount")?.credit, 200);
  assert.equal(discount.totalDebit, discount.totalCredit);
}

const shipping = buildPurchasePayableJournalLines({
  subtotal: 8000, taxAmount: 1200, discountAmount: 0, shippingAmount: 300, totalAmount: 9500, ...accounts,
});
assert.equal(shipping.ok, true);
if (shipping.ok) {
  assert.equal(shipping.lines.find((line) => line.account_id === "purchase-shipping")?.debit, 300);
  assert.equal(shipping.totalDebit, shipping.totalCredit);
}

const badPrecision = buildPurchasePayableJournalLines({
  subtotal: 8000.001, taxAmount: 1200, discountAmount: 0, shippingAmount: 0, totalAmount: 9200.001, ...accounts,
});
assert.deepEqual(badPrecision, { ok: false, error: "invalid_breakdown" });

console.log("Accounting payable generator tests passed.");
