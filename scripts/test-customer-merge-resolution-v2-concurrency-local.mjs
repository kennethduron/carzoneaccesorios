import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") {
  throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required.");
}
const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost):54321\/?$/, "Only local Supabase is allowed.");
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
assert.ok(serviceKey && anonKey, "Local Supabase keys are required.");

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, serviceKey, options);
const marker = `MERGE-V2-CONCURRENCY-${Date.now()}`;
const email = `${marker.toLowerCase()}@example.test`;
const password = `Local-${crypto.randomUUID()}!a9`;
const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
assert.ifError(created.error);
const actorId = created.data.user.id;
const role = await admin.from("roles").select("id").eq("name", "technical_owner").single();
assert.ifError(role.error);
assert.ifError((await admin.from("users").update({ role_id: role.data.id, full_name: marker, active: true }).eq("id", actorId)).error);

const first = createClient(url, anonKey, options);
const second = createClient(url, anonKey, options);
assert.ifError((await first.auth.signInWithPassword({ email, password })).error);
assert.ifError((await second.auth.signInWithPassword({ email, password })).error);
assert.ifError((await admin.from("customer_feature_flags").update({ enabled: true, enabled_at: new Date().toISOString(), reason: "Local V2 concurrency test only." }).eq("key", "customer_merge_execution_v1")).error);

const customerRows = await admin.from("customers").insert([
  { business_name: marker, contact_name: marker, email, phone: "99007711", status: "active", active: true },
  { business_name: marker, contact_name: marker, email, phone: "99007711", status: "active", active: true },
]).select("id");
assert.ifError(customerRows.error);
const [primaryId, secondaryId] = customerRows.data.map((row) => row.id);
const creditId = crypto.randomUUID();
assert.ifError((await admin.from("customer_credit_accounts").insert({
  id: creditId, customer_id: primaryId, is_credit_enabled: true,
  credit_limit: 100, terms_days: 25, status: "active", activated_at: new Date().toISOString(),
})).error);
assert.ifError((await admin.from("accounts_receivable").insert([
  { customer_id: primaryId, historical_invoice_number: `${marker}-P`, original_amount: 80, balance_due: 80, due_date: "2026-09-01", status: "open" },
  { customer_id: secondaryId, historical_invoice_number: `${marker}-S`, original_amount: 100, balance_due: 100, due_date: "2026-07-30", status: "overdue" },
])).error);

const preview = await first.rpc("preview_customer_merge_v1", {
  p_primary_customer_id: primaryId,
  p_secondary_customer_id: secondaryId,
});
assert.ifError(preview.error);
assert.equal(preview.data.creditExposure.resolutionRequired, true);
const requestKey = `customer-merge-v2-${crypto.randomUUID()}`;
const args = {
  p_request_key: requestKey,
  p_primary_customer_id: primaryId,
  p_secondary_customer_id: secondaryId,
  p_expected_primary_commercial_version: preview.data.primaryCommercialVersion,
  p_expected_secondary_commercial_version: preview.data.secondaryCommercialVersion,
  p_preview_hash: preview.data.previewHash,
  p_identity_decisions: {},
  p_credit_decision: { overLimitResolution: "DISABLE_AND_ZERO_LIMIT" },
  p_commercial_decision: {},
  p_reason: "Concurrent local V2 customer merge fixture.",
  p_source: "crm",
};
const responses = await Promise.all([first.rpc("merge_customers_v1", args), second.rpc("merge_customers_v1", args)]);
for (const response of responses) assert.ifError(response.error);
assert.ok(responses.every((response) => response.data.ok === true));
assert.equal(new Set(responses.map((response) => response.data.operationId)).size, 1);
assert.deepEqual(responses.map((response) => response.data.idempotentReplay).sort(), [false, true]);

const [operation, secondary, credit] = await Promise.all([
  admin.from("customer_merge_operations").select("id", { count: "exact", head: true }).eq("request_key", requestKey),
  admin.from("customers").select("status,active,merged_into_customer_id").eq("id", secondaryId).single(),
  admin.from("customer_credit_accounts").select("id,is_credit_enabled,credit_limit,status,terms_days").eq("customer_id", primaryId).single(),
]);
for (const result of [operation, secondary, credit]) assert.ifError(result.error);
assert.equal(operation.count, 1);
assert.deepEqual(secondary.data, { status: "merged", active: false, merged_into_customer_id: primaryId });
assert.deepEqual(credit.data, { id: creditId, is_credit_enabled: false, credit_limit: 0, status: "suspended", terms_days: 25 });

console.log("Customer Merge Resolution V2 local concurrency: PASS", {
  callers: 2,
  operations: operation.count,
  committed: 1,
  replayed: 1,
  operationId: responses[0].data.operationId,
});
