import assert from "node:assert/strict";
import { resolveAccountsPayableSnapshot } from "../src/services/accounting/purchase-payable-snapshot.ts";

const base = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  supplier_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  purchase_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  supplier_invoice_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  total_amount: 9200,
  paid_amount: 0,
  balance: 9200,
  due_date: "2026-08-20",
  status: "pending",
  currency: "HNL",
  created_at: "2026-07-21T12:00:00Z",
  supplier: { name: "Proveedor prueba" },
  purchase: {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    supplier_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    purchase_number: "COMP-1",
    purchase_date: "2026-07-21",
    status: "received",
    subtotal: 8000,
    tax_amount: 1200,
    discount_amount: 0,
    shipping_amount: 0,
    total: 9200,
    currency: "HNL",
  },
  supplierInvoice: {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    supplier_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    purchase_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    invoice_number: "FAC-1",
    invoice_date: "2026-07-21",
    due_date: "2026-08-20",
    status: "received",
    subtotal: 8000,
    tax_amount: 1200,
    discount_amount: 0,
    total: 9200,
    currency: "HNL",
  },
  purchaseItems: [{ quantity: 2, unit_cost: 4000, tax_amount: 1200, discount_amount: 0 }],
};

const invoiceResult = resolveAccountsPayableSnapshot(base);
assert.equal(invoiceResult.snapshot.fiscal_source, "supplier_invoice");
assert.equal(invoiceResult.snapshot.subtotal, 8000);
assert.equal(invoiceResult.taxAmount, 1200);
assert.deepEqual(invoiceResult.validationErrors, []);

const purchaseResult = resolveAccountsPayableSnapshot({
  ...base,
  supplierInvoice: { ...base.supplierInvoice, status: "draft" },
});
assert.equal(purchaseResult.snapshot.fiscal_source, "purchase");
assert.equal(purchaseResult.snapshot.tax_amount, 1200);

const itemResult = resolveAccountsPayableSnapshot({
  ...base,
  supplier_invoice_id: null,
  supplierInvoice: null,
  purchase: { ...base.purchase, subtotal: 9000, tax_amount: 300, total: 9200 },
});
assert.equal(itemResult.snapshot.fiscal_source, "purchase_items");
assert.equal(itemResult.snapshot.tax_amount, 1200);

const missingResult = resolveAccountsPayableSnapshot({
  ...base,
  supplier_invoice_id: null,
  supplierInvoice: null,
  purchase_id: null,
  purchase: null,
  purchaseItems: [],
});
assert.equal(missingResult.snapshot.fiscal_breakdown_status, "missing");
assert.equal(missingResult.taxAmount, null);
assert.equal(missingResult.validationErrors.length, 1);
assert.equal(missingResult.snapshot.total_amount, 9200);
assert.equal(missingResult.snapshot.currency, "HNL");
assert.equal(missingResult.snapshot.accounts_payable_id, base.id);
assert.equal(missingResult.snapshot.source_id, base.id);

const mismatchedInvoice = resolveAccountsPayableSnapshot({
  ...base,
  supplierInvoice: { ...base.supplierInvoice, supplier_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
});
assert.equal(mismatchedInvoice.snapshot.fiscal_source, "purchase");

console.log("Accounting payable snapshot tests passed.");
