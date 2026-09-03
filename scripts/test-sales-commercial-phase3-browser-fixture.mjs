import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assertStage6LocalEnvironment, readStage6LocalStatus } from "./pos-stage-6-local-guard.mjs";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required.");
const password = process.env.PHASE3_BROWSER_TEST_PASSWORD;
if (!password || password.length < 12) throw new Error("PHASE3_BROWSER_TEST_PASSWORD with at least 12 characters is required.");
const mode = process.argv[2] ?? "setup";
assert.ok(["setup", "cleanup"].includes(mode));

const marker = "PH3-VIS";
const environment = assertStage6LocalEnvironment();
const status = readStage6LocalStatus();
const service = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const accounts = [
  { key: "technical", email: "phase3-browser-technical@example.test", name: "Teresa Propietaria", role: "technical_owner", active: true },
  { key: "business", email: "phase3-browser-business@example.test", name: "Bruno Propietario", role: "business_owner", active: true },
  { key: "admin", email: "phase3-browser-admin@example.test", name: "María Rodríguez", role: "admin", active: true },
  { key: "seller", email: "phase3-browser-seller@example.test", name: "Carlos Martínez", role: "vendedor", active: true },
  { key: "fixed", email: "phase3-browser-fixed@example.test", name: "Andrea López", role: "vendedor", active: true },
  { key: "inactive", email: "phase3-browser-inactive@example.test", name: "Luis Hernández", role: "vendedor", active: false },
];

function sql(query) {
  return execFileSync("docker", ["exec", environment.container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", query], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function isoAgo({ days = 0, hours = 0 } = {}) {
  return new Date(Date.now() - days * 86400000 - hours * 3600000).toISOString();
}
function hnDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
async function browserUsers() {
  const result = await service.from("users").select("id,email").in("email", accounts.map((account) => account.email));
  assert.ifError(result.error);
  return result.data;
}
async function cleanup() {
  const users = await browserUsers();
  const userIds = users.map((user) => user.id);
  sql(`begin;
    select set_config('app.commission_internal','on',true);
    delete from public.sales_commission_events where commission_entry_id in (select entry.id from public.sales_commission_entries entry join public.orders sale on sale.id=entry.order_id where sale.order_number like '${marker}-%');
    delete from public.sales_commission_entries where order_id in (select id from public.orders where order_number like '${marker}-%');
    delete from public.payments where order_id in (select id from public.orders where order_number like '${marker}-%');
    delete from public.pos_price_requests where product_name_snapshot like '${marker}-%';
    delete from public.pos_sale_draft_items where sku_snapshot like '${marker}-%';
    delete from public.pos_sale_drafts where metadata->>'fixture'='${marker}';
    delete from public.order_items where order_id in (select id from public.orders where order_number like '${marker}-%');
    alter table public.pos_seller_attribution_events disable trigger pos_seller_attribution_events_append_only;
    delete from public.pos_seller_attribution_events where order_id in (select id from public.orders where order_number like '${marker}-%');
    alter table public.pos_seller_attribution_events enable trigger pos_seller_attribution_events_append_only;
    delete from public.orders where order_number like '${marker}-%';
    delete from public.internal_notifications where metadata->>'fixture'='${marker}' or metadata->>'ruleId' in (select id::text from public.sales_commission_rules where reason like '${marker}%');
    delete from public.sales_commission_rules where reason like '${marker}%';
    delete from public.customers where source='${marker}';
    alter table public.inventory_movements disable trigger inventory_adjustment_movements_append_only;
    delete from public.inventory_movements where product_id in (select id from public.products where sku like '${marker}-%');
    alter table public.inventory_movements enable trigger inventory_adjustment_movements_append_only;
    delete from public.products where sku like '${marker}-%';
    commit;`);
  for (const userId of userIds) assert.ifError((await service.auth.admin.deleteUser(userId)).error);
}

if (mode === "cleanup") {
  await cleanup();
  console.log("Phase 3 browser fixtures removed.");
  process.exit(0);
}

await cleanup();
const roles = await service.from("roles").select("id,name").in("name", [...new Set(accounts.map((account) => account.role))]);
assert.ifError(roles.error);
const roleIds = Object.fromEntries(roles.data.map((role) => [role.name, role.id]));
for (const account of accounts) assert.ok(roleIds[account.role], `Missing role ${account.role}`);

const users = {};
for (const account of accounts) {
  const created = await service.auth.admin.createUser({ email: account.email, password, email_confirm: true, user_metadata: { full_name: account.name } });
  assert.ifError(created.error);
  const updated = await service.from("users").update({ role_id: roleIds[account.role], full_name: account.name, active: account.active }).eq("id", created.data.user.id);
  assert.ifError(updated.error);
  users[account.key] = created.data.user;
}

const category = await service.from("categories").select("id").eq("active", true).limit(1).single();
assert.ifError(category.error);
const products = Array.from({ length: 18 }, (_, index) => ({
  category_id: category.data.id,
  sku: `${marker}-${String(index + 1).padStart(3, "0")}`,
  internal_code: `CZ-${700 + index}`,
  slug: `${marker.toLowerCase()}-${index + 1}`,
  name: ["Radio Android 9 pulgadas", "Cámara de retroceso HD", "Alarma Genius Z9 Bluetooth", "Dash Kit Toyota Hilux", "Cola de Pato Hilux", "Alerón de Techo LED"][index % 6] + ` ${index + 1}`,
  brand: ["Pioneer", "Genius", "Toyota", "Universal"][index % 4],
  description: "Producto local para validación visual Phase 3.",
  stock: 4 + index,
  retail_price: 1000 + index * 175,
  wholesale_price: 900 + index * 160,
  cost_price: 450 + index * 75,
  status: "active",
  active: true,
  tax_category: "standard",
  product_sales_version: 1,
  tracks_inventory: true,
}));
const insertedProducts = await service.from("products").insert(products).select("id,sku,name,retail_price,wholesale_price,product_sales_version,stock");
assert.ifError(insertedProducts.error);

const customers = Array.from({ length: 18 }, (_, index) => ({
  contact_name: ["Juan Carlos López", "Comercial Hernández", "María López", "José Martínez", "Servicios Rivera", "Taller AutoPro"][index % 6] + (index > 5 ? ` ${index + 1}` : ""),
  business_name: index % 3 === 0 ? `Empresa Local ${index + 1}` : null,
  email: `phase3-customer-${index + 1}@example.test`,
  phone: `9999${String(index).padStart(4, "0")}`,
  tax_id: `08011999${String(index).padStart(6, "0")}`,
  address: `Dirección local ${index + 1}`,
  city: "Tegucigalpa",
  source: marker,
  active: true,
  is_wholesale: index === 0,
  wholesale_status: index === 0 ? "approved" : "none",
  wholesale_approved_at: index === 0 ? isoAgo({ days: 30 }) : null,
  commercial_notes: index === 0 ? "NOTA SENSIBLE QUE NUNCA DEBE VER EL VENDEDOR" : null,
}));
const insertedCustomers = await service.from("customers").insert(customers).select("id,contact_name,commercial_version");
assert.ifError(insertedCustomers.error);

const actor = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
assert.ifError((await actor.auth.signInWithPassword({ email: accounts.find((item) => item.key === "admin").email, password })).error);
for (const rule of [
  { seller: users.seller, type: "PERCENTAGE", value: 4, reason: `${marker} regla histórica inicial de cuatro por ciento.` },
  { seller: users.seller, type: "PERCENTAGE", value: 5, reason: `${marker} regla vigente de cinco por ciento.` },
  { seller: users.fixed, type: "FIXED_AMOUNT", value: 250, reason: `${marker} regla fija vigente de doscientos cincuenta.` },
]) {
  const created = await actor.rpc("create_sales_commission_rule_v1", { p_request_key: randomUUID(), p_seller_user_id: rule.seller.id, p_rule_type: rule.type, p_rule_value: rule.value, p_effective_date: hnDate(), p_reason: rule.reason });
  assert.ifError(created.error);
}
sql(`begin;
  alter table public.sales_commission_rules disable trigger sales_commission_rules_immutable;
  update public.sales_commission_rules set effective_from=now()-interval '30 days',effective_to=now()-interval '7 days'
    where seller_user_id='${users.seller.id}'::uuid and version=1;
  update public.sales_commission_rules set effective_from=now()-interval '7 days'
    where seller_user_id='${users.seller.id}'::uuid and version=2;
  update public.sales_commission_rules set effective_from=now()-interval '30 days'
    where seller_user_id='${users.fixed.id}'::uuid and version=1;
  alter table public.sales_commission_rules enable trigger sales_commission_rules_immutable;
  commit;`);

const orderSpecs = [
  { suffix: "FULL", seller: users.seller, customer: insertedCustomers.data[0], base: 10000, paid: 11500, status: "delivered", hours: 1 },
  { suffix: "PARTIAL", seller: users.seller, customer: insertedCustomers.data[1], base: 8000, paid: 4600, status: "confirmed", hours: 3 },
  { suffix: "OPEN", seller: users.seller, customer: insertedCustomers.data[2], base: 5000, paid: 0, status: "confirmed", hours: 7 },
  { suffix: "REVERSED", seller: users.seller, customer: insertedCustomers.data[3], base: 6000, paid: 3450, status: "cancelled", days: 1 },
  { suffix: "FIXED", seller: users.fixed, customer: insertedCustomers.data[4], base: 5000, paid: 2875, status: "delivered", days: 2 },
];
for (const [index, spec] of orderSpecs.entries()) {
  const orderId = randomUUID();
  const confirmedAt = isoAgo({ days: spec.days ?? 0, hours: spec.hours ?? 0 });
  const total = spec.base * 1.15;
  const initialStatus = spec.status === "cancelled" ? "confirmed" : spec.status;
  const safeCustomerName = spec.customer.contact_name.replaceAll("'", "''");
  sql(`begin;
    select set_config('request.jwt.claim.sub','${spec.seller.id}',true);
    select set_config('request.jwt.claims','{"sub":"${spec.seller.id}","role":"authenticated"}',true);
    insert into public.orders(id,order_number,customer_id,customer_name,phone,customer_phone,delivery_address,
      payment_method,price_mode,subtotal,tax,total,status,source,channel,created_by,confirmed_by,confirmed_at,delivered_at)
    values('${orderId}'::uuid,'${marker}-${spec.suffix}','${spec.customer.id}'::uuid,'${safeCustomerName}',
      '99998${index}00','99998${index}00','Tegucigalpa','cash','retail',${spec.base},${spec.base * 0.15},${total},
      '${initialStatus}','pos','store','${spec.seller.id}'::uuid,'${spec.seller.id}'::uuid,'${confirmedAt}'::timestamptz,
      ${initialStatus === "delivered" ? `'${confirmedAt}'::timestamptz` : "null"});
    commit;`);
  const product = insertedProducts.data[index];
  const item = await service.from("order_items").insert({
    order_id: orderId, product_id: product.id, sku: product.sku, product_name: product.name, quantity: 1,
    applied_price_mode: "retail", unit_price: spec.base, line_total: spec.base,
    retail_price_snapshot: spec.base + (index === 0 ? 500 : 0), wholesale_price_snapshot: spec.base * 0.9,
    tax_category_snapshot: "standard", tax_rate_snapshot: 0.15, taxable_base_snapshot: spec.base,
    tax_amount_snapshot: spec.base * 0.15, exempt_amount_snapshot: 0,
    price_override_reason: null, price_overridden_by: null, tracks_inventory_snapshot: true,
  });
  assert.ifError(item.error);
  sql(`select public.create_commission_for_confirmed_order_v1('${orderId}'::uuid);`);
  if (spec.paid > 0) {
    const payment = await service.from("payments").insert({ order_id: orderId, customer_id: spec.customer.id, method: "cash", payment_method: "cash", status: "approved", payment_status: "approved", amount: spec.paid, paid_at: confirmedAt });
    assert.ifError(payment.error);
  }
  if (spec.status === "cancelled") {
    const cancelled = await service.from("orders").update({ status: "cancelled", commercial_reversal_reason: `${marker} cancelación visual auditada.` }).eq("id", orderId);
    assert.ifError(cancelled.error);
  }
}

const draftId = randomUUID();
const draft = await service.from("pos_sale_drafts").insert({
  id: draftId, owner_user_id: users.seller.id, customer_id: insertedCustomers.data[0].id,
  customer_commercial_version: insertedCustomers.data[0].commercial_version, pricing_mode_snapshot: "retail",
  status: "active", version: 1, merchandise_gross: 1500, taxable_gross: 1500, taxable_base: 1500,
  tax_amount: 225, grand_total: 1725, validation_status: "valid", last_saved_by: users.seller.id,
  metadata: { fixture: marker }, expires_at: isoAgo({ days: -7 }),
}).select("id,version").single();
assert.ifError(draft.error);
const draftProduct = insertedProducts.data[0];
const draftItem = await service.from("pos_sale_draft_items").insert({
  draft_id: draftId, product_id: draftProduct.id, product_sales_version: draftProduct.product_sales_version,
  sku_snapshot: draftProduct.sku, internal_code_snapshot: "CZ-700", product_name_snapshot: draftProduct.name,
  brand_snapshot: "Pioneer", pricing_source: "retail", base_unit_price: 1500, final_unit_price: 1500,
  quantity: 1, tax_category_snapshot: "standard", tax_rate_snapshot: 0.15, line_merchandise_gross: 1500,
  line_taxable_base: 1500, line_tax_amount: 225, line_exempt_amount: 0, available_stock_snapshot: draftProduct.stock,
  stock_observed_at: new Date().toISOString(), stock_status: "available", validation_status: "valid",
  cost_floor_validated: true, cost_validated_at: new Date().toISOString(), tracks_inventory_snapshot: true, line_position: 1,
}).select("id").single();
assert.ifError(draftItem.error);

for (const [index, requestStatus] of ["pending", "approved", "rejected"].entries()) {
  const product = insertedProducts.data[index];
  const priceRequest = await service.from("pos_price_requests").insert({
    request_key: randomUUID(), payload_hash: createHash("sha256").update(`${marker}-${requestStatus}`).digest("hex"), seller_user_id: users.seller.id,
    seller_display_name_snapshot: "Carlos Martínez", draft_id: draftId, draft_version: 1, draft_item_id: draftItem.data.id,
    customer_id: insertedCustomers.data[0].id, customer_commercial_version: insertedCustomers.data[0].commercial_version,
    product_id: product.id, product_sales_version: product.product_sales_version, product_name_snapshot: `${marker}-${product.name}`,
    sku_snapshot: product.sku, quantity: 1, base_unit_price: product.retail_price,
    requested_unit_price: Number(product.retail_price) - 100, reason: "Cliente frecuente solicita precio local especial.",
    status: requestStatus, requested_at: isoAgo({ hours: index + 1 }),
    decided_at: requestStatus === "pending" ? null : isoAgo({ hours: index }), decided_by: requestStatus === "pending" ? null : users.admin.id,
    decision_reason: requestStatus === "pending" ? null : `Decisión local ${requestStatus}.`, expires_at: requestStatus === "approved" ? isoAgo({ hours: -1 }) : null,
  });
  assert.ifError(priceRequest.error);
}

function authenticatedClient() {
  return createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}

const sellerClient = authenticatedClient();
assert.ifError((await sellerClient.auth.signInWithPassword({ email: accounts.find((item) => item.key === "seller").email, password })).error);
const workspace = await sellerClient.rpc("get_my_seller_workspace_v1");
assert.ifError(workspace.error);
assert.equal(workspace.data.seller.name, "Carlos Martínez");
assert.ok(workspace.data.summary.monthSales >= 3, "Seller workspace must contain populated own-sale metrics.");
assert.ok(workspace.data.commission.potential > 0, "Seller workspace must contain commission potential.");
assert.ok(workspace.data.commission.earned > 0, "Seller workspace must contain earned commission.");
assert.ok(workspace.data.commission.remaining > 0, "Seller workspace must contain remaining commission.");
assert.ok(workspace.data.commission.reversed > 0, "Seller workspace must contain reversed commission history.");

const sellerCommissions = await sellerClient.rpc("list_my_sales_commissions_v1", {
  p_from: hnDate(), p_to: hnDate(), p_status: null, p_query: null, p_limit: 20, p_offset: 0,
});
assert.ifError(sellerCommissions.error);
assert.ok(sellerCommissions.data.results.length >= 3, "Seller must read populated own commissions.");
assert.ok(sellerCommissions.data.results.every((entry) => entry.sellerId === users.seller.id), "Seller commission RPC must not expose another seller.");

const sellerProducts = await sellerClient.rpc("search_seller_products_v1", { p_query: "", p_limit: 15, p_offset: 0 });
assert.ifError(sellerProducts.error);
assert.equal(sellerProducts.data.results.length, 15, "Seller product page must remain bounded to 15 rows.");
assert.equal(sellerProducts.data.total, 18);
for (const product of sellerProducts.data.results) {
  assert.equal("costPrice" in product, false, "Seller product payload must not expose cost.");
  assert.equal("margin" in product, false, "Seller product payload must not expose margin.");
}

const elevatedDenied = await sellerClient.rpc("list_commission_sellers_v1", { p_query: null, p_active: "all", p_limit: 20, p_offset: 0 });
assert.ok(elevatedDenied.error, "Seller must not list elevated seller-management data.");
const directUpdateDenied = await sellerClient.from("sales_commission_entries").update({ earned_amount: 0 }).eq("seller_id", users.seller.id);
assert.ok(directUpdateDenied.error, "Seller must not directly update commission entries.");
const directDeleteDenied = await sellerClient.from("sales_commission_events").delete().eq("seller_id", users.seller.id);
assert.ok(directDeleteDenied.error, "Seller must not directly delete commission events.");

for (const key of ["technical", "business", "admin"]) {
  const elevatedClient = authenticatedClient();
  assert.ifError((await elevatedClient.auth.signInWithPassword({ email: accounts.find((item) => item.key === key).email, password })).error);
  const sellerList = await elevatedClient.rpc("list_commission_sellers_v1", { p_query: null, p_active: "all", p_limit: 20, p_offset: 0 });
  assert.ifError(sellerList.error);
  assert.equal(sellerList.data.total, 3, `${key} must receive the same seller-management capability.`);
  const commissionList = await elevatedClient.rpc("list_sales_commissions_v1", {
    p_seller_id: null, p_status: null, p_rule_type: null, p_from: hnDate(), p_to: hnDate(),
    p_query: null, p_sort: "newest", p_limit: 20, p_offset: 0,
  });
  assert.ifError(commissionList.error);
  assert.ok(commissionList.data.results.length >= 3, `${key} must receive the same commission-management capability.`);
  await elevatedClient.auth.signOut();
}

await sellerClient.auth.signOut();
console.log(`Phase 3 browser fixtures ready: ${accounts.length} users, ${insertedCustomers.data.length} customers, ${insertedProducts.data.length} products, ${orderSpecs.length} orders.`);
