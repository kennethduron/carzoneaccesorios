import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { savePosDraftSchema } from "../src/lib/validation/pos-draft.ts";
import { normalizeAdditionalFees } from "../src/utils/financial-summary.ts";
import { getOfficialInvoiceTotals, summaryLabels } from "../src/utils/official-invoice-document.ts";
import { posCustomerMatchLabel, posSourceLabel } from "../src/utils/pos-presentation-labels.ts";

const id = "11111111-1111-4111-8111-111111111111";
const baseSave = {
  requestKey: id,
  expectedVersion: 1,
  customerId: id,
  expectedCustomerCommercialVersion: 0,
  items: [],
  deliveryMode: "store_immediate",
  deliveryAddress: null,
  deliveryNotes: null,
  internalNotes: null,
  shippingFee: 0,
  codFee: 0,
  additionalCharge: 0,
  additionalChargeDescription: null,
  otherCharge: 0,
  otherChargeDescription: null,
};

assert.equal(savePosDraftSchema.safeParse(baseSave).success, true, "zero charges accept null descriptions");
assert.equal(savePosDraftSchema.safeParse({ ...baseSave, additionalCharge: 1 }).success, false, "positive additional charge requires a description");
assert.equal(savePosDraftSchema.safeParse({ ...baseSave, otherCharge: 1, otherChargeDescription: "AB" }).success, true, "two-character boundary is accepted");
assert.equal(savePosDraftSchema.safeParse({ ...baseSave, otherCharge: 1, otherChargeDescription: "A" }).success, false, "one-character description is rejected");
assert.equal(savePosDraftSchema.safeParse({ ...baseSave, otherCharge: 1, otherChargeDescription: "Á".repeat(120) }).success, true, "120 Unicode characters are accepted");
assert.equal(savePosDraftSchema.safeParse({ ...baseSave, otherCharge: 1, otherChargeDescription: "A".repeat(121) }).success, false, "121 characters are rejected");
for (const unsafe of ["<script>alert(1)</script>", "<b>Instalación</b>", "línea\nnueva", "campo\ttabulado"]) {
  assert.equal(savePosDraftSchema.safeParse({ ...baseSave, otherCharge: 1, otherChargeDescription: unsafe }).success, false, `unsafe description must fail: ${JSON.stringify(unsafe)}`);
}
assert.equal(savePosDraftSchema.parse({ ...baseSave, otherCharge: 1, otherChargeDescription: "  Protección ñ con comillas  " }).otherChargeDescription, "Protección ñ con comillas", "safe Spanish text is trimmed");

const describedFees = normalizeAdditionalFees([
  { label: "Instalación", amount: 300, category: "additional_charge" },
  { label: "Material especial", amount: 100, category: "other_charge" },
  { label: "No mostrar", amount: 0, category: "other_charge" },
]);
assert.deepEqual(describedFees.map(({ label, amount, category }) => ({ label, amount, category })), [
  { label: "Instalación", amount: 300, category: "additional_charge" },
  { label: "Material especial", amount: 100, category: "other_charge" },
]);

const invoice = {
  invoiceNumber: "000-001-01-00000001", orderNumber: "POSUI-1", status: "emitida",
  issuedAt: null, invoiceDate: "2026-08-08", dueAt: null, createdAt: null,
  companyLegalName: null, companyRtn: null, companyAddress: null, companyPhone: null,
  companyEmail: null, companyLogoUrl: null, cai: null, fiscalRangeStart: null,
  fiscalRangeEnd: null, caiAuthorizationDate: null, fiscalDeadline: null,
  customerName: "Cliente local", customerRtn: null, customerEmail: null,
  customerPhone: null, customerAddress: null, customerCity: null, customerBusinessName: null, paymentMethod: "cash", paymentStatus: "approved",
  paymentReference: null, subtotal: 100, tax: 15, shippingFee: 0, cashOnDeliveryFee: 0,
  additionalFees: describedFees, total: 515,
  items: [{ sku: "POSUI", name: "Producto local", quantity: 1, unitPrice: 115, lineTotal: 115,
    taxCategory: "standard", taxableBase: 100, taxAmount: 15, exemptAmount: 0 }],
};
const totals = getOfficialInvoiceTotals(invoice);
assert.deepEqual(totals.itemizedAdditionalFees.map((fee) => fee.label), ["Instalación", "Material especial"], "PDF totals itemize described POS charges");
assert.ok(summaryLabels(totals).includes("Instalación"), "PDF/print summary contains additional-charge description");
assert.ok(summaryLabels(totals).includes("Material especial"), "PDF/print summary contains other-charge description");
const legacyTotals = getOfficialInvoiceTotals({ ...invoice, additionalFees: [{ label: "Cargo adicional", amount: 10 }, { label: "Otro cargo", amount: 5 }] });
assert.deepEqual(legacyTotals.itemizedAdditionalFees.map((fee) => fee.label), ["Cargo adicional", "Otro cargo"], "historical generic labels remain printable");

assert.equal(posCustomerMatchLabel("probable", ["name"]), "Coincidencia probable por nombre");
assert.equal(posCustomerMatchLabel("strong", ["email", "phone"]), "Coincidencia exacta por correo electrónico y teléfono");
assert.equal(posSourceLabel("portal_registration"), "Registro desde el portal");
assert.equal(posSourceLabel("pos"), "Punto de venta");

const [page, shell, workspace, customerWorkspace, cart, mobileTotalBar, confirmation, service, migration, orderView, invoiceView] = await Promise.all([
  readFile(new URL("../src/app/admin/pos/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/admin-shell.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-customer-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-cart.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-mobile-total-bar.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-confirmation-panel.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/services/supabase/pos-draft.service.ts", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/202608080001_pos_charge_descriptions.sql", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/admin-orders-manager.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/admin-invoices-manager.tsx", import.meta.url), "utf8"),
]);

assert.match(page, /backHref="\/admin"/);
assert.match(shell, /Volver al inicio/);
assert.match(shell, /variant === "wide"/);
assert.match(workspace, /POS_WORKSPACE_GRID_CLASS/);
assert.match(cart, /pos-cart-lines/);
assert.match(cart, /Lista desplazable de productos agregados/);
assert.match(workspace, /<PosMobileTotalBar/);
assert.match(mobileTotalBar, /Revisar total/);
assert.match(cart, /<Image/);
assert.match(cart, /min-h-11/);
assert.match(confirmation, /paymentMethodLabel\(result\.paymentMethod\)/);
assert.match(confirmation, /escapeReceiptText\(charge\.label\)/);
assert.match(customerWorkspace, /posCustomerMatchLabel/);
assert.match(customerWorkspace, /posSourceLabel/);
for (const internalValue of ["portal_registration", "probable_name", "exact_email", "exact_phone", "source_type", "source_id", "customer_id", "user_id", "pending_mapping", "sale_recognized", "inventory_cogs"]) {
  assert.doesNotMatch(customerWorkspace, new RegExp(`>[^<]*${internalValue}[^<]*<`, "i"), `commercial customer UI must not render ${internalValue}`);
  assert.doesNotMatch(confirmation, new RegExp(`>[^<]*${internalValue}[^<]*<`, "i"), `sale result must not render ${internalValue}`);
}
assert.match(service, /save_pos_sale_draft_with_charge_descriptions_v1/);
assert.match(service, /confirm_pos_sale_with_charge_descriptions_v1/);
assert.match(migration, /before insert on public\.orders/);
assert.match(migration, /before insert on public\.invoices/);
assert.match(migration, /confirm_selectable_pos_sale_v1/);
assert.match(migration, /'accounting_mapping_changed', false/);
assert.doesNotMatch(migration, /resolve_accounting_mapping_v2\([^)]*description/i);
assert.match(orderView, /fee\.label/);
assert.match(invoiceView, /fee\.label/);

console.log("POS professional UI, charge descriptions and Spanish presentation: PASS");
