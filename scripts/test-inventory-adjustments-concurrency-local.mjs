import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { readStage6LocalStatus } from "./pos-stage-6-local-guard.mjs";

assert.equal(process.env.ALLOW_LOCAL_MUTATING_TESTS, "true", "ALLOW_LOCAL_MUTATING_TESTS=true is required.");
const status = readStage6LocalStatus();
const apiUrl = new URL(status.API_URL);
assert.match(apiUrl.hostname, /^(127\.0\.0\.1|localhost)$/);
assert.equal(apiUrl.port, "54321");
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const client = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const marker = `INVENTORY-ADJUSTMENT-CONCURRENCY-LOCAL-ONLY-${Date.now()}`;
const email = `inventory-adjustment-${Date.now()}@example.test`;
const password = `Cz-${randomUUID()}!a9`;
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Tegucigalpa", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

const role = await admin.from("roles").upsert({
  name: "admin",
  description: marker,
  permissions: ["inventory:adjust_read", "inventory:adjust_create", "inventory:adjust_confirm", "inventory:adjust_reverse", "inventory:cost_read"],
}, { onConflict: "name" }).select("id").single();
assert.ifError(role.error);
const authUser = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: marker } });
assert.ifError(authUser.error);
assert.ifError((await admin.from("users").update({ role_id: role.data.id, active: true }).eq("id", authUser.data.user.id)).error);
assert.ifError((await client.auth.signInWithPassword({ email, password })).error);
const category = await admin.from("categories").select("id").eq("active", true).limit(1).single();
assert.ifError(category.error);

const productRows = Array.from({ length: 102 }, (_, index) => ({
  category_id: category.data.id,
  sku: `${marker}-${String(index + 1).padStart(3, "0")}`,
  slug: `${marker}-${index + 1}`.toLowerCase(),
  name: `${marker} PRODUCT ${index + 1}`,
  brand: "TEST",
  stock: 100,
  reserved_stock: 0,
  retail_price: 115,
  wholesale_price: 100,
  cost_price: 50,
  tax_category: "standard",
  tracks_inventory: true,
  status: "active",
  active: true,
}));
const products = await admin.from("products").insert(productRows).select("id");
assert.ifError(products.error);

async function createAdjustment(productIds, requestKey = randomUUID()) {
  const result = await client.rpc("create_inventory_adjustment_v1", {
    p_request_key: requestKey,
    p_effective_date: today,
    p_reference: marker,
    p_notes: "Disposable local concurrency test.",
    p_lines: productIds.map((productId) => ({
      product_id: productId,
      direction: "increase",
      quantity: 1,
      reason_code: "physical_count_surplus",
      unit_cost: 50,
    })),
  });
  assert.ifError(result.error);
  return { id: result.data, requestKey };
}

const doubleClick = await createAdjustment([products.data[0].id]);
const fiveResults = await Promise.all(Array.from({ length: 5 }, () => client.rpc("confirm_inventory_adjustment_v1", {
  p_adjustment_id: doubleClick.id,
  p_expected_version: 1,
  p_request_key: doubleClick.requestKey,
})));
for (const result of fiveResults) assert.ifError(result.error);
const doubleClickMovements = await admin.from("inventory_movements").select("id", { count: "exact", head: true }).eq("reference_id", doubleClick.id);
assert.ifError(doubleClickMovements.error);
assert.equal(doubleClickMovements.count, 1);
const doubleClickAudits = await admin.from("audit_logs").select("id", { count: "exact", head: true }).eq("record_id", doubleClick.id).eq("action", "inventory.adjustment.confirmed");
assert.ifError(doubleClickAudits.error);
assert.equal(doubleClickAudits.count, 1);

const competingA = await createAdjustment([products.data[1].id]);
const competingB = await createAdjustment([products.data[1].id]);
const competingResults = await Promise.all([
  client.rpc("confirm_inventory_adjustment_v1", { p_adjustment_id: competingA.id, p_expected_version: 1, p_request_key: competingA.requestKey }),
  client.rpc("confirm_inventory_adjustment_v1", { p_adjustment_id: competingB.id, p_expected_version: 1, p_request_key: competingB.requestKey }),
]);
assert.equal(competingResults.filter((result) => !result.error).length, 1);
assert.equal(competingResults.find((result) => result.error)?.error?.message, "INVENTORY_ADJUSTMENT_STOCK_CONFLICT");
const competingProduct = await admin.from("products").select("stock,reserved_stock,available_stock").eq("id", products.data[1].id).single();
assert.ifError(competingProduct.error);
assert.deepEqual(competingProduct.data, { stock: 101, reserved_stock: 0, available_stock: 101 });

const performanceMs = {};
for (const size of [1, 10, 50, 100]) {
  const started = Date.now();
  const adjustment = await createAdjustment(products.data.slice(2, 2 + size).map(({ id }) => id));
  const result = await client.rpc("confirm_inventory_adjustment_v1", {
    p_adjustment_id: adjustment.id,
    p_expected_version: 1,
    p_request_key: adjustment.requestKey,
  });
  assert.ifError(result.error);
  performanceMs[size] = Date.now() - started;
  const movements = await admin.from("inventory_movements").select("id", { count: "exact", head: true }).eq("reference_id", adjustment.id);
  assert.ifError(movements.error);
  assert.equal(movements.count, size);
}

console.log("Inventory adjustment concurrency: PASS", {
  fiveSameKey: "one stock delta, one movement, one confirmation audit",
  twoDocumentsSameProduct: "one commit, one typed stale-stock conflict",
  invariantPreserved: true,
  performanceMs,
  marker,
});
