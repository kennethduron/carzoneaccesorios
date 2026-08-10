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
const marker = `POS-OVERDUE-CONCURRENCY-${Date.now()}`;
const email = `${marker.toLowerCase()}@example.test`;
const password = `Cz-${crypto.randomUUID()}!a9`;
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Tegucigalpa", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const yesterday = new Date(`${today}T12:00:00-06:00`);
yesterday.setDate(yesterday.getDate() - 1);
const yesterdayText = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Tegucigalpa", year: "numeric", month: "2-digit", day: "2-digit",
}).format(yesterday);

const createdUser = await admin.auth.admin.createUser({ email, password, email_confirm: true });
assert.ifError(createdUser.error);
const userId = createdUser.data.user.id;
const role = await admin.from("roles").upsert({
  name: "admin", description: marker,
  permissions: [
    "pos:access", "pos:create_sale", "pos:customers:search", "customers:read_commercial",
    "customers:read_credit", "pos:drafts:create", "pos:drafts:read", "pos:drafts:edit_own",
    "pos:drafts:edit_any", "pos:products:search", "pos:confirm_sale", "invoices:create", "settings:fiscal",
  ],
}, { onConflict: "name" }).select("id").single();
assert.ifError(role.error);
assert.ifError((await admin.from("users").update({ role_id: role.data.id, active: true }).eq("id", userId)).error);

const first = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const second = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
assert.ifError((await first.auth.signInWithPassword({ email, password })).error);
assert.ifError((await second.auth.signInWithPassword({ email, password })).error);
assert.ifError((await admin.from("company_settings").insert({
  id: crypto.randomUUID(), company_name: marker, currency: "HNL", tax_rate: 0.15,
  invoice_prefix: "POSO", order_prefix: "POSO", free_shipping_threshold: 3000,
  standard_shipping_fee: 120, first_wholesale_minimum: 10000,
  created_at: "1900-01-01T00:00:00Z",
})).error);
assert.ifError((await first.from("fiscal_settings").update({
  legal_name: marker, rtn: "08011999123456", cai: `${marker}-CAI`,
  cai_authorization_date: "2026-01-01", invoice_range_start: "000-001-01-00000001",
  invoice_range_end: "000-001-01-00000999", current_invoice_number: "000-001-01-00000001",
  emission_deadline: "2026-12-31", fiscal_address: "Tegucigalpa",
  phone: "99990000", email,
}).eq("id", true)).error);

const customerResult = await admin.from("customers").insert({
  contact_name: marker, email, phone: "99996666", address: "Tegucigalpa", city: "Tegucigalpa",
  source: "pos", lead_status: "cliente", status: "active", active: true,
}).select("id,commercial_version").single();
assert.ifError(customerResult.error);
const customerId = customerResult.data.id;
assert.ifError((await admin.from("customer_credit_accounts").insert({
  customer_id: customerId, is_credit_enabled: true, credit_limit: 10000,
  terms_days: 30, status: "active", activated_at: new Date().toISOString(), activated_by: userId,
})).error);
assert.ifError((await admin.from("accounts_receivable").insert({
  customer_id: customerId, historical_invoice_number: `${marker}-OVERDUE`,
  original_amount: 1600, balance_due: 1600, due_date: yesterdayText, status: "open",
})).error);

const category = await admin.from("categories").select("id").eq("active", true).limit(1).single();
assert.ifError(category.error);
const product = await admin.from("products").insert({
  category_id: category.data.id, sku: marker, internal_code: marker, slug: marker.toLowerCase(),
  name: marker, brand: "TEST", description: "Disposable local fixture", stock: 0,
  reserved_stock: 0, cost_price: 0, retail_price: 230, wholesale_price: 200,
  wholesale_min_quantity: 2, tax_category: "standard", tracks_inventory: false,
  status: "active", active: true,
}).select("id,product_sales_version").single();
assert.ifError(product.error);

const flag = await first.rpc("set_pos_credit_overdue_override_v1", {
  p_enabled: true, p_reason: "Enable disposable local concurrency test",
});
assert.ifError(flag.error);

async function savedDraft(client) {
  const customer = await admin.from("customers").select("id,commercial_version").eq("id", customerId).single();
  assert.ifError(customer.error);
  const created = await client.rpc("create_selectable_pos_sale_draft_v1", {
    p_request_key: crypto.randomUUID(), p_customer_id: customerId,
  });
  assert.ifError(created.error);
  const saved = await client.rpc("save_pos_sale_draft_v1", {
    p_request_key: crypto.randomUUID(), p_draft_id: created.data.draftId,
    p_expected_version: created.data.version, p_customer_id: customerId,
    p_expected_customer_commercial_version: customer.data.commercial_version,
    p_items: [{ productId: product.data.id, quantity: 1, finalUnitPrice: null,
      priceOverrideReason: null, expectedProductSalesVersion: product.data.product_sales_version }],
    p_delivery_mode: "store_immediate", p_delivery_address: null, p_delivery_notes: null,
    p_internal_notes: marker, p_delivery_charge: 0, p_cash_on_delivery_charge: 0,
    p_other_charges: 0,
  });
  assert.ifError(saved.error);
  return saved.data;
}

const draft = await savedDraft(first);
const requestKey = crypto.randomUUID();
const args = {
  p_draft_id: draft.draftId, p_request_key: requestKey,
  p_expected_draft_version: draft.version, p_invoice_date: today,
  p_payment_payload: { method: "commercial_credit", overdue_override_reason: "Concurrent local authorization reason" },
};
const clicks = await Promise.all(Array.from({ length: 2 }, (_, index) =>
  (index % 2 ? second : first).rpc("confirm_pos_sale_with_charge_descriptions_v1", args)
));
assert.equal(clicks.filter(({ error }) => error).length, 0, JSON.stringify(clicks.map(({ error }) => error)));
assert.equal(new Set(clicks.map(({ data }) => data.order_id)).size, 1);
assert.equal(clicks.filter(({ data }) => data.replayed).length, 1);
const orderId = clicks[0].data.order_id;

const [orders, receivables, invoices, payments, movements, audits] = await Promise.all([
  admin.from("orders").select("id", { count: "exact", head: true }).eq("pos_draft_id", draft.draftId),
  admin.from("accounts_receivable").select("id", { count: "exact", head: true }).eq("order_id", orderId),
  admin.from("invoices").select("id", { count: "exact", head: true }).eq("order_id", orderId),
  admin.from("payments").select("id", { count: "exact", head: true }).eq("order_id", orderId),
  admin.from("inventory_movements").select("id", { count: "exact", head: true }).eq("reference_id", orderId),
  admin.from("audit_logs").select("id", { count: "exact", head: true })
    .eq("record_id", draft.draftId).eq("action", "pos.credit_overdue_override_authorized"),
]);
for (const result of [orders, receivables, invoices, payments, movements, audits]) assert.ifError(result.error);
assert.deepEqual([orders.count, receivables.count, invoices.count, payments.count, movements.count, audits.count], [1, 1, 1, 0, 0, 1]);

assert.ifError((await admin.from("customer_credit_accounts").update({ credit_limit: 2110 }).eq("customer_id", customerId)).error);
const [draftA, draftB] = await Promise.all([savedDraft(first), savedDraft(second)]);
const competing = await Promise.all([
  first.rpc("confirm_pos_sale_with_charge_descriptions_v1", { ...args, p_draft_id: draftA.draftId,
    p_request_key: crypto.randomUUID(), p_expected_draft_version: draftA.version }),
  second.rpc("confirm_pos_sale_with_charge_descriptions_v1", { ...args, p_draft_id: draftB.draftId,
    p_request_key: crypto.randomUUID(), p_expected_draft_version: draftB.version }),
]);
assert.equal(competing.filter(({ error }) => !error).length, 1);
assert.equal(competing.filter(({ error }) => error?.message === "POS_CREDIT_INSUFFICIENT").length, 1);

console.log("POS overdue credit override local concurrency: PASS", {
  clicks: 2, canonicalOrders: orders.count, authorizationAudits: audits.count,
  competingCreditSalesAccepted: 1, competingCreditSalesRejected: 1,
});
