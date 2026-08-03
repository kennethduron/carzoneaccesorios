import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import {
  assertStage6LocalEnvironment,
  readStage6LocalStatus,
  stage6Marker,
} from "./pos-stage-6-local-guard.mjs";

const guard = assertStage6LocalEnvironment();
const status = readStage6LocalStatus();
process.env.ALLOW_LOCAL_MUTATING_TESTS = "true";
process.env.SUPABASE_URL = status.API_URL;
process.env.SUPABASE_ANON_KEY = status.ANON_KEY;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
process.env.POS_TEST_MARKER_PREFIX = stage6Marker;
process.env.POS_STAGE5_TEST_EMAIL = `${stage6Marker.toLowerCase()}@example.test`;
process.env.POS_STAGE5_TEST_PASSWORD = "Stage6-Local-Only!2026";

const stage6Admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const enabledFlags = await stage6Admin.from("accounting_feature_flags")
  .update({
    state: "enabled",
    cutover_at: "2026-07-28T20:30:00.000Z",
    notes: `${stage6Marker} isolated accounting routing certification`,
  })
  .in("key", ["sales_draft_v2", "cogs_draft_v2"])
  .select("key,state");
assert.ifError(enabledFlags.error);
assert.equal(enabledFlags.data.length, 2);
assert.ok(enabledFlags.data.every((flag) => flag.state === "enabled"));

await import("./test-pos-stage-5-local.mjs");

const admin = stage6Admin;
const actor = createClient(status.API_URL, status.ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const signIn = await actor.auth.signInWithPassword({
  email: process.env.POS_STAGE5_TEST_EMAIL,
  password: process.env.POS_STAGE5_TEST_PASSWORD,
});
assert.ifError(signIn.error);
const actorId = signIn.data.user.id;
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Tegucigalpa", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());
const marker = `${stage6Marker}-HARDENING`;

const existingCustomer = await admin.from("customers")
  .select("id,commercial_version").eq("email", process.env.POS_STAGE5_TEST_EMAIL).single();
assert.ifError(existingCustomer.error);
const customerSearchStarted = performance.now();
const customerSearch = await actor.rpc("search_pos_customers_v1", {
  p_query: stage6Marker, p_limit: 25, p_offset: 0, p_include_inactive: false,
});
const customerSearchMs = performance.now() - customerSearchStarted;
assert.ifError(customerSearch.error);
assert.ok(customerSearch.data.length >= 1);
assert.ok(customerSearchMs < 2000);

const category = await admin.from("categories").select("id").eq("active", true).limit(1).single();
assert.ifError(category.error);
const product = await admin.from("products").insert({
  category_id: category.data.id,
  sku: `${marker}-SERVICE`, internal_code: `${marker}-SERVICE`, slug: `${marker}-service`.toLowerCase(),
  name: `${marker} SERVICE`, brand: stage6Marker, description: "Isolated Stage 6 fixture",
  stock: 0, reserved_stock: 0, cost_price: 100, retail_price: 200, wholesale_price: 180,
  wholesale_min_quantity: 1, tax_category: "standard", tracks_inventory: false,
  status: "active", active: true,
}).select("id,product_sales_version").single();
assert.ifError(product.error);
const cardAccount = await admin.from("accounting_accounts").insert({
  code: `${stage6Marker}-CARD`,
  name: `${stage6Marker} CARD BRIDGE`,
  type: "asset",
  normal_balance: "debit",
  description: "Isolated generic-card bridge fixture for Stage 6 certification",
  created_by: actorId,
}).select("id").single();
assert.ifError(cardAccount.error);
assert.ifError((await admin.from("accounting_mappings").insert({
  mapping_type: "payment_method",
  source_key: "card",
  account_id: cardAccount.data.id,
  priority: 1,
  is_active: true,
  effective_from: today,
  metadata: {
    marker: stage6Marker,
    purpose: "generic-card-local-certification",
  },
  created_by: actorId,
})).error);

async function createDraft(customerId, commercialVersion, finalUnitPrice = null) {
  const created = await actor.rpc("create_selectable_pos_sale_draft_v1", {
    p_request_key: crypto.randomUUID(), p_customer_id: customerId,
  });
  assert.ifError(created.error);
  const saved = await actor.rpc("save_pos_sale_draft_v1", {
    p_request_key: crypto.randomUUID(), p_draft_id: created.data.draftId,
    p_expected_version: created.data.version, p_customer_id: customerId,
    p_expected_customer_commercial_version: commercialVersion,
    p_items: [{
      productId: product.data.id, quantity: 1, finalUnitPrice,
      priceOverrideReason: finalUnitPrice === null ? null : `${stage6Marker} authorized local price`,
      expectedProductSalesVersion: product.data.product_sales_version,
    }],
    p_delivery_mode: "store_immediate", p_delivery_address: null,
    p_delivery_notes: null, p_internal_notes: marker,
    p_delivery_charge: 0, p_cash_on_delivery_charge: 0, p_other_charges: 0,
  });
  assert.ifError(saved.error);
  return saved.data;
}

for (const payment of [
  { method: "bank_transfer", verified: true, reference: `${marker}-TRANSFER` },
  { method: "card", verified: true, reference: `${marker}-CARD` },
]) {
  const draft = await createDraft(existingCustomer.data.id, existingCustomer.data.commercial_version);
  const confirmed = await actor.rpc("confirm_selectable_pos_sale_v1", {
    p_draft_id: draft.draftId, p_request_key: crypto.randomUUID(),
    p_expected_draft_version: draft.version, p_invoice_date: today, p_payment_payload: payment,
  });
  assert.ifError(confirmed.error);
  assert.equal(confirmed.data.payment_method, payment.method);
}

const manualDraft = await createDraft(existingCustomer.data.id, existingCustomer.data.commercial_version, 150);
const manualConfirmed = await actor.rpc("confirm_selectable_pos_sale_v1", {
  p_draft_id: manualDraft.draftId, p_request_key: crypto.randomUUID(),
  p_expected_draft_version: manualDraft.version, p_invoice_date: today,
  p_payment_payload: { method: "cash", amount_tendered: 150 },
});
assert.ifError(manualConfirmed.error);
const manualLine = await admin.from("order_items")
  .select("unit_price,price_override_reason,price_overridden_by")
  .eq("order_id", manualConfirmed.data.order_id).single();
assert.ifError(manualLine.error);
assert.equal(Number(manualLine.data.unit_price), 150);
assert.equal(manualLine.data.price_overridden_by, actorId);
assert.match(manualLine.data.price_override_reason, /POS-STAGE6-LOCAL-ONLY/);

const creditCustomer = await admin.from("customers").insert({
  contact_name: `${marker} CREDIT`, email: `${marker.toLowerCase()}-credit@example.test`,
  phone: "99996666", address: "Tegucigalpa", city: "Tegucigalpa", source: "pos",
  lead_status: "cliente", status: "active", active: true,
}).select("id,commercial_version").single();
assert.ifError(creditCustomer.error);
assert.ifError((await admin.from("customer_credit_accounts").insert({
  customer_id: creditCustomer.data.id, is_credit_enabled: true, credit_limit: 300,
  terms_days: 30, status: "active", activated_at: new Date().toISOString(), activated_by: actorId,
})).error);
const currentCreditCustomer = await admin.from("customers")
  .select("id,commercial_version")
  .eq("id", creditCustomer.data.id)
  .single();
assert.ifError(currentCreditCustomer.error);
const [creditDraftA, creditDraftB] = await Promise.all([
  createDraft(currentCreditCustomer.data.id, currentCreditCustomer.data.commercial_version),
  createDraft(currentCreditCustomer.data.id, currentCreditCustomer.data.commercial_version),
]);
const creditStarted = performance.now();
const creditResults = await Promise.all([creditDraftA, creditDraftB].map((draft) =>
  actor.rpc("confirm_selectable_pos_sale_v1", {
    p_draft_id: draft.draftId, p_request_key: crypto.randomUUID(),
    p_expected_draft_version: draft.version, p_invoice_date: today,
    p_payment_payload: { method: "commercial_credit" },
  })
));
const creditConcurrencyMs = performance.now() - creditStarted;
assert.equal(creditResults.filter((result) => !result.error).length, 1);
assert.equal(creditResults.filter((result) => result.error?.message === "POS_CREDIT_INSUFFICIENT").length, 1);
const creditOrderId = creditResults.find((result) => !result.error).data.order_id;
assert.equal((await admin.from("payments").select("id", { count: "exact", head: true }).eq("order_id", creditOrderId)).count, 0);
assert.equal((await admin.from("accounts_receivable").select("id", { count: "exact", head: true }).eq("order_id", creditOrderId)).count, 1);

const recoveryStarted = performance.now();
const recovered = await actor.rpc("recover_pos_sale_confirmation_v1", { p_draft_id: manualDraft.draftId });
const recoveryMs = performance.now() - recoveryStarted;
assert.ifError(recovered.error);
assert.equal(recovered.data.replayed, true);
assert.equal(recovered.data.order_id, manualConfirmed.data.order_id);
const salesOutboxes = await admin.from("accounting_outbox_v2")
  .select("id,source_id,status")
  .eq("feature_key", "sales_draft_v2");
assert.ifError(salesOutboxes.error);
assert.ok(salesOutboxes.data.length >= 7);
assert.equal(new Set(salesOutboxes.data.map((row) => row.source_id)).size, salesOutboxes.data.length);
const cogsOutboxes = await admin.from("accounting_outbox_v2")
  .select("id,source_id,status")
  .eq("feature_key", "cogs_draft_v2");
assert.ifError(cogsOutboxes.error);
assert.ok(cogsOutboxes.data.length >= 3);
const journalEntries = await admin.from("journal_entries")
  .select("id", { count: "exact", head: true });
assert.ifError(journalEntries.error);
assert.equal(journalEntries.count, 0);
const automation = await admin.from("accounting_automation_settings")
  .select("value")
  .eq("key", "automation_mode")
  .single();
assert.ifError(automation.error);
assert.equal(automation.data.value.mode, "disabled");

console.log("POS Stage 6 isolated economic certification: PASS", {
  guard,
  marker: stage6Marker,
  customerSearchMs: Math.round(customerSearchMs),
  recoveryMs: Math.round(recoveryMs),
  creditConcurrencyMs: Math.round(creditConcurrencyMs),
  tenClickReplay: true,
  bankTransfer: true,
  genericCard: true,
  manualPrice: true,
  concurrentCreditLocking: true,
  prospectiveAccountingRouting: {
    salesOutboxes: salesOutboxes.data.length,
    cogsOutboxes: cogsOutboxes.data.length,
    automaticJournalEntries: journalEntries.count,
  },
});
