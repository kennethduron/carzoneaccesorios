import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { assertStage6LocalEnvironment, readStage6LocalStatus } from "./pos-stage-6-local-guard.mjs";

const guard = assertStage6LocalEnvironment();
const status = readStage6LocalStatus();
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const marker = `POS-EDGAR-${Date.now()}-LOCAL-ONLY`;
const email = `${marker.toLowerCase()}@example.test`;
const password = "Edgar-Pos-Local-Only!2026";
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Tegucigalpa", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const fiscalSequence = 10_000_000 + (Date.now() % 80_000_000);
const fiscalStart = `000-001-01-${String(fiscalSequence).padStart(8, "0")}`;
const fiscalEnd = `000-001-01-${String(fiscalSequence + 100).padStart(8, "0")}`;

const authUser = await admin.auth.admin.createUser({
  email, password, email_confirm: true, user_metadata: { full_name: marker },
});
assert.ifError(authUser.error);
const actorId = authUser.data.user.id;
const permissions = [
  "admin:access", "orders:manage", "orders:manage_logistics", "orders:cancel",
  "pos:create_sale", "pos:access", "pos:customers:search", "customers:read_commercial",
  "customers:read_credit", "pos:drafts:create", "pos:drafts:read", "pos:drafts:edit_own",
  "pos:drafts:edit_any", "pos:drafts:abandon", "pos:products:search", "pos:price_override",
  "pos:confirm_sale", "pos:reprint_documents", "invoices:create", "settings:fiscal",
  "customers:merge", "customers:link_portal_account",
];
const role = await admin.from("roles").upsert({
  name: "admin", description: `${marker} role`, permissions,
}, { onConflict: "name" }).select("id").single();
assert.ifError(role.error);
assert.ifError((await admin.from("users").update({ role_id: role.data.id, active: true }).eq("id", actorId)).error);

const actor = createClient(status.API_URL, status.ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const retryActor = createClient(status.API_URL, status.ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
assert.ifError((await actor.auth.signInWithPassword({ email, password })).error);
assert.ifError((await retryActor.auth.signInWithPassword({ email, password })).error);

assert.ifError((await admin.from("company_settings").insert({
  company_name: marker, currency: "HNL", tax_rate: 0.15,
  invoice_prefix: "EDG", order_prefix: "EDG", free_shipping_threshold: 3000,
  standard_shipping_fee: 120, first_wholesale_minimum: 10000,
})).error);
assert.ifError((await actor.from("fiscal_settings").update({
  legal_name: marker, rtn: "08011999123456", cai: `${marker}-CAI`,
  cai_authorization_date: "2026-01-01", invoice_range_start: fiscalStart,
  invoice_range_end: fiscalEnd, current_invoice_number: fiscalStart,
  emission_deadline: "2026-12-31", fiscal_address: "Tegucigalpa", phone: "99990000", email,
}).eq("id", true)).error);

const enabledAccounting = await admin.from("accounting_feature_flags").update({
  state: "enabled", cutover_at: "2026-07-28T20:30:00.000Z",
  notes: `${marker} isolated immediate delivery certification`,
}).in("key", ["sales_draft_v2", "cogs_draft_v2"]).select("key,state");
assert.ifError(enabledAccounting.error);
assert.equal(enabledAccounting.data.length, 2);

const category = await admin.from("categories").select("id").eq("active", true).limit(1).single();
assert.ifError(category.error);
const productRows = ["A", "B", "C", "D", "OFF", "ON", "CREDIT"].map((suffix) => ({
  category_id: category.data.id,
  sku: `${marker}-${suffix}`,
  internal_code: `${marker}-${suffix}`,
  slug: `${marker}-${suffix}`.toLowerCase(),
  name: `${marker} ${suffix}`,
  brand: "LOCAL",
  description: "Fixture POS local desechable",
  stock: 10,
  reserved_stock: 0,
  cost_price: 50,
  retail_price: 115,
  wholesale_price: 100,
  wholesale_min_quantity: 2,
  tax_category: "standard",
  tracks_inventory: true,
  status: "active",
  active: true,
}));
const productsResult = await admin.from("products").insert(productRows)
  .select("id,sku,product_sales_version,stock");
assert.ifError(productsResult.error);
const product = (suffix) => productsResult.data.find((row) => row.sku === `${marker}-${suffix}`);

async function createCustomer(suffix, credit = false) {
  const created = await admin.from("customers").insert({
    contact_name: `${marker} Contact ${suffix}`,
    business_name: suffix === "NO-COMPANY" ? null : `${marker} Empresa ${suffix}`,
    email: `${marker.toLowerCase()}-${suffix.toLowerCase()}@example.test`,
    phone: `9999${String(Math.floor(Math.random() * 9999)).padStart(4, "0")}`,
    address: "Colonia Kennedy, bloque 4",
    city: "Tegucigalpa",
    source: "pos", lead_status: "cliente", status: "active", active: true,
  }).select("id,commercial_version,contact_name,business_name,address,city").single();
  assert.ifError(created.error);
  if (credit) {
    assert.ifError((await admin.from("customer_credit_accounts").insert({
      customer_id: created.data.id, is_credit_enabled: true, credit_limit: 10000,
      terms_days: 30, status: "active", activated_at: new Date().toISOString(), activated_by: actorId,
    })).error);
    const refreshed = await admin.from("customers")
      .select("id,commercial_version,contact_name,business_name,address,city")
      .eq("id", created.data.id)
      .single();
    assert.ifError(refreshed.error);
    return refreshed.data;
  }
  return created.data;
}

async function createDraft(customer) {
  const created = await actor.rpc("create_selectable_pos_sale_draft_v1", {
    p_request_key: crypto.randomUUID(), p_customer_id: customer.id,
  });
  assert.ifError(created.error);
  return created.data;
}

function line(productRow, quantity = 1) {
  return {
    productId: productRow.id, quantity, finalUnitPrice: null,
    priceOverrideReason: null, expectedProductSalesVersion: productRow.product_sales_version,
  };
}

async function saveDraft(customer, draft, lines, requestKey = crypto.randomUUID()) {
  return actor.rpc("save_pos_sale_draft_v1", {
    p_request_key: requestKey, p_draft_id: draft.draftId,
    p_expected_version: draft.version, p_customer_id: customer.id,
    p_expected_customer_commercial_version: customer.commercial_version,
    p_items: lines, p_delivery_mode: "store_immediate", p_delivery_address: null,
    p_delivery_notes: null, p_internal_notes: marker,
    p_delivery_charge: 0, p_cash_on_delivery_charge: 0, p_other_charges: 0,
  });
}

function assertOrder(payload, expected, label) {
  assert.deepEqual(payload.items.map((item) => item.productId), expected.map((item) => item.id), label);
  assert.deepEqual(payload.items.map((item) => item.linePosition), expected.map((_, index) => index + 1), `${label}: linePosition`);
}

const cartCustomer = await createCustomer("CART");
let cartDraft = await createDraft(cartCustomer);
const abcd = [product("A"), product("B"), product("C"), product("D")];
let cartSave = await saveDraft(cartCustomer, cartDraft, abcd.map((item) => line(item)));
assert.ifError(cartSave.error);
cartDraft = cartSave.data;
assertOrder(cartDraft, abcd, "initial A B C D order");

cartSave = await saveDraft(cartCustomer, cartDraft, abcd.map((item, index) => line(item, index === 1 ? 3 : 1)));
assert.ifError(cartSave.error);
cartDraft = cartSave.data;
assertOrder(cartDraft, abcd, "quantity change preserves A B C D");
assert.equal(cartDraft.items[1].quantity, 3);

const acd = [product("A"), product("C"), product("D")];
cartSave = await saveDraft(cartCustomer, cartDraft, acd.map((item) => line(item)));
assert.ifError(cartSave.error);
cartDraft = cartSave.data;
assertOrder(cartDraft, acd, "remove B preserves A C D");
const acdb = [...acd, product("B")];
cartSave = await saveDraft(cartCustomer, cartDraft, acdb.map((item) => line(item)));
assert.ifError(cartSave.error);
cartDraft = cartSave.data;
assertOrder(cartDraft, acdb, "re-add B appends it");
cartSave = await saveDraft(cartCustomer, cartDraft, abcd.map((item) => line(item)));
assert.ifError(cartSave.error);
cartDraft = cartSave.data;
assertOrder(cartDraft, abcd, "undo restores original position");
const restored = await actor.rpc("get_pos_sale_draft_v1", { p_draft_id: cartDraft.draftId });
assert.ifError(restored.error);
assertOrder(restored.data, abcd, "refresh/restore preserves A B C D");

const [competingA, competingB] = await Promise.all([
  saveDraft(cartCustomer, cartDraft, [...abcd].reverse().map((item) => line(item))),
  saveDraft(cartCustomer, cartDraft, abcd.map((item) => line(item, 2))),
]);
assert.equal([competingA, competingB].filter((result) => !result.error).length, 1, "one concurrent revision wins");
const concurrentReload = await actor.rpc("get_pos_sale_draft_v1", { p_draft_id: cartDraft.draftId });
assert.ifError(concurrentReload.error);
assertOrder(
  concurrentReload.data,
  competingA.error ? abcd : [...abcd].reverse(),
  "reload reflects only the winning revision",
);

async function setImmediateDelivery(enabled, reason) {
  const result = await actor.rpc("set_pos_immediate_delivery_v1", { p_enabled: enabled, p_reason: reason });
  assert.ifError(result.error);
  assert.equal(result.data[0].enabled, enabled);
}

async function savedSingleLineDraft(customer, productRow, quantity) {
  const draft = await createDraft(customer);
  const saved = await saveDraft(customer, draft, [line(productRow, quantity)]);
  assert.ifError(saved.error);
  return saved.data;
}

async function confirmCash(client, draft, requestKey, quantity) {
  return client.rpc("confirm_selectable_pos_sale_v1", {
    p_draft_id: draft.draftId, p_request_key: requestKey,
    p_expected_draft_version: draft.version, p_invoice_date: today,
    p_payment_payload: { method: "cash", amount_tendered: 115 * quantity },
  });
}

async function economicCounts(orderId) {
  const movements = await admin.from("inventory_movements").select("id")
    .eq("reference_type", "orders").eq("reference_id", orderId);
  assert.ifError(movements.error);
  const [orders, invoices, payments, receivables, salesOutbox, audits] = await Promise.all([
    admin.from("orders").select("id", { count: "exact", head: true }).eq("id", orderId),
    admin.from("invoices").select("id", { count: "exact", head: true }).eq("order_id", orderId),
    admin.from("payments").select("id", { count: "exact", head: true }).eq("order_id", orderId),
    admin.from("accounts_receivable").select("id", { count: "exact", head: true }).eq("order_id", orderId),
    admin.from("accounting_outbox_v2").select("id", { count: "exact", head: true })
      .eq("source_type", "order").eq("source_id", orderId).eq("event_purpose", "sale_recognized"),
    admin.from("audit_logs").select("id", { count: "exact", head: true })
      .eq("table_name", "orders").eq("record_id", orderId).eq("action", "pos.sale.confirmed_immediate_delivery"),
  ]);
  for (const result of [orders, invoices, payments, receivables, salesOutbox, audits]) assert.ifError(result.error);
  const movementIds = movements.data.map((row) => row.id);
  const cogsOutbox = movementIds.length
    ? await admin.from("accounting_outbox_v2").select("id", { count: "exact", head: true })
      .in("source_id", movementIds).eq("event_purpose", "inventory_cogs")
    : { count: 0, error: null };
  assert.ifError(cogsOutbox.error);
  return {
    orders: orders.count, invoices: invoices.count, payments: payments.count,
    receivables: receivables.count, movements: movements.data.length,
    salesOutbox: salesOutbox.count, cogsOutbox: cogsOutbox.count, audits: audits.count,
  };
}

await setImmediateDelivery(false, `${marker} certify legacy POS status with flag OFF`);
const offCustomer = await createCustomer("OFF");
const offDraft = await savedSingleLineDraft(offCustomer, product("OFF"), 2);
const offConfirmed = await confirmCash(actor, offDraft, crypto.randomUUID(), 2);
assert.ifError(offConfirmed.error);
const offOrder = await admin.from("orders").select("status,tracking_status,delivered_at,delivered_by")
  .eq("id", offConfirmed.data.order_id).single();
assert.ifError(offOrder.error);
assert.equal(offOrder.data.status, "confirmado");
assert.equal(offOrder.data.tracking_status, "confirmado");
assert.equal(offOrder.data.delivered_at, null);
assert.equal(offOrder.data.delivered_by, null);
assert.deepEqual(await economicCounts(offConfirmed.data.order_id), {
  orders: 1, invoices: 1, payments: 1, receivables: 0,
  movements: 1, salesOutbox: 1, cogsOutbox: 1, audits: 0,
});

await setImmediateDelivery(true, `${marker} certify atomic immediate POS delivery with flag ON`);
const onCustomer = await createCustomer("ON");
const onDraft = await savedSingleLineDraft(onCustomer, product("ON"), 2);
const onRequestKey = crypto.randomUUID();
const replayResults = await Promise.all(Array.from({ length: 10 }, (_, index) =>
  confirmCash(index % 2 === 0 ? actor : retryActor, onDraft, onRequestKey, 2)
));
assert.equal(replayResults.filter((result) => !result.error).length, 10, JSON.stringify(replayResults.map((result) => result.error)));
assert.equal(new Set(replayResults.map((result) => result.data.order_id)).size, 1);
assert.equal(replayResults.filter((result) => result.data.replayed).length, 9);
const onOrderId = replayResults[0].data.order_id;
const onOrder = await admin.from("orders").select("status,tracking_status,delivered_at,delivered_by,fiscal_customer_name,fiscal_customer_business_name,fiscal_customer_city,fiscal_customer_address")
  .eq("id", onOrderId).single();
assert.ifError(onOrder.error);
assert.equal(onOrder.data.status, "entregado");
assert.equal(onOrder.data.tracking_status, "entregado");
assert.ok(onOrder.data.delivered_at);
assert.equal(onOrder.data.delivered_by, actorId);
assert.equal(onOrder.data.fiscal_customer_name, onCustomer.contact_name);
assert.equal(onOrder.data.fiscal_customer_business_name, onCustomer.business_name);
assert.equal(onOrder.data.fiscal_customer_city, onCustomer.city);
assert.equal(onOrder.data.fiscal_customer_address, onCustomer.address);
const onInvoice = await admin.from("invoices").select("customer_name,customer_business_name,customer_city,customer_address")
  .eq("order_id", onOrderId).single();
assert.ifError(onInvoice.error);
assert.equal(onInvoice.data.customer_business_name, onCustomer.business_name);
assert.equal(onInvoice.data.customer_city, onCustomer.city);
const onStock = await admin.from("products").select("stock").eq("id", product("ON").id).single();
assert.ifError(onStock.error);
assert.equal(onStock.data.stock, 8);
const onCounts = await economicCounts(onOrderId);
assert.deepEqual(onCounts, {
  orders: 1, invoices: 1, payments: 1, receivables: 0,
  movements: 1, salesOutbox: 1, cogsOutbox: 1, audits: 1,
});

assert.ifError((await admin.from("orders").update({ status: "entregado", tracking_status: "entregado" }).eq("id", onOrderId)).error);
const reDeliveryStock = await admin.from("products").select("stock").eq("id", product("ON").id).single();
assert.ifError(reDeliveryStock.error);
assert.equal(reDeliveryStock.data.stock, 8);
assert.deepEqual(await economicCounts(onOrderId), onCounts, "re-delivery no-op cannot duplicate economics");

const creditCustomer = await createCustomer("CREDIT", true);
const creditDraft = await savedSingleLineDraft(creditCustomer, product("CREDIT"), 2);
const creditConfirmed = await actor.rpc("confirm_selectable_pos_sale_v1", {
  p_draft_id: creditDraft.draftId, p_request_key: crypto.randomUUID(),
  p_expected_draft_version: creditDraft.version, p_invoice_date: today,
  p_payment_payload: { method: "commercial_credit" },
});
assert.ifError(creditConfirmed.error);
const creditOrder = await admin.from("orders").select("status,tracking_status,delivered_at,delivered_by")
  .eq("id", creditConfirmed.data.order_id).single();
assert.ifError(creditOrder.error);
assert.equal(creditOrder.data.status, "entregado");
assert.equal(creditOrder.data.tracking_status, "entregado");
assert.equal(creditOrder.data.delivered_by, actorId);
assert.deepEqual(await economicCounts(creditConfirmed.data.order_id), {
  orders: 1, invoices: 1, payments: 0, receivables: 1,
  movements: 1, salesOutbox: 1, cogsOutbox: 1, audits: 1,
});

const automation = await admin.from("accounting_automation_settings").select("value")
  .eq("key", "automation_mode").single();
assert.ifError(automation.error);
assert.equal(automation.data.value.mode, "disabled");

await setImmediateDelivery(false, `${marker} exercise local kill switch OFF after ON`);
await setImmediateDelivery(true, `${marker} restore final local rollout state ON`);

console.log("Edgar POS cart and immediate closeout local certification: PASS", {
  guard,
  marker,
  cartOrder: "A B C D",
  concurrentRevisionGuard: true,
  flagOffLegacyStatus: true,
  flagOnTenClickReplay: true,
  immediateCashEconomics: onCounts,
  immediateCreditReceivable: true,
  reDeliveryNoOp: true,
  automationMode: automation.data.value.mode,
  finalImmediateDeliveryFlag: "ON",
});
