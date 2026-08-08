import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { confirmPosSaleSchema } from "../src/lib/validation/pos-draft.ts";
import { getOfficialInvoiceTotals } from "../src/utils/official-invoice-document.ts";

const cash = confirmPosSaleSchema.parse({
  requestKey: "a5500000-0000-4000-8000-000000000001",
  expectedDraftVersion: 4,
  invoiceDate: "2026-08-02",
  payment: { method: "cash", amountTendered: 250.25 },
});
assert.equal(cash.payment.method, "cash");
assert.equal(confirmPosSaleSchema.safeParse({
  requestKey: crypto.randomUUID(), expectedDraftVersion: 1, invoiceDate: "2026-08-02",
  payment: { method: "cash", amountTendered: -1 },
}).success, false, "negative cash must be rejected before the RPC");
assert.equal(confirmPosSaleSchema.safeParse({
  requestKey: crypto.randomUUID(), expectedDraftVersion: 1, invoiceDate: "2026-08-02",
  payment: { method: "bank_transfer", verified: true, reference: "" },
}).success, false, "bank transfer requires a reference");
assert.equal(confirmPosSaleSchema.safeParse({
  requestKey: crypto.randomUUID(), expectedDraftVersion: 1, invoiceDate: "2026-08-02",
  payment: { method: "card", verified: true, reference: null },
}).success, true, "generic verified card does not invent debit or credit");
assert.equal(confirmPosSaleSchema.safeParse({
  requestKey: crypto.randomUUID(), expectedDraftVersion: 1, invoiceDate: "08/02/2026",
  payment: { method: "commercial_credit" },
}).success, false, "invoice date must use the canonical date-only shape");

const totals = getOfficialInvoiceTotals({
  invoiceNumber: "000-001-01-00000001", orderNumber: "CZ-POS-1", status: "emitida",
  issuedAt: null, invoiceDate: "2026-08-02", dueAt: null, createdAt: null,
  companyLegalName: null, companyRtn: null, companyAddress: null, companyPhone: null,
  companyEmail: null, companyLogoUrl: null, cai: null, fiscalRangeStart: null,
  fiscalRangeEnd: null, caiAuthorizationDate: null, fiscalDeadline: null,
  customerName: "Fixture", customerRtn: null, customerEmail: null,
  customerPhone: null, customerAddress: null, paymentMethod: "cash",
  paymentStatus: "approved", paymentReference: null, subtotal: 200, tax: 15,
  shippingFee: 0, cashOnDeliveryFee: 0, total: 215,
  items: [
    { sku: "TAX", name: "Gravado", quantity: 1, unitPrice: 115, lineTotal: 115,
      taxCategory: "standard", taxableBase: 100, taxAmount: 15, exemptAmount: 0 },
    { sku: "EX", name: "Exento", quantity: 1, unitPrice: 100, lineTotal: 100,
      taxCategory: "exempt", taxableBase: 0, taxAmount: 0, exemptAmount: 100 },
  ],
});
assert.equal(totals.taxable15, 100);
assert.equal(totals.exempt, 100);
assert.equal(totals.tax15, 15);
assert.equal(totals.total, 215);

const migration = await readFile(new URL("../supabase/migrations/202608020002_pos_stage_5_atomic_sale_confirmation.sql", import.meta.url), "utf8");
assert.match(migration, /create or replace function public\.confirm_pos_sale_v1\(/i);
assert.match(migration, /pg_advisory_xact_lock/);
assert.match(migration, /for update/);
assert.match(migration, /POS_INSUFFICIENT_STOCK/);
assert.match(migration, /commercial_credit_on_delivery/);
assert.doesNotMatch(migration, /card_number|cvv|magnetic_stripe|pin_code/i);

const [route, service, panel, workspace] = await Promise.all([
  readFile(new URL("../src/app/api/admin/pos/drafts/[draftId]/confirm/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/services/supabase/pos-draft.service.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-confirmation-panel.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-workspace.tsx", import.meta.url), "utf8"),
]);
assert.match(route, /authorizePosCustomerRequest\("pos:confirm_sale"\)/);
assert.match(route, /recoverPosSaleConfirmation/);
assert.match(route, /confirmPosSale/);
assert.match(service, /confirm_selectable_pos_sale_v1/);
assert.match(service, /recover_pos_sale_confirmation_v1/);
assert.match(panel, /Nueva venta/);
assert.match(panel, /Usuario responsable/);
assert.match(panel, /draft\.items\.map/);
assert.match(panel, /Monto recibido/);
assert.match(workspace, /startNewSale/);
assert.doesNotMatch(panel, /card_credit|card_debit/i);

console.log("POS Stage 5 application validation: OK");
