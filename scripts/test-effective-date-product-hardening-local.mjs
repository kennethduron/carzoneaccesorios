import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assertStage6LocalEnvironment, readStage6LocalStatus } from "./pos-stage-6-local-guard.mjs";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required.");
assertStage6LocalEnvironment();
const status = readStage6LocalStatus();
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, options);
const anon = createClient(status.API_URL, status.ANON_KEY, options);
const suffix = randomUUID().slice(0, 8);
const password = `Local-${randomUUID()}!a9`;
const email = `effective-date-${suffix}@example.test`;

const technicalRole = await admin.from("roles").select("id").eq("name", "technical_owner").single();
assert.ifError(technicalRole.error);
const createdUser = await admin.auth.admin.createUser({ email, password, email_confirm: true });
assert.ifError(createdUser.error);
const actorId = createdUser.data.user.id;
assert.ifError((await admin.from("users").update({ role_id: technicalRole.data.id, full_name: `Effective date ${suffix}`, active: true }).eq("id", actorId)).error);
const actor = createClient(status.API_URL, status.ANON_KEY, options);
assert.ifError((await actor.auth.signInWithPassword({ email, password })).error);

const supplierId = randomUUID();
assert.ifError((await admin.from("suppliers").insert({ id: supplierId, name: `PAYMENT DATE LOCAL ${suffix}`, is_active: true, created_by: actorId })).error);

let payableAccount = await admin.from("accounting_accounts").select("id").eq("code", "2101001").eq("is_active", true).maybeSingle();
assert.ifError(payableAccount.error);
if (!payableAccount.data) {
  payableAccount = await admin.from("accounting_accounts").insert({
    id: randomUUID(), code: "2101001", name: "PROVEEDORES LOCALES", type: "liability", normal_balance: "credit", is_active: true, created_by: actorId,
  }).select("id").single();
  assert.ifError(payableAccount.error);
}
const bankAccountId = randomUUID();
assert.ifError((await admin.from("accounting_accounts").insert({
  id: bankAccountId, code: `BANK-${suffix}`, name: `Banco local ${suffix}`, type: "asset", normal_balance: "debit", is_active: true, created_by: actorId,
})).error);
assert.ifError((await admin.from("accounting_mappings").insert([
  { mapping_type: "default_account", source_key: "accounts_payable", account_id: payableAccount.data.id, priority: 999, is_active: true, effective_from: "2025-01-01", created_by: actorId },
  { mapping_type: "payment_method", source_key: "supplier_payment_bank", account_id: bankAccountId, priority: 999, is_active: true, effective_from: "2025-01-01", created_by: actorId },
])).error);
assert.ifError((await admin.from("accounting_feature_flags").update({ state: "enabled", cutover_at: "2026-01-01T06:00:00.000Z", updated_by: actorId }).in("key", ["supplier_payment_draft_v2", "supplier_multi_invoice_payment_v1"])).error);

async function createPayable(amount = 100) {
  const id = randomUUID();
  const result = await admin.from("accounts_payable").insert({
    id, supplier_id: supplierId, total_amount: amount, paid_amount: 0, due_date: "2026-08-31", status: "pending", currency: "HNL", created_by: actorId,
  });
  assert.ifError(result.error);
  return id;
}

async function attachRecognition(payableId, date, state = "published") {
  const eventId = randomUUID();
  const journalId = randomUUID();
  const published = state === "published";
  assert.ifError((await admin.from("journal_entries").insert({
    id: journalId,
    entry_number: `DATE-${suffix}-${randomUUID().slice(0, 6)}`,
    entry_date: date,
    description: "Synthetic recognition",
    status: published ? "publicada" : state === "cancelled" ? "anulada" : "borrador",
    source_type: "financial_event",
    source_id: eventId,
    created_by: actorId,
    updated_by: actorId,
    posted_by: published ? actorId : null,
    posted_at: published ? new Date().toISOString() : null,
  })).error);
  assert.ifError((await admin.from("financial_events").insert({
    id: eventId,
    source_type: "accounts_payable",
    source_id: payableId,
    event_purpose: "accounts_payable_created",
    posting_version: "v1",
    status: published ? "posted" : "pending",
    occurred_at: `${date}T18:00:00.000Z`,
    source_snapshot: {},
    validation_errors: [],
    journal_entry_id: journalId,
    created_by: actorId,
  })).error);
  return { eventId, journalId };
}

const beforeId = await createPayable();
const equalId = await createPayable();
const afterId = await createPayable();
const afterSecondId = await createPayable();
const draftId = await createPayable();
const missingId = await createPayable();
const cancelledId = await createPayable();
await attachRecognition(beforeId, "2026-08-01");
await attachRecognition(equalId, "2026-08-07");
await attachRecognition(afterId, "2026-08-14");
await attachRecognition(afterSecondId, "2026-08-13");
await attachRecognition(draftId, "2026-08-06", "draft");
await attachRecognition(cancelledId, "2026-08-06", "cancelled");

async function resolve(payableId, date = "2026-08-07") {
  const result = await admin.rpc("resolve_accounts_payable_payment_recognition_v2", {
    p_accounts_payable_id: payableId,
    p_effective_payment_date: date,
    p_payment_id: null,
  });
  assert.ifError(result.error);
  return result.data;
}
assert.equal((await resolve(beforeId)).recognized, true, "recognition before payment must pass");
assert.equal((await resolve(equalId)).recognized, true, "recognition on payment date must pass");
assert.equal((await resolve(afterId)).recognized, true, "published recognition after payment date must pass");
assert.equal((await resolve(draftId)).recognized, false, "draft recognition must fail");
assert.equal((await resolve(missingId)).recognized, false, "missing recognition must fail");
assert.equal((await resolve(cancelledId)).recognized, false, "cancelled recognition must fail");

const register = (requestKey, applications, paidDate = "2026-08-07") => actor.rpc("register_supplier_multi_payment_v1", {
  p_request_key: requestKey,
  p_supplier_id: supplierId,
  p_payment_method: "bank_transfer",
  p_paid_date: paidDate,
  p_reference: `LOCAL-${suffix}`,
  p_applications: applications,
  p_notes: "Synthetic effective-date test",
  p_receipt_public_id: null,
});

const mixedKey = randomUUID();
const mixedApplications = [beforeId, equalId, afterId, afterSecondId].map((id) => ({ accounts_payable_id: id, applied_amount: 10 }));
const mixed = await register(mixedKey, mixedApplications);
assert.ifError(mixed.error);
assert.equal(mixed.data.application_count, 4);
assert.equal(mixed.data.accounting_date, "2026-08-07");
const mixedPaymentId = mixed.data.payment_id;
const persistedPayment = await admin.from("supplier_payments").select("id,paid_at").eq("id", mixedPaymentId).single();
assert.ifError(persistedPayment.error);
assert.match(persistedPayment.data.paid_at, /^2026-08-07/);
const mixedAllocations = await admin.from("supplier_payment_applications").select("id,recognition_date").eq("supplier_payment_id", mixedPaymentId);
assert.ifError(mixedAllocations.error);
assert.equal(mixedAllocations.data.length, 4);
assert.equal(mixedAllocations.data.filter((row) => row.recognition_date > "2026-08-07").length, 2);
const completedAudit = await admin.from("accounting_event_log").select("metadata").eq("event_type", "supplier_multi_payment_completed").eq("entity_id", mixedPaymentId).single();
assert.ifError(completedAudit.error);
assert.equal(completedAudit.data.metadata.effective_payment_precedes_recognition_date, true);
assert.equal(Number(completedAudit.data.metadata.backdated_recognition_count), 2);
const processedOutbox = await admin.rpc("process_accounting_outbox_v2", {
  target_outbox_id: mixed.data.outbox_id,
  worker_token: `effective-date-${suffix}`,
  force_retry: false,
});
assert.ifError(processedOutbox.error);
assert.equal(processedOutbox.data.ok, true);
const paymentDraft = await admin.from("journal_entries").select("id,entry_date,status").eq("id", processedOutbox.data.journal_entry_id).single();
assert.ifError(paymentDraft.error);
assert.equal(paymentDraft.data.entry_date, "2026-08-07");
assert.equal(paymentDraft.data.status, "borrador");
const paymentLines = await admin.from("journal_entry_lines").select("debit,credit").eq("journal_entry_id", paymentDraft.data.id);
assert.ifError(paymentLines.error);
assert.equal(paymentLines.data.reduce((sum, line) => sum + Number(line.debit), 0), 40);
assert.equal(paymentLines.data.reduce((sum, line) => sum + Number(line.credit), 0), 40);

const replay = await register(mixedKey, mixedApplications);
assert.ifError(replay.error);
assert.equal(replay.data.replayed, true);
assert.equal(replay.data.payment_id, mixedPaymentId);

const atomicRecognizedId = await createPayable();
const atomicMissingId = await createPayable();
await attachRecognition(atomicRecognizedId, "2026-08-01");
const atomicBefore = await admin.from("accounts_payable").select("id,balance,paid_amount").in("id", [atomicRecognizedId, atomicMissingId]).order("id");
assert.ifError(atomicBefore.error);
const paymentCountBefore = await admin.from("supplier_payments").select("id", { count: "exact", head: true }).eq("supplier_id", supplierId);
const rejectedMixed = await register(randomUUID(), [
  { accounts_payable_id: atomicRecognizedId, applied_amount: 10 },
  { accounts_payable_id: atomicMissingId, applied_amount: 10 },
]);
assert.ok(rejectedMixed.error, "one missing recognition must reject the whole payment");
const atomicAfter = await admin.from("accounts_payable").select("id,balance,paid_amount").in("id", [atomicRecognizedId, atomicMissingId]).order("id");
assert.ifError(atomicAfter.error);
assert.deepEqual(atomicAfter.data, atomicBefore.data);
const paymentCountAfter = await admin.from("supplier_payments").select("id", { count: "exact", head: true }).eq("supplier_id", supplierId);
assert.equal(paymentCountAfter.count, paymentCountBefore.count);

const insufficient = await register(randomUUID(), [{ accounts_payable_id: atomicRecognizedId, applied_amount: 999999 }]);
assert.ok(insufficient.error, "insufficient balance must be denied");

const preCutoverId = await createPayable();
await attachRecognition(preCutoverId, "2026-08-01");
const preCutover = await register(randomUUID(), [{ accounts_payable_id: preCutoverId, applied_amount: 10 }], "2025-12-15");
assert.ifError(preCutover.error);
assert.equal(preCutover.data.accounting_date, "2025-12-15", "the selected date must not be replaced by cutover, creation or current time");
const preCutoverPayment = await admin.from("supplier_payments").select("paid_at").eq("id", preCutover.data.payment_id).single();
assert.ifError(preCutoverPayment.error);
assert.match(preCutoverPayment.data.paid_at, /^2025-12-15/);

const closedPayableId = await createPayable();
await attachRecognition(closedPayableId, "2026-08-01");
const localPeriod = await admin.from("accounting_periods").insert({
  name: `Closed local ${suffix}`, start_date: "2026-06-01", end_date: "2026-06-30", status: "open", fiscal_year: 2026, period_type: "monthly", created_by: actorId,
}).select("id").single();
assert.ifError(localPeriod.error);
const closedPeriod = await actor.rpc("close_accounting_period", { period_id: localPeriod.data.id });
assert.ifError(closedPeriod.error);
assert.equal(closedPeriod.data.closed, true);
const closed = await register(randomUUID(), [{ accounts_payable_id: closedPayableId, applied_amount: 10 }], "2026-06-15");
assert.ok(closed.error, "closed payment period must be denied");

const concurrentId = await createPayable();
await attachRecognition(concurrentId, "2026-08-08");
const concurrentKey = randomUUID();
const concurrent = await Promise.all([
  register(concurrentKey, [{ accounts_payable_id: concurrentId, applied_amount: 10 }]),
  register(concurrentKey, [{ accounts_payable_id: concurrentId, applied_amount: 10 }]),
]);
concurrent.forEach((result) => assert.ifError(result.error));
assert.equal(new Set(concurrent.map((result) => result.data.payment_id)).size, 1);
assert.deepEqual(concurrent.map((result) => result.data.replayed).sort(), [false, true]);

const categories = await admin.from("categories").select("id").eq("active", true).limit(1);
assert.ifError(categories.error);
assert.ok(categories.data[0]?.id);
const categoryId = categories.data[0].id;
const baseProduct = (sku) => ({
  category_id: categoryId,
  sku,
  internal_code: `OEM-${sku}`,
  slug: sku.toLowerCase(),
  name: `Producto sintético ${sku}`,
  brand: "Marca local",
  vehicle_brand: null,
  vehicle_model: null,
  vehicle_year_start: null,
  vehicle_year_end: null,
  short_description: null,
  description: "Synthetic local only",
  features: null,
  specifications: null,
  compatibility_notes: null,
  low_stock_threshold: 2,
  min_stock: 2,
  cost_price: 10,
  retail_price: 20,
  wholesale_price: 15,
  wholesale_min_quantity: 1,
  tax_category: "standard",
  tracks_inventory: true,
  is_new: true,
  status: "active",
  active: true,
});
const saveProduct = (sku, targetStock = 7, client = actor, category = categoryId) => client.rpc("save_product_catalog_v3_locked", {
  target_product_id: null,
  product_data: { ...baseProduct(sku), category_id: category },
  images_data: [],
  target_stock: targetStock,
});

const validSku = `HARD-${suffix}-VALID`;
const validProduct = await saveProduct(validSku);
assert.ifError(validProduct.error);
assert.equal(validProduct.data[0].stock_after, 7);
const validRow = await admin.from("products").select("id,stock").eq("sku", validSku).single();
assert.ifError(validRow.error);
assert.equal(validRow.data.stock, 7);

const preservedStockSku = `HARD-${suffix}-NO-STOCK-PERMISSION`;
const preservedStock = await saveProduct(preservedStockSku, null);
assert.ifError(preservedStock.error);
assert.equal(preservedStock.data[0].stock_movement_id, null);
assert.equal(preservedStock.data[0].stock_after, 0);

const rollbackSku = `HARD-${suffix}-ROLLBACK`;
const rollback = await saveProduct(rollbackSku, -1);
assert.ok(rollback.error, "invalid stock must fail the atomic RPC");
const rollbackRows = await admin.from("products").select("id", { count: "exact", head: true }).eq("sku", rollbackSku);
assert.equal(rollbackRows.count, 0, "stock failure must roll back the product row");

const invalidCategorySku = `HARD-${suffix}-CATEGORY`;
const invalidCategory = await saveProduct(invalidCategorySku, 1, actor, randomUUID());
assert.ok(invalidCategory.error);
const invalidCategoryRows = await admin.from("products").select("id", { count: "exact", head: true }).eq("sku", invalidCategorySku);
assert.equal(invalidCategoryRows.count, 0);

const unauthorized = await saveProduct(`HARD-${suffix}-ANON`, 1, anon);
assert.ok(unauthorized.error, "anonymous product creation must be denied");

const concurrentSku = `HARD-${suffix}-CONCURRENT`;
const concurrentProducts = await Promise.all([saveProduct(concurrentSku, 3), saveProduct(concurrentSku, 3)]);
assert.equal(concurrentProducts.filter((result) => !result.error).length, 1);
assert.equal(concurrentProducts.filter((result) => result.error).length, 1);
const concurrentProductRows = await admin.from("products").select("id", { count: "exact", head: true }).eq("sku", concurrentSku);
assert.equal(concurrentProductRows.count, 1, "concurrent duplicate submits must create exactly one product");

console.log("effective-date payment and product hardening local integration: PASS");
