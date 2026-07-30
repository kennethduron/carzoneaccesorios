import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
assert.ok(url && serviceKey && anonKey, "Local Supabase URL and keys are required.");

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, serviceKey, options);
const technicalOwnerRole = await admin
  .from("roles")
  .select("id")
  .eq("name", "technical_owner")
  .single();
assert.ifError(technicalOwnerRole.error);

async function createActor(suffix) {
  const email = `supplier-multi-${suffix}-${randomUUID()}@example.test`;
  const password = `Local-${randomUUID()}!`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(created.error);
  const userId = created.data.user.id;
  const updated = await admin
    .from("users")
    .update({
      role_id: technicalOwnerRole.data.id,
      full_name: `Supplier multi ${suffix}`,
      active: true,
    })
    .eq("id", userId);
  assert.ifError(updated.error);
  const client = createClient(url, anonKey, options);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  return { userId, client };
}

const [actorA, actorB] = await Promise.all([
  createActor("actor-a"),
  createActor("actor-b"),
]);
const supplierId = randomUUID();
const payableAccountId = randomUUID();
const cashAccountId = randomUUID();
const journalId = randomUUID();
const payableIds = [randomUUID(), randomUUID(), randomUUID()];
const eventIds = payableIds.map(() => randomUUID());

let response = await admin.from("accounting_accounts").insert([
  {
    id: payableAccountId,
    code: "2101001",
    name: "PROVEEDORES LOCALES",
    type: "liability",
    normal_balance: "credit",
    is_active: true,
    created_by: actorA.userId,
  },
  {
    id: cashAccountId,
    code: "1101001",
    name: "CAJA GENERAL CONCURRENCIA",
    type: "asset",
    normal_balance: "debit",
    is_active: true,
    created_by: actorA.userId,
  },
]);
assert.ifError(response.error);
response = await admin.from("accounting_mappings").insert([
  {
    mapping_type: "default_account",
    source_key: "accounts_payable",
    account_id: payableAccountId,
    priority: 1,
    is_active: true,
    effective_from: "2026-01-01",
    created_by: actorA.userId,
  },
  {
    mapping_type: "payment_method",
    source_key: "supplier_payment_cash",
    account_id: cashAccountId,
    priority: 1,
    is_active: true,
    effective_from: "2026-01-01",
    created_by: actorA.userId,
  },
]);
assert.ifError(response.error);
response = await admin
  .from("accounting_feature_flags")
  .update({
    state: "enabled",
    cutover_at: "2026-07-01T06:00:00.000Z",
    updated_by: actorA.userId,
  })
  .in("key", [
    "supplier_payment_draft_v2",
    "supplier_multi_invoice_payment_v1",
  ]);
assert.ifError(response.error);
response = await admin.from("suppliers").insert({
  id: supplierId,
  name: "PROVEEDOR LOCAL CONCURRENCIA",
  is_active: true,
  created_by: actorA.userId,
});
assert.ifError(response.error);
response = await admin.from("accounts_payable").insert(
  payableIds.map((id, index) => ({
    id,
    supplier_id: supplierId,
    total_amount: [1000, 500, 250][index],
    paid_amount: 0,
    due_date: "2026-07-29",
    status: "pending",
    currency: "HNL",
    created_by: actorA.userId,
  })),
);
assert.ifError(response.error);
response = await admin.from("journal_entries").insert({
  id: journalId,
  entry_number: `TEST-CONCURRENT-${randomUUID().slice(0, 8)}`,
  entry_date: "2026-07-15",
  description: "Reconocimiento local para pruebas concurrentes",
  status: "publicada",
  source_type: "financial_event",
  source_id: eventIds[0],
  created_by: actorA.userId,
  updated_by: actorA.userId,
  posted_by: actorA.userId,
  posted_at: new Date().toISOString(),
});
assert.ifError(response.error);
response = await admin.from("financial_events").insert(
  payableIds.map((id, index) => ({
    id: eventIds[index],
    source_type: "accounts_payable",
    source_id: id,
    event_purpose: "accounts_payable_created",
    posting_version: "v1",
    status: "posted",
    occurred_at: "2026-07-15T18:00:00.000Z",
    source_snapshot: {},
    validation_errors: [],
    journal_entry_id: journalId,
    created_by: actorA.userId,
  })),
);
assert.ifError(response.error);

const register = (client, requestKey, payableId, amount) =>
  client.rpc("register_supplier_multi_payment_v1", {
    p_request_key: requestKey,
    p_supplier_id: supplierId,
    p_payment_method: "cash",
    p_paid_date: "2026-07-30",
    p_reference: null,
    p_applications: [
      { accounts_payable_id: payableId, applied_amount: amount },
    ],
    p_notes: "Prueba local concurrente",
    p_receipt_public_id: null,
  });

const sharedKey = randomUUID();
const identical = await Promise.all([
  register(actorA.client, sharedKey, payableIds[0], 100),
  register(actorB.client, sharedKey, payableIds[0], 100),
]);
for (const result of identical) assert.ifError(result.error);
assert.equal(
  identical[0].data.payment_id,
  identical[1].data.payment_id,
  "Two users with one request key must receive the same payment.",
);
assert.deepEqual(
  identical.map((item) => item.data.replayed).sort(),
  [false, true],
  "One concurrent caller commits and the other replays.",
);

const overlap = await Promise.all([
  register(actorA.client, randomUUID(), payableIds[1], 500),
  register(actorB.client, randomUUID(), payableIds[1], 500),
]);
assert.equal(
  overlap.filter((item) => !item.error).length,
  1,
  "Only one different request can consume the same locked balance.",
);
assert.equal(
  overlap.filter((item) => item.error).length,
  1,
  "The overlapping loser receives a transactional rejection.",
);

const lostKey = randomUUID();
const firstLostResponse = await register(
  actorA.client,
  lostKey,
  payableIds[2],
  50,
);
assert.ifError(firstLostResponse.error);
// Simulate a client that lost the successful response and retried later.
const recovered = await register(actorB.client, lostKey, payableIds[2], 50);
assert.ifError(recovered.error);
assert.equal(recovered.data.replayed, true);
assert.equal(recovered.data.payment_id, firstLostResponse.data.payment_id);

const paymentIds = [
  identical[0].data.payment_id,
  overlap.find((item) => !item.error).data.payment_id,
  recovered.data.payment_id,
];
const payments = await admin
  .from("supplier_payments")
  .select("id,allocation_mode")
  .in("id", paymentIds);
assert.ifError(payments.error);
assert.equal(payments.data.length, 3);
assert.ok(payments.data.every((item) => item.allocation_mode === "applications_v1"));
const outboxes = await admin
  .from("accounting_outbox_v2")
  .select("id,source_id")
  .in("source_id", paymentIds)
  .eq("event_purpose", "supplier_payment");
assert.ifError(outboxes.error);
assert.equal(outboxes.data.length, 3, "Every committed payment has one outbox.");
const balances = await admin
  .from("accounts_payable")
  .select("id,paid_amount,balance,status")
  .in("id", payableIds);
assert.ifError(balances.error);
assert.deepEqual(
  balances.data
    .sort((a, b) => payableIds.indexOf(a.id) - payableIds.indexOf(b.id))
    .map((item) => Number(item.paid_amount)),
  [100, 500, 50],
  "Concurrent losers and replays create no second balance effect.",
);

console.log(
  "Supplier multi-invoice payment concurrency: identical replay, overlap exclusion, two actors, and lost-response recovery OK",
);
