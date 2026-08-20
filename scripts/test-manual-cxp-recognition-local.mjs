import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assertStage6LocalEnvironment, readStage6LocalStatus } from "./pos-stage-6-local-guard.mjs";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required.");
assertStage6LocalEnvironment();
const status = readStage6LocalStatus();
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, options);
const suffix = randomUUID().slice(0, 8);
const email = `manual-cxp-${suffix}@example.test`;
const password = `Local-${randomUUID()}!a9`;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const role = await admin.from("roles").upsert({
  name: "contadora",
  description: "Local manual CxP recognition integration",
  permissions: ["payables:read", "payables:manage", "accounting:read", "accounting:manage", "accounting:post"],
}, { onConflict: "name" }).select("id").single();
assert.ifError(role.error);
const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
assert.ifError(created.error);
const actorId = created.data.user.id;
assert.ifError((await admin.from("users").update({ role_id: role.data.id, full_name: `Manual CxP ${suffix}`, active: true }).eq("id", actorId)).error);
const client = createClient(status.API_URL, status.ANON_KEY, options);
assert.ifError((await client.auth.signInWithPassword({ email, password })).error);

const supplierId = randomUUID();
const debitAccountId = randomUUID();
const payableAccountId = randomUUID();
assert.ifError((await admin.from("suppliers").insert({ id: supplierId, name: `MANUAL CXP LOCAL ${suffix}`, is_active: true, created_by: actorId })).error);
assert.ifError((await admin.from("accounting_accounts").insert([
  { id: debitAccountId, code: `MCXD-${suffix}`, name: `Gasto manual local ${suffix}`, type: "expense", normal_balance: "debit", is_active: true, created_by: actorId },
  { id: payableAccountId, code: `MCXP-${suffix}`, name: `Proveedor local ${suffix}`, type: "liability", normal_balance: "credit", is_active: true, created_by: actorId },
])).error);
assert.ifError((await admin.from("accounting_mappings").insert({ mapping_type: "default_account", source_key: "accounts_payable", account_id: payableAccountId, priority: 1, is_active: true, effective_from: today, created_by: actorId })).error);
const accountSearch = await client.rpc("search_manual_payable_debit_accounts_v1", { p_query: suffix, p_limit: 25, p_offset: 0 });
assert.ifError(accountSearch.error);
assert.deepEqual(accountSearch.data.map((account) => account.id), [debitAccountId]);

async function createPending(total = 100) {
  const response = await client.rpc("create_manual_accounts_payable_v1", {
    p_supplier_id: supplierId, p_total_amount: total, p_due_date: today, p_currency: "HNL", p_notes: "LOCAL SYNTHETIC ONLY",
    p_recognition_mode: "pending", p_accounting_date: null, p_debit_account_id: null, p_concept: null, p_source_reference: null,
    p_subtotal: null, p_tax_amount: null, p_discount_amount: null, p_request_key: randomUUID(),
  });
  assert.ifError(response.error);
  assert.equal(response.data.recognition_state, "pending_accounting_recognition");
  return response.data.accounts_payable_id;
}
const complete = (payableId, requestKey = randomUUID(), subtotal = 100) => client.rpc("complete_manual_accounts_payable_recognition_v1", {
  p_accounts_payable_id: payableId, p_accounting_date: today, p_debit_account_id: debitAccountId,
  p_concept: "Obligación manual sintética", p_source_reference: `LOCAL-${suffix}`,
  p_subtotal: subtotal, p_tax_amount: 0, p_discount_amount: 0, p_request_key: requestKey,
});

const payableId = await createPending();
const pendingEvidence = await admin.from("manual_accounts_payable_recognitions").select("state,journal_entry_id,financial_event_id").eq("accounts_payable_id", payableId).single();
assert.ifError(pendingEvidence.error);
assert.equal(pendingEvidence.data.state, "pending_accounting_recognition");
assert.equal(pendingEvidence.data.journal_entry_id, null);

const mismatch = await complete(payableId, randomUUID(), 99);
assert.ok(mismatch.error, "amount mismatch must be denied");
const completed = await complete(payableId);
assert.ifError(completed.error);
assert.equal(completed.data.recognition_state, "draft_pending_publication");
const replay = await complete(payableId);
assert.ifError(replay.error);
assert.equal(replay.data.replayed, true);

const [recognitions, events, entries] = await Promise.all([
  admin.from("manual_accounts_payable_recognitions").select("id,financial_event_id,journal_entry_id,state").eq("accounts_payable_id", payableId),
  admin.from("financial_events").select("id,journal_entry_id,status").eq("source_type", "accounts_payable").eq("source_id", payableId).eq("event_purpose", "accounts_payable_created").eq("posting_version", "v1"),
  admin.from("journal_entries").select("id,version,status,source_type,source_id").eq("id", completed.data.journal_entry_id),
]);
assert.ifError(recognitions.error); assert.ifError(events.error); assert.ifError(entries.error);
assert.equal(recognitions.data.length, 1); assert.equal(events.data.length, 1); assert.equal(entries.data.length, 1);
assert.equal(entries.data[0].source_type, "financial_event"); assert.equal(entries.data[0].source_id, events.data[0].id);

const lines = await admin.from("journal_entry_lines").select("debit,credit").eq("journal_entry_id", entries.data[0].id);
assert.ifError(lines.error);
assert.equal(lines.data.reduce((sum, line) => sum + Number(line.debit), 0), 100);
assert.equal(lines.data.reduce((sum, line) => sum + Number(line.credit), 0), 100);

const beforePublication = await admin.rpc("resolve_accounts_payable_accounting_recognition_v1", { p_accounts_payable_id: payableId, p_proposed_journal_date: today, p_payment_id: null });
assert.ifError(beforePublication.error); assert.equal(beforePublication.data.recognized, false);
const published = await client.rpc("post_journal_entry", { target_entry_id: entries.data[0].id, expected_version: entries.data[0].version, actor_ip: null, actor_user_agent: "local synthetic" });
assert.ifError(published.error);
const afterPublication = await admin.rpc("resolve_accounts_payable_accounting_recognition_v1", { p_accounts_payable_id: payableId, p_proposed_journal_date: today, p_payment_id: null });
assert.ifError(afterPublication.error); assert.equal(afterPublication.data.recognized, true);
const synced = await admin.from("manual_accounts_payable_recognitions").select("state").eq("accounts_payable_id", payableId).single();
assert.ifError(synced.error); assert.equal(synced.data.state, "recognized");

const concurrentId = await createPending();
const concurrent = await Promise.all([complete(concurrentId), complete(concurrentId)]);
concurrent.forEach((result) => assert.ifError(result.error));
const concurrentEvidence = await admin.from("manual_accounts_payable_recognitions").select("id,journal_entry_id").eq("accounts_payable_id", concurrentId);
assert.ifError(concurrentEvidence.error); assert.equal(concurrentEvidence.data.length, 1);
const concurrentEntries = await admin.from("journal_entries").select("id").eq("id", concurrentEvidence.data[0].journal_entry_id);
assert.ifError(concurrentEntries.error); assert.equal(concurrentEntries.data.length, 1);

const forged = await client.from("manual_accounts_payable_recognitions").insert({ accounts_payable_id: randomUUID(), state: "recognized", creation_request_key: randomUUID(), created_by: actorId });
assert.ok(forged.error, "direct client recognition insert must be denied");
const orphanDelete = await admin.from("accounts_payable").delete().eq("id", payableId);
assert.ok(orphanDelete.error, "recognized payable delete must be denied by trigger");

console.log("manual CxP recognition local integration: PASS");
