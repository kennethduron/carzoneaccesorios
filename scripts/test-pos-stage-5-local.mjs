import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") {
  throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required.");
}
const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost):54321\/?$/, "Only local Supabase is allowed.");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!serviceKey || !anonKey) throw new Error("Define local Supabase service and anon keys.");

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const marker = `POS5-${Date.now()}`;
const password = process.env.POS_STAGE5_TEST_PASSWORD ?? `Cz-${crypto.randomUUID()}!a9`;
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Tegucigalpa", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

async function rpc(client, name, args) {
  return client.rpc(name, args);
}

async function createSavedDraft(client, customer, product, quantity = 1) {
  const created = await rpc(client, "create_pos_sale_draft_v1", {
    p_request_key: crypto.randomUUID(), p_customer_id: customer.id,
  });
  assert.ifError(created.error);
  const saved = await rpc(client, "save_pos_sale_draft_v1", {
    p_request_key: crypto.randomUUID(), p_draft_id: created.data.draftId,
    p_expected_version: created.data.version, p_customer_id: customer.id,
    p_expected_customer_commercial_version: customer.commercial_version,
    p_items: [{ productId: product.id, quantity, finalUnitPrice: null,
      priceOverrideReason: null, expectedProductSalesVersion: product.product_sales_version }],
    p_delivery_mode: "store_immediate", p_delivery_address: null,
    p_delivery_notes: null, p_internal_notes: marker,
    p_delivery_charge: 0, p_cash_on_delivery_charge: 0, p_other_charges: 0,
  });
  assert.ifError(saved.error);
  return saved.data;
}

const email = process.env.POS_STAGE5_TEST_EMAIL ?? `${marker}@example.test`;
const createdUser = await admin.auth.admin.createUser({
  email, password, email_confirm: true, user_metadata: { full_name: marker },
});
assert.ifError(createdUser.error);
const userId = createdUser.data.user.id;
const permissions = [
  "pos:create_sale", "pos:access", "pos:customers:search", "customers:read_commercial",
  "customers:read_credit", "pos:drafts:create", "pos:drafts:read", "pos:drafts:edit_own",
  "pos:drafts:edit_any", "pos:drafts:abandon", "pos:products:search", "pos:price_override",
  "pos:confirm_sale", "pos:reprint_documents", "invoices:create",
  "settings:fiscal",
];
const role = await admin.from("roles").upsert({
  name: "admin", description: marker, permissions,
}, { onConflict: "name" }).select("id").single();
assert.ifError(role.error);
assert.ifError((await admin.from("users").update({ role_id: role.data.id, active: true }).eq("id", userId)).error);

const firstClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const secondClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
assert.ifError((await firstClient.auth.signInWithPassword({ email, password })).error);
assert.ifError((await secondClient.auth.signInWithPassword({ email, password })).error);

const customerResult = await admin.from("customers").insert({
  contact_name: marker, email, phone: "99995555", address: "Tegucigalpa",
  city: "Tegucigalpa", source: "pos", lead_status: "cliente", status: "active", active: true,
}).select("id, commercial_version").single();
assert.ifError(customerResult.error);
const customer = customerResult.data;
const categoryResult = await admin.from("categories").select("id").eq("active", true).limit(1).single();
assert.ifError(categoryResult.error);

assert.ifError((await admin.from("company_settings").upsert({
  id: crypto.randomUUID(), company_name: marker, currency: "HNL", tax_rate: 0.15,
  invoice_prefix: "POS5", order_prefix: "POS5", free_shipping_threshold: 3000,
  standard_shipping_fee: 120, first_wholesale_minimum: 10000,
}, { onConflict: "id", ignoreDuplicates: true })).error);
// Exercise the same authenticated administrator path used by the application.
// service_role intentionally has read-only access to fiscal settings.
assert.ifError((await firstClient.from("fiscal_settings").update({
  legal_name: marker, rtn: "08011999123456", cai: `${marker}-CAI`,
  cai_authorization_date: "2026-01-01", invoice_range_start: "000-001-01-00000001",
  invoice_range_end: "000-001-01-00000999", current_invoice_number: "000-001-01-00000001",
  emission_deadline: "2026-12-31", fiscal_address: "Tegucigalpa",
  phone: "99990000", email,
}).eq("id", true)).error);

const productRows = [
  { suffix: "REPLAY", stock: 10 },
  { suffix: "LAST", stock: 1 },
  ...Array.from({ length: 3000 }, (_, index) => ({
    suffix: `CATALOG-${String(index).padStart(4, "0")}`,
    stock: 2,
  })),
].map((item) => ({
  category_id: categoryResult.data.id, sku: `${marker}-${item.suffix}`,
  internal_code: `IC-${marker}-${item.suffix}`, slug: `${marker}-${item.suffix}`.toLowerCase(),
  name: `${marker} ${item.suffix}`, brand: "TEST", description: "Disposable local fixture",
  stock: item.stock, reserved_stock: 0, cost_price: 50, retail_price: 115,
  wholesale_price: 100, wholesale_min_quantity: 2, tax_category: "standard",
  tracks_inventory: true, status: "active", active: true,
}));
const insertedProducts = [];
for (let offset = 0; offset < productRows.length; offset += 500) {
  const batch = await admin.from("products").insert(productRows.slice(offset, offset + 500))
    .select("id, sku, product_sales_version, retail_price");
  assert.ifError(batch.error);
  insertedProducts.push(...batch.data);
}
const bySuffix = (suffix) => insertedProducts.find((product) => product.sku === `${marker}-${suffix}`);

async function measureProductSearch(query) {
  const started = performance.now();
  const result = await rpc(firstClient, "search_pos_products_v1", {
    p_query: query,
    p_customer_id: customer.id,
    p_expected_customer_commercial_version: customer.commercial_version,
    p_include_unavailable: false,
    p_limit: 25,
    p_offset: 0,
  });
  const elapsed = performance.now() - started;
  assert.ifError(result.error);
  assert.equal(result.data.length, 1);
  assert.ok(elapsed < 2000, `Product search took ${Math.round(elapsed)}ms`);
  return elapsed;
}

const searchTimes = {
  name: await measureProductSearch(`${marker} CATALOG-1729`),
  sku: await measureProductSearch(`${marker}-CATALOG-1729`),
  internalCode: await measureProductSearch(`IC-${marker}-CATALOG-1729`),
};

const replayDraft = await createSavedDraft(firstClient, customer, bySuffix("REPLAY"));
const replayKey = crypto.randomUUID();
const replayArgs = {
  p_draft_id: replayDraft.draftId, p_request_key: replayKey,
  p_expected_draft_version: replayDraft.version, p_invoice_date: today,
  p_payment_payload: { method: "cash", amount_tendered: 115 },
};
const doubleClick = await Promise.all([
  rpc(firstClient, "confirm_pos_sale_v1", replayArgs),
  rpc(secondClient, "confirm_pos_sale_v1", replayArgs),
]);
assert.equal(
  doubleClick.filter((entry) => !entry.error).length,
  2,
  JSON.stringify(doubleClick.map((entry) => entry.error && {
    code: entry.error.code,
    message: entry.error.message,
  })),
);
assert.equal(new Set(doubleClick.map((entry) => entry.data.order_id)).size, 1);
assert.equal(doubleClick.filter((entry) => entry.data.replayed).length, 1);

const lastProduct = bySuffix("LAST");
const [lastDraftA, lastDraftB] = await Promise.all([
  createSavedDraft(firstClient, customer, lastProduct),
  createSavedDraft(secondClient, customer, lastProduct),
]);
const lastUnit = await Promise.all([
  rpc(firstClient, "confirm_pos_sale_v1", {
    p_draft_id: lastDraftA.draftId, p_request_key: crypto.randomUUID(),
    p_expected_draft_version: lastDraftA.version, p_invoice_date: today,
    p_payment_payload: { method: "cash", amount_tendered: 115 },
  }),
  rpc(secondClient, "confirm_pos_sale_v1", {
    p_draft_id: lastDraftB.draftId, p_request_key: crypto.randomUUID(),
    p_expected_draft_version: lastDraftB.version, p_invoice_date: today,
    p_payment_payload: { method: "cash", amount_tendered: 115 },
  }),
]);
assert.equal(lastUnit.filter((entry) => !entry.error).length, 1);
const inventoryConflictMessages = new Set([
  "POS_INSUFFICIENT_STOCK",
  "POS_PRODUCT_INACTIVE",
]);
assert.equal(
  lastUnit.filter((entry) => inventoryConflictMessages.has(entry.error?.message)).length,
  1,
  JSON.stringify(lastUnit.map((entry) => entry.error && {
    code: entry.error.code,
    message: entry.error.message,
  })),
);
const stockAfter = await admin.from("products").select("stock").eq("id", lastProduct.id).single();
assert.ifError(stockAfter.error);
assert.equal(stockAfter.data.stock, 0);

const bulkProducts = insertedProducts
  .filter((product) => product.sku.includes(`${marker}-CATALOG-`))
  .slice(0, 20);
const bulkCreated = await rpc(firstClient, "create_pos_sale_draft_v1", {
  p_request_key: crypto.randomUUID(), p_customer_id: customer.id,
});
assert.ifError(bulkCreated.error);
const bulkSaved = await rpc(firstClient, "save_pos_sale_draft_v1", {
  p_request_key: crypto.randomUUID(), p_draft_id: bulkCreated.data.draftId,
  p_expected_version: 1, p_customer_id: customer.id,
  p_expected_customer_commercial_version: customer.commercial_version,
  p_items: bulkProducts.map((product) => ({ productId: product.id, quantity: 1,
    finalUnitPrice: null, priceOverrideReason: null,
    expectedProductSalesVersion: product.product_sales_version })),
  p_delivery_mode: "store_immediate", p_delivery_address: null,
  p_delivery_notes: null, p_internal_notes: marker,
  p_delivery_charge: 0, p_cash_on_delivery_charge: 0, p_other_charges: 0,
});
assert.ifError(bulkSaved.error);
const started = performance.now();
const bulkConfirmed = await rpc(firstClient, "confirm_pos_sale_v1", {
  p_draft_id: bulkSaved.data.draftId, p_request_key: crypto.randomUUID(),
  p_expected_draft_version: bulkSaved.data.version, p_invoice_date: today,
  p_payment_payload: { method: "cash", amount_tendered: 2300 },
});
const elapsed = performance.now() - started;
assert.ifError(bulkConfirmed.error);
assert.ok(elapsed < 5000, `20-line confirmation took ${Math.round(elapsed)}ms`);

console.log("POS Stage 5 local performance: OK", {
  catalogProducts: 3000,
  nameSearchMs: Math.round(searchTimes.name),
  skuSearchMs: Math.round(searchTimes.sku),
  internalCodeSearchMs: Math.round(searchTimes.internalCode),
  twentyLineConfirmationMs: Math.round(elapsed),
  idempotentOneLine: true,
  lastUnitLocking: true,
});
