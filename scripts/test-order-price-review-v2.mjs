import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyOrderPriceReviewV2 } from "../src/lib/orders/order-price-review.ts";

const EMPTY_REVIEW = {
  status: "none",
  reasons: [],
  invoiceConsistent: null,
  legitimateModeFallbackItemIds: [],
  adjustments: [],
};

function orderFixture(overrides = {}) {
  const item = {
    id: "10000000-0000-4000-8000-000000000001",
    product_id: "20000000-0000-4000-8000-000000000001",
    sku: "SKU-1",
    product_name: "Producto de prueba",
    quantity: 2,
    applied_price_mode: "retail",
    unit_price: 115,
    line_total: 230,
    retail_price_snapshot: 115,
    wholesale_price_snapshot: 100,
    unit_cost_snapshot: 70,
  };
  return {
    id: "30000000-0000-4000-8000-000000000001",
    order_number: "CZ-TEST",
    price_mode: "retail",
    subtotal: 200,
    tax: 30,
    shipping_fee: 0,
    cash_on_delivery_fee: 0,
    small_order_fee: 0,
    discount_total: 0,
    total: 230,
    status: "pending",
    payment_status: "pending",
    invoice_id: null,
    commercial_terms_version: 1,
    order_items: [item],
    price_review: EMPTY_REVIEW,
    ...overrides,
  };
}

function auditFixture(order, overrides = {}) {
  const item = order.order_items[0];
  return {
    auditId: "40000000-0000-4000-8000-000000000001",
    action: "sale.commercial_terms.adjusted",
    actorName: "Edgar",
    actorRole: "business_owner",
    createdAt: "2026-07-28T12:00:00Z",
    versionAfter: order.commercial_terms_version,
    note: "Ajuste manual autorizado",
    changes: [{
      orderItemId: item.id,
      automaticUnitPrice: item.retail_price_snapshot,
      previousUnitPrice: item.retail_price_snapshot,
      finalUnitPrice: item.unit_price,
    }],
    ...overrides,
  };
}

function invoiceFixture(order, overrides = {}) {
  return {
    subtotal: order.subtotal,
    tax: order.tax,
    shippingFee: order.shipping_fee,
    cashOnDeliveryFee: order.cash_on_delivery_fee,
    smallOrderFee: order.small_order_fee,
    discountTotal: order.discount_total,
    total: order.total,
    items: order.order_items.map((item) => ({
      orderItemId: item.id,
      quantity: item.quantity,
      unitPrice: item.unit_price,
      lineTotal: item.line_total,
    })),
    ...overrides,
  };
}

function classify(order, audits = [], invoice = null) {
  return classifyOrderPriceReviewV2(order, { audits, invoice });
}

assert.equal(classify(orderFixture()).status, "none", "pedido sin diferencias");

const authorized = orderFixture({
  order_items: [{ ...orderFixture().order_items[0], unit_price: 105, line_total: 210 }],
  subtotal: 182.61,
  tax: 27.39,
  total: 210,
});
assert.equal(classify(authorized, [auditFixture(authorized)]).status, "authorized_manual_override");
assert.equal(classify(authorized).status, "action_required", "precio manual sin auditoria");
assert.equal(classify(authorized, [auditFixture(authorized, { actorRole: "vendedor" })]).status, "action_required");
const authorizedWithLaterDeliveryVersion = { ...authorized, commercial_terms_version: 2 };
assert.equal(classify(authorizedWithLaterDeliveryVersion, [
  auditFixture(authorizedWithLaterDeliveryVersion, { versionAfter: 1 }),
  auditFixture(authorizedWithLaterDeliveryVersion, {
    auditId: "40000000-0000-4000-8000-000000000002",
    versionAfter: 2,
    createdAt: "2026-07-28T12:05:00Z",
    changes: [],
  }),
]).status, "authorized_manual_override", "continuidad auditada sin nuevo cambio de precio");

const invoiced = { ...authorized, invoice_id: "50000000-0000-4000-8000-000000000001", status: "entregado", payment_status: "paid" };
assert.equal(classify(invoiced, [auditFixture(invoiced)], invoiceFixture(invoiced)).status, "authorized_manual_override");
assert.equal(classify(invoiced, [auditFixture(invoiced)], invoiceFixture(invoiced, { total: 211 })).status, "action_required");

for (const state of [
  { status: "entregado", payment_status: "paid" },
  { status: "cancelado", payment_status: "pending" },
  { status: "pending", payment_status: "rejected" },
]) {
  assert.equal(classify(orderFixture(state)).status, "legacy_information");
}

const fallback = orderFixture({
  price_mode: "wholesale",
  order_items: [{ ...orderFixture().order_items[0], wholesale_price_snapshot: 0 }],
});
assert.equal(classify(fallback).status, "none", "fallback mayorista legitimo");
const authorizedFallback = {
  ...fallback,
  order_items: [{ ...fallback.order_items[0], unit_price: 105, line_total: 210 }],
  subtotal: 182.61,
  tax: 27.39,
  total: 210,
};
assert.equal(
  classify(authorizedFallback, [auditFixture(authorizedFallback)]).status,
  "authorized_manual_override",
  "fallback mayorista con ajuste autorizado",
);
const unexplainedMode = orderFixture({ price_mode: "wholesale" });
assert.equal(classify(unexplainedMode).status, "action_required", "modalidad sin fallback");

const samePrice = orderFixture();
assert.equal(classify(samePrice, [auditFixture(samePrice)]).status, "none");
assert.equal(classify(authorized, [auditFixture(authorized, {
  changes: [{ ...auditFixture(authorized).changes[0], orderItemId: "10000000-0000-4000-8000-000000000099" }],
})]).status, "action_required", "audit de otra linea");
assert.equal(classify(authorized, [auditFixture(authorized, { versionAfter: 0 })]).status, "action_required", "version incompatible");

const belowCost = orderFixture({
  order_items: [{ ...orderFixture().order_items[0], unit_price: 60, line_total: 120 }],
});
assert.equal(classify(belowCost, [auditFixture(belowCost)]).status, "action_required");

const legacy = { ...authorized, status: "entregado", commercial_terms_version: 0 };
assert.equal(classify(legacy).status, "legacy_information");

for (const orderNumber of [
  "CZ-260728211100-6CAF1E",
  "CZ-260728000547-02F4C2",
  "CZ-260727235358-95C41C",
]) {
  const protectedOrder = { ...invoiced, order_number: orderNumber };
  assert.equal(
    classify(protectedOrder, [auditFixture(protectedOrder)], invoiceFixture(protectedOrder)).status,
    "authorized_manual_override",
    orderNumber,
  );
}

const william = orderFixture({
  order_number: "CZ-260730213609-063D32",
  price_mode: "wholesale",
  status: "entregado",
  payment_status: "paid",
  invoice_id: "50000000-0000-4000-8000-000000000020",
  order_items: [{
    ...orderFixture().order_items[0],
    applied_price_mode: "wholesale",
    wholesale_price_snapshot: 115,
  }],
});
assert.equal(classify(william, [], invoiceFixture(william)).status, "legacy_information");

const migration = await readFile(new URL("../supabase/migrations/202607310007_order_price_review_v2_and_confirmation.sql", import.meta.url), "utf8");
assert.match(migration, /'order_price_review_v2', false/);
assert.match(migration, /'order_price_confirmation_modal_v1', false/);
assert.match(migration, /ORDER_PRICE_CONFIRMATION_REQUIRED/);
assert.match(migration, /public\.calculate_sale_financials_v1\(/);
assert.match(migration, /sale\.price_override\.confirmed/);
assert.match(migration, /confirmation_modal/);
assert.match(migration, /where item\.order_id = p_order_id and item\.id = requested\.order_item_id/);
assert.match(migration, /chr\(8212\)/);
assert.doesNotMatch(migration, /CZ-260728|CZ-260730|0000101[7-9]|00001020/);
assert.doesNotMatch(migration, /update\s+public\.orders\s+set/i);

const dialog = await readFile(new URL("../src/components/admin/order-price-confirmation-dialog.tsx", import.meta.url), "utf8");
for (const contractText of [
  "Confirmar ajuste de precio",
  "No, regresar",
  "autorizar ajuste",
  "Nota opcional",
  "Precio anterior",
  "Nuevo precio",
  "Base imponible",
  "ISV incluido",
  "Diferencia total del pedido",
]) assert.match(dialog, new RegExp(contractText));
assert.match(dialog, /disabled=\{processing\}/);
assert.match(dialog, /line\.aboveAutomaticPrice/);

const commercialTerms = await readFile(new URL("../src/components/admin/order-commercial-terms.tsx", import.meta.url), "utf8");
assert.match(commercialTerms, /previewSaleTermsAdjustmentAction/);
assert.match(commercialTerms, /confirmSaleTermsAdjustmentAction/);
assert.match(commercialTerms, /Historial de ajustes previos a facturaci/);
assert.match(commercialTerms, /activeInvoice \?/);

const manager = await readFile(new URL("../src/components/admin/admin-orders-manager.tsx", import.meta.url), "utf8");
assert.match(manager, /order\.price_review\.status === "action_required"/);
assert.match(manager, /Precio personalizado autorizado/);

const actions = await readFile(new URL("../src/app/admin/pedidos/actions.ts", import.meta.url), "utf8");
assert.match(actions, /requirePermission\("admin:access"\)/);
assert.match(actions, /hasEffectivePermission\([^]*"sales:override_price"/);
assert.match(actions, /preview_order_price_adjustment_v1/);
assert.match(actions, /confirm_order_price_adjustment_v1/);

console.log("Order price review V2 classification and migration checks passed.");
