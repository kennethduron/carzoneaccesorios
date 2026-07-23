import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [migration, checkout, orderActions, invoiceDocument, accountingDispatcher, draftGenerator] = await Promise.all([
  read("supabase/migrations/202607220001_unify_checkout_fiscal_calculations.sql"),
  read("src/app/checkout/actions.ts"),
  read("src/app/admin/pedidos/actions.ts"),
  read("src/utils/official-invoice-document.ts"),
  read("src/services/accounting/accounting-event-dispatcher.ts"),
  read("src/services/accounting/journal-draft-generator.ts"),
]);

assert.match(migration, /create or replace function public\.calculate_sale_financials_v1/);
assert.match(migration, /'calculation_version', 1/);
assert.match(migration, /merchandise_taxable_base :=[\s\S]*merchandise_final \/ \(1 \+ included_tax_rate\)/);
assert.match(migration, /merchandise_tax := round\(merchandise_final - merchandise_taxable_base, 2\)/);
assert.match(migration, /discount_total := round\(line_discounts \+ normalized_global_discount, 2\)/);
assert.match(migration, /'wholesale_minimum_base', merchandise_final/);
assert.match(migration, /'delivery_rule_base', merchandise_final/);
assert.match(migration, /'delivery_taxable_base', 0/);
assert.match(migration, /'cash_on_delivery_taxable_base', 0/);
assert.match(migration, /create or replace function public\.recalculate_checkout_order_financials_v1/);
assert.match(migration, /update public\.orders[\s\S]*update public\.payments[\s\S]*update public\.invoices[\s\S]*update public\.accounts_receivable/);
assert.match(migration, /create or replace function public\.validate_invoice_monetary_snapshot_v1/);
assert.match(migration, /La factura no coincide con el snapshot monetario definitivo del pedido/);
assert.match(migration, /create or replace function public\.update_checkout_cash_on_delivery_fee_v1/);
assert.match(migration, /actor_role not in \('technical_owner', 'business_owner', 'admin'\)/);
assert.doesNotMatch(migration, /create_internal_sale_v1\s*\(/);
assert.doesNotMatch(migration, /automation_mode[\s\S]{0,100}(draft_only|auto_post)/);

assert.match(checkout, /rpc\("create_checkout_order_v2"/);
assert.doesNotMatch(checkout, /applyIncludedTaxFinancialsToOrder/);
assert.doesNotMatch(checkout, /included_tax_normalization_failed/);
assert.doesNotMatch(checkout, /wholesaleFinalTotal/);
assert.match(checkout, /first_wholesale_minimum - wholesaleProductsTotal/);

assert.match(orderActions, /rpc\("update_checkout_cash_on_delivery_fee_v1"/);
assert.doesNotMatch(orderActions, /subtotal \+ tax \+ shippingFee \+ fee/);

assert.match(invoiceDocument, /const taxableBase = roundMoney\(Math\.max\(0, invoice\.subtotal\)\)/);
assert.doesNotMatch(invoiceDocument, /invoice\.subtotal - discountTotal/);
assert.match(invoiceDocument, /Env.+o est.+ndar/);
assert.match(invoiceDocument, /Contra entrega/);

assert.match(accountingDispatcher, /shipping: toNumber\(row\.shipping_fee \?\? row\.shipping_total\)/);
assert.match(accountingDispatcher, /cash_on_delivery_fee: toNumber\(row\.cash_on_delivery_fee\)/);
assert.match(accountingDispatcher, /sourceType: "commercial_credit"[\s\S]*eventPurpose: "commercial_credit"/);
assert.match(accountingDispatcher, /sourceType: "receivable_payment"[\s\S]*eventPurpose: "receivable_payment"/);
assert.match(draftGenerator, /purpose === "commercial_credit"[\s\S]*accounts_receivable[\s\S]*sales_revenue/);
assert.match(draftGenerator, /purpose === "payment_received" \|\| purpose === "receivable_payment"/);

console.log("POS fiscal runtime structure checks passed.", {
  calculationVersion: 1,
  includedTax: true,
  logisticsTaxable: false,
  postCommitNormalization: false,
  invoiceSnapshotGuard: true,
  accountingAutomationChanged: false,
  internalSaleImplemented: false,
});
