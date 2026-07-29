import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!serviceKey || !anonKey) throw new Error("Define local Supabase service and anon keys.");
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const marker = `POS4-${Date.now()}`;
const password = `Cz-${crypto.randomUUID()}!a9`;
const authIds = [];
let customerId;
let draftId;
const draftIds = [];

async function count(table) {
  const { count: value, error } = await admin.from(table).select("*", { count: "exact", head: true });
  assert.ifError(error); return value ?? 0;
}
async function actor(role) {
  const email = `${marker}-${role}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: `POS4 ${role}` } });
  assert.ifError(error); authIds.push(data.user.id);
  const ownerPermissions = ["pos:create_sale", "pos:access", "pos:customers:search", "customers:read_commercial", "customers:read_credit", "pos:drafts:create", "pos:drafts:read", "pos:drafts:edit_own", "pos:drafts:edit_any", "pos:drafts:abandon", "pos:products:search", "pos:price_override"];
  const { data: roleRow, error: roleError } = await admin.from("roles").upsert({ name: role, description: `Local POS4 ${role}`, permissions: role === "admin" ? ownerPermissions : [] }, { onConflict: "name" }).select("id").single(); assert.ifError(roleError);
  const { error: updateError } = await admin.from("users").update({ role_id: roleRow.id, active: true }).eq("id", data.user.id); assert.ifError(updateError);
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: loginError } = await client.auth.signInWithPassword({ email, password }); assert.ifError(loginError);
  return { client, email, userId: data.user.id };
}
async function rpc(client, name, args = {}) { return client.rpc(name, args); }
async function cleanup() {
  for (const id of draftIds) await admin.from("pos_sale_draft_items").delete().eq("draft_id", id);
  for (const id of draftIds) await admin.from("pos_sale_drafts").delete().eq("id", id);
  await admin.from("pos_idempotency_requests").delete().like("operation", "%pos_sale_draft_v1");
  await admin.from("products").delete().like("sku", `${marker}%`);
  if (customerId) await admin.from("customers").delete().eq("id", customerId);
  for (const id of authIds) await admin.auth.admin.deleteUser(id);
}

try {
  const protectedTables = ["orders", "order_items", "payments", "invoices", "customer_credit_transactions", "inventory_reservations", "inventory_movements", "accounts_receivable", "financial_events", "accounting_outbox_v2", "journal_entries"];
  const before = Object.fromEntries(await Promise.all(protectedTables.map(async (table) => [table, await count(table)])));
  const { data: fiscalBefore, error: fiscalBeforeError } = await admin.from("fiscal_settings").select("*"); assert.ifError(fiscalBeforeError);
  const owner = await actor("admin");
  const denied = await actor("vendedor");
  const deniedSearch = await rpc(denied.client, "search_pos_products_v1", { p_query: marker, p_limit: 10, p_offset: 0 });
  assert.equal(deniedSearch.error?.code, "42501");

  const { data: customer, error: customerError } = await admin.from("customers").insert({ contact_name: `${marker} Cliente`, phone: "+50499990000", email: `${marker}@example.test`, source: "pos", lead_status: "cliente", active: true, status: "active" }).select("id, commercial_version").single();
  assert.ifError(customerError); customerId = customer.id;
  const { data: category, error: categoryError } = await admin.from("categories").select("id").eq("active", true).limit(1).single(); assert.ifError(categoryError);
  const volume = Array.from({ length: 3000 }, (_, index) => ({ category_id: category.id, sku: `${marker}-${String(index).padStart(4, "0")}`, internal_code: `${marker}-OEM-${index}`, slug: `${marker.toLowerCase()}-${index}`, name: index === 2999 ? `${marker} Objetivo Especial` : `${marker} Producto ${index}`, brand: index % 2 ? "Marca A" : "Marca B", description: "Fixture local Stage 4", stock: 10, reserved_stock: 2, cost_price: 50, retail_price: 115, wholesale_price: 100, wholesale_min_quantity: index === 0 ? 3 : 1, tax_category: index === 1 ? "exempt" : "standard", status: "active", active: true }));
  for (let index = 0; index < volume.length; index += 250) { const { error } = await admin.from("products").insert(volume.slice(index, index + 250)); assert.ifError(error); }
  const started = performance.now();
  const searched = await rpc(owner.client, "search_pos_products_v1", { p_query: "Objetivo Especial", p_customer_id: customerId, p_expected_customer_commercial_version: customer.commercial_version, p_limit: 25, p_offset: 0 });
  const elapsed = performance.now() - started;
  assert.ifError(searched.error); assert.equal(searched.data.length, 1); assert.ok(elapsed < 2000, `3,000-product search took ${elapsed}ms`); assert.ok(!Object.hasOwn(searched.data[0], "cost_price")); assert.equal(Number(searched.data[0].included_tax_rate), 0.15);
  for (const [query, predicate] of [[volume[0].sku, (row) => row.sku === volume[0].sku], [volume[1].internal_code, (row) => row.internal_code === volume[1].internal_code], [`${marker}-00`, (row) => row.sku.startsWith(`${marker}-00`)], ["Producto 29", (row) => row.product_name.includes("Producto 29")], ["Marca A", (row) => row.brand === "Marca A"]]) {
    const result = await rpc(owner.client, "search_pos_products_v1", { p_query: query, p_customer_id: customerId, p_expected_customer_commercial_version: customer.commercial_version, p_limit: 25, p_offset: 0 }); assert.ifError(result.error); assert.ok(result.data.some(predicate), `Search failed for ${query}`);
  }
  const paged = await rpc(owner.client, "search_pos_products_v1", { p_query: marker, p_customer_id: customerId, p_expected_customer_commercial_version: customer.commercial_version, p_limit: 10, p_offset: 10 }); assert.ifError(paged.error); assert.equal(paged.data.length, 10);
  const brandFiltered = await rpc(owner.client, "search_pos_products_v1", { p_query: "", p_customer_id: customerId, p_expected_customer_commercial_version: customer.commercial_version, p_brand: "Marca A", p_limit: 25, p_offset: 0 }); assert.ifError(brandFiltered.error); assert.ok(brandFiltered.data.length > 0); assert.ok(brandFiltered.data.every((row) => row.brand === "Marca A"));
  const categoryFiltered = await rpc(owner.client, "search_pos_products_v1", { p_query: "", p_customer_id: customerId, p_expected_customer_commercial_version: customer.commercial_version, p_category_id: category.id, p_limit: 25, p_offset: 0 }); assert.ifError(categoryFiltered.error); assert.ok(categoryFiltered.data.length > 0); assert.ok(categoryFiltered.data.every((row) => row.category_id === category.id));

  const createKey = crypto.randomUUID();
  const created = await rpc(owner.client, "create_pos_sale_draft_v1", { p_request_key: createKey, p_customer_id: customerId }); assert.ifError(created.error); draftId = created.data.draftId; draftIds.push(draftId);
  const replay = await rpc(owner.client, "create_pos_sale_draft_v1", { p_request_key: createKey, p_customer_id: customerId }); assert.ifError(replay.error); assert.equal(replay.data.draftId, draftId); assert.equal(replay.data.idempotentReplay, true);
  const product = volume[0];
  const { data: savedProduct, error: savedProductError } = await admin.from("products").select("id, product_sales_version, stock, reserved_stock").eq("sku", product.sku).single(); assert.ifError(savedProductError);
  const stockBefore = { stock: savedProduct.stock, reservedStock: savedProduct.reserved_stock };
  const saveArgs = { p_request_key: crypto.randomUUID(), p_draft_id: draftId, p_expected_version: 1, p_customer_id: customerId, p_expected_customer_commercial_version: customer.commercial_version, p_items: [{ productId: savedProduct.id, quantity: 2, finalUnitPrice: null, priceOverrideReason: null, expectedProductSalesVersion: savedProduct.product_sales_version }], p_delivery_mode: "store_immediate", p_delivery_address: null, p_delivery_notes: null, p_internal_notes: "Fixture", p_delivery_charge: 0, p_cash_on_delivery_charge: 0, p_other_charges: 0 };
  const saved = await rpc(owner.client, "save_pos_sale_draft_v1", saveArgs); assert.ifError(saved.error); assert.equal(saved.data.items.length, 1); assert.equal(saved.data.version, 2);
  assert.equal(saved.data.items[0].pricingSource, "retail"); assert.equal(Number(saved.data.items[0].baseUnitPrice), 115); assert.equal(saved.data.items[0].priceOverridden, false); assert.ok(!Object.hasOwn(saved.data.items[0], "costPrice"));
  const savedReplay = await rpc(owner.client, "save_pos_sale_draft_v1", saveArgs); assert.ifError(savedReplay.error); assert.equal(savedReplay.data.version, 2); assert.equal(savedReplay.data.idempotentReplay, true);

  const reusedKey = await rpc(owner.client, "save_pos_sale_draft_v1", { ...saveArgs, p_items: [{ ...saveArgs.p_items[0], quantity: 3 }] });
  assert.ok(reusedKey.error, "A request key reused with another payload must fail");

  const belowCost = await rpc(owner.client, "save_pos_sale_draft_v1", { ...saveArgs, p_request_key: crypto.randomUUID(), p_expected_version: 2, p_items: [{ ...saveArgs.p_items[0], finalUnitPrice: 49, priceOverrideReason: "Debajo del costo" }] });
  assert.equal(belowCost.error?.code, "22023");
  const missingReason = await rpc(owner.client, "save_pos_sale_draft_v1", { ...saveArgs, p_request_key: crypto.randomUUID(), p_expected_version: 2, p_items: [{ ...saveArgs.p_items[0], finalUnitPrice: 100, priceOverrideReason: "   " }] });
  assert.equal(missingReason.error?.code, "22023");
  const zeroPrice = await rpc(owner.client, "save_pos_sale_draft_v1", { ...saveArgs, p_request_key: crypto.randomUUID(), p_expected_version: 2, p_items: [{ ...saveArgs.p_items[0], finalUnitPrice: 0, priceOverrideReason: "Precio cero" }] });
  assert.equal(zeroPrice.error?.code, "22023");
  const positiveFee = await rpc(owner.client, "save_pos_sale_draft_v1", { ...saveArgs, p_request_key: crypto.randomUUID(), p_expected_version: 2, p_delivery_charge: 1 });
  assert.equal(positiveFee.error?.code, "22023");
  const staleProduct = await rpc(owner.client, "save_pos_sale_draft_v1", { ...saveArgs, p_request_key: crypto.randomUUID(), p_expected_version: 2, p_items: [{ ...saveArgs.p_items[0], expectedProductSalesVersion: savedProduct.product_sales_version - 1 }] });
  assert.equal(staleProduct.error?.code, "PT409");
  const staleCustomer = await rpc(owner.client, "save_pos_sale_draft_v1", { ...saveArgs, p_request_key: crypto.randomUUID(), p_expected_version: 2, p_expected_customer_commercial_version: customer.commercial_version + 1 });
  assert.equal(staleCustomer.error?.code, "PT409");

  const overridden = await rpc(owner.client, "save_pos_sale_draft_v1", { ...saveArgs, p_request_key: crypto.randomUUID(), p_expected_version: 2, p_items: [{ ...saveArgs.p_items[0], finalUnitPrice: 100, priceOverrideReason: "Promocion autorizada" }] });
  assert.ifError(overridden.error); assert.equal(overridden.data.version, 3); assert.equal(overridden.data.items[0].priceOverridden, true); assert.equal(Number(overridden.data.items[0].finalUnitPrice), 100);
  const { count: overrideAuditCount, error: overrideAuditError } = await admin.from("audit_logs").select("*", { count: "exact", head: true }).eq("action", "pos.price_override").contains("new_data", { product_id: savedProduct.id }); assert.ifError(overrideAuditError); assert.equal(overrideAuditCount, 1);

  const concurrentBase = { ...saveArgs, p_expected_version: 3 };
  const ownerSecondSession = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: secondLoginError } = await ownerSecondSession.auth.signInWithPassword({ email: owner.email, password }); assert.ifError(secondLoginError);
  const concurrent = await Promise.all([
    rpc(owner.client, "save_pos_sale_draft_v1", { ...concurrentBase, p_request_key: crypto.randomUUID(), p_items: [{ ...saveArgs.p_items[0], quantity: 3, finalUnitPrice: null, priceOverrideReason: null }] }),
    rpc(ownerSecondSession, "save_pos_sale_draft_v1", { ...concurrentBase, p_request_key: crypto.randomUUID(), p_items: [{ ...saveArgs.p_items[0], quantity: 4, finalUnitPrice: null, priceOverrideReason: null }] }),
  ]);
  assert.equal(concurrent.filter((result) => !result.error).length, 1);
  const concurrentErrors = concurrent.filter((result) => result.error);
  assert.equal(concurrentErrors.length, 1);
  assert.match(concurrentErrors[0].error.message, /borrador cambio|otra pestana|Recarga/i);
  const current = await rpc(owner.client, "get_pos_sale_draft_v1", { p_draft_id: draftId }); assert.ifError(current.error); assert.equal(current.data.version, 4);
  assert.equal(concurrentErrors[0].error.code, "PT409"); assert.match(concurrentErrors[0].error.details ?? "", /currentVersion/);

  const deniedRead = await rpc(denied.client, "get_pos_sale_draft_v1", { p_draft_id: draftId }); assert.equal(deniedRead.error?.code, "42501");
  const directRead = await owner.client.from("pos_sale_drafts").select("id").limit(1); assert.ok(directRead.error, "Authenticated users must not read draft tables directly");
  const directWrite = await owner.client.from("pos_sale_drafts").insert({ customer_id: customerId, customer_commercial_version: customer.commercial_version, pricing_mode_snapshot: "retail" }); assert.ok(directWrite.error, "Authenticated users must not write draft tables directly");

  const { data: wholesaleCustomer, error: wholesaleError } = await admin.from("customers").update({ is_wholesale: true, wholesale_status: "approved", user_id: owner.userId, company_name: `${marker} Empresa` }).eq("id", customerId).select("commercial_version").single(); assert.ifError(wholesaleError);
  const wholesaleRetailQuantity = await rpc(owner.client, "save_pos_sale_draft_v1", { ...saveArgs, p_request_key: crypto.randomUUID(), p_expected_version: 4, p_expected_customer_commercial_version: wholesaleCustomer.commercial_version, p_items: [{ ...saveArgs.p_items[0], quantity: 2 }] });
  assert.ifError(wholesaleRetailQuantity.error); assert.equal(wholesaleRetailQuantity.data.version, 5); assert.equal(wholesaleRetailQuantity.data.items[0].pricingSource, "retail"); assert.equal(Number(wholesaleRetailQuantity.data.items[0].baseUnitPrice), 115);
  const wholesaleMinimum = await rpc(owner.client, "save_pos_sale_draft_v1", { ...saveArgs, p_request_key: crypto.randomUUID(), p_expected_version: 5, p_expected_customer_commercial_version: wholesaleCustomer.commercial_version, p_items: [{ ...saveArgs.p_items[0], quantity: 3 }] });
  assert.ifError(wholesaleMinimum.error); assert.equal(wholesaleMinimum.data.version, 6); assert.equal(wholesaleMinimum.data.items[0].pricingSource, "wholesale"); assert.equal(Number(wholesaleMinimum.data.items[0].baseUnitPrice), 100);

  const missingCostSku = volume[2].sku;
  const { data: missingCostProduct, error: missingCostUpdateError } = await admin.from("products").update({ cost_price: 0 }).eq("sku", missingCostSku).select("id, product_sales_version").single(); assert.ifError(missingCostUpdateError);
  const missingCost = await rpc(owner.client, "save_pos_sale_draft_v1", { ...saveArgs, p_request_key: crypto.randomUUID(), p_expected_version: 6, p_expected_customer_commercial_version: wholesaleCustomer.commercial_version, p_items: [{ productId: missingCostProduct.id, quantity: 1, finalUnitPrice: 10, priceOverrideReason: "Validacion sin costo", expectedProductSalesVersion: missingCostProduct.product_sales_version }] });
  assert.equal(missingCost.error?.code, "22023");

  const inactiveSku = volume[3].sku;
  const { data: inactiveProduct, error: inactiveUpdateError } = await admin.from("products").update({ active: false, status: "inactive" }).eq("sku", inactiveSku).select("id, product_sales_version").single(); assert.ifError(inactiveUpdateError);
  const inactiveSearch = await rpc(owner.client, "search_pos_products_v1", { p_query: inactiveSku, p_customer_id: customerId, p_expected_customer_commercial_version: wholesaleCustomer.commercial_version, p_include_unavailable: true, p_limit: 10, p_offset: 0 }); assert.ifError(inactiveSearch.error); assert.equal(inactiveSearch.data.length, 1); assert.equal(inactiveSearch.data[0].active, false);
  const inactiveExcluded = await rpc(owner.client, "search_pos_products_v1", { p_query: inactiveSku, p_customer_id: customerId, p_expected_customer_commercial_version: wholesaleCustomer.commercial_version, p_include_unavailable: false, p_limit: 10, p_offset: 0 }); assert.ifError(inactiveExcluded.error); assert.equal(inactiveExcluded.data.length, 0);
  const inactiveSave = await rpc(owner.client, "save_pos_sale_draft_v1", { ...saveArgs, p_request_key: crypto.randomUUID(), p_expected_version: 6, p_expected_customer_commercial_version: wholesaleCustomer.commercial_version, p_items: [{ productId: inactiveProduct.id, quantity: 1, finalUnitPrice: null, priceOverrideReason: null, expectedProductSalesVersion: inactiveProduct.product_sales_version }] });
  assert.equal(inactiveSave.error?.code, "22023");

  const exhaustedSku = volume[4].sku;
  const { data: exhaustedProduct, error: exhaustedUpdateError } = await admin.from("products").update({ stock: 2, reserved_stock: 2 }).eq("sku", exhaustedSku).select("id, product_sales_version").single(); assert.ifError(exhaustedUpdateError);
  const exhaustedSearch = await rpc(owner.client, "search_pos_products_v1", { p_query: exhaustedSku, p_customer_id: customerId, p_expected_customer_commercial_version: wholesaleCustomer.commercial_version, p_include_unavailable: true, p_limit: 10, p_offset: 0 }); assert.ifError(exhaustedSearch.error); assert.equal(exhaustedSearch.data.length, 1); assert.equal(Number(exhaustedSearch.data[0].available_stock), 0);
  const exhaustedSave = await rpc(owner.client, "save_pos_sale_draft_v1", { ...saveArgs, p_request_key: crypto.randomUUID(), p_expected_version: 6, p_expected_customer_commercial_version: wholesaleCustomer.commercial_version, p_items: [{ productId: exhaustedProduct.id, quantity: 1, finalUnitPrice: null, priceOverrideReason: null, expectedProductSalesVersion: exhaustedProduct.product_sales_version }] });
  assert.equal(exhaustedSave.error?.code, "22023");

  const abandonKey = crypto.randomUUID();
  const abandoned = await rpc(owner.client, "abandon_pos_sale_draft_v1", { p_request_key: abandonKey, p_draft_id: draftId, p_expected_version: 6 }); assert.ifError(abandoned.error); assert.equal(abandoned.data.status, "abandoned"); assert.equal(abandoned.data.version, 7);
  const abandonedReplay = await rpc(owner.client, "abandon_pos_sale_draft_v1", { p_request_key: abandonKey, p_draft_id: draftId, p_expected_version: 6 }); assert.ifError(abandonedReplay.error); assert.equal(abandonedReplay.data.idempotentReplay, true);

  const expiring = await rpc(owner.client, "create_pos_sale_draft_v1", { p_request_key: crypto.randomUUID(), p_customer_id: customerId }); assert.ifError(expiring.error); draftIds.push(expiring.data.draftId);
  const { error: expireUpdateError } = await admin.from("pos_sale_drafts").update({ expires_at: new Date(Date.now() - 60_000).toISOString() }).eq("id", expiring.data.draftId); assert.ifError(expireUpdateError);
  const expired = await rpc(owner.client, "get_pos_sale_draft_v1", { p_draft_id: expiring.data.draftId }); assert.ifError(expired.error); assert.equal(expired.data.status, "expired");

  const { data: stockAfter, error: stockAfterError } = await admin.from("products").select("stock, reserved_stock").eq("id", savedProduct.id).single(); assert.ifError(stockAfterError); assert.deepEqual({ stock: stockAfter.stock, reservedStock: stockAfter.reserved_stock }, stockBefore, "Draft cart changed stock or reservations");
  assert.equal(await count("pos_sale_drafts"), 2); assert.equal(await count("pos_sale_draft_items"), 1);
  const after = Object.fromEntries(await Promise.all(protectedTables.map(async (table) => [table, await count(table)])));
  assert.deepEqual(after, before, "Stage 4 changed an economic table");
  const { data: fiscalAfter, error: fiscalAfterError } = await admin.from("fiscal_settings").select("*"); assert.ifError(fiscalAfterError); assert.deepEqual(fiscalAfter, fiscalBefore, "Stage 4 changed fiscal configuration");
  console.log(`POS Stage 4 local DB, fiscal pricing, concurrency, idempotency, RLS and 3,000-product search: OK (${Math.round(elapsed)}ms)`);
} finally { await cleanup(); }
