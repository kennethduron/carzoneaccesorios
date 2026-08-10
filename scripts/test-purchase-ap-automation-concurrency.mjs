import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

import {
  assertStage6LocalEnvironment,
  readStage6LocalStatus,
} from "./pos-stage-6-local-guard.mjs";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") {
  throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required.");
}

assertStage6LocalEnvironment();
const status = readStage6LocalStatus();
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, options);
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Tegucigalpa",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const dueDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Tegucigalpa",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date(Date.now() + 30 * 86_400_000));

const role = await admin.from("roles").upsert({
  name: "technical_owner",
  description: "Purchase AP concurrency local only",
  permissions: ["purchases:manage", "payables:manage"],
}, { onConflict: "name" }).select("id").single();
assert.ifError(role.error);

async function createActor(label) {
  const email = `purchase-ap-${label}-${randomUUID()}@example.test`;
  const password = `Local-${randomUUID()}!a9`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  const updated = await admin.from("users").update({
    role_id: role.data.id,
    full_name: `Purchase AP ${label} local only`,
    active: true,
  }).eq("id", created.data.user.id);
  assert.ifError(updated.error);
  const client = createClient(status.API_URL, status.ANON_KEY, options);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  return { id: created.data.user.id, client };
}

const [actorA, actorB] = await Promise.all([createActor("actor-a"), createActor("actor-b")]);
const supplierId = randomUUID();

assert.ifError((await admin.from("suppliers").insert({
  id: supplierId,
  name: `PURCHASE AP CONCURRENCY ${randomUUID().slice(0, 8)} LOCAL ONLY`,
  is_active: true,
  created_by: actorA.id,
})).error);

async function createDraftPurchase(label, total) {
  const saved = await admin.rpc("save_purchase_with_inventory", {
    target_purchase_id: null,
    purchase_data: {
      supplier_id: supplierId,
      purchase_number: `AP-CONCURRENT-${label}-${randomUUID().slice(0, 8)}`,
      purchase_date: today,
      shipping_amount: 0,
      currency: "HNL",
      notes: "LOCAL ONLY",
    },
    items_data: [{
      product_id: null,
      description: `${label} LOCAL ONLY`,
      quantity: 1,
      unit_cost: total,
      tax_amount: 0,
      discount_amount: 0,
    }],
  });
  assert.ifError(saved.error);
  return saved.data[0].purchase_id;
}

const partialPurchaseId = await createDraftPurchase("PARTIAL", 1000);
const competingPurchaseId = await createDraftPurchase("CREDIT", 750);

assert.ifError((await admin.from("purchase_feature_flags").update({
  enabled: true,
  enabled_at: new Date().toISOString(),
  reason: "Local concurrency activation for controlled validation",
}).eq("key", "purchase_ap_automation_v1")).error);

const confirm = (client, purchaseId, requestKey, condition, amount = 0) => client.rpc(
  "confirm_purchase_with_payable_v1",
  {
    target_purchase_id: purchaseId,
    p_payment_condition: condition,
    p_due_date: dueDate,
    p_initial_payment_amount: amount,
    p_payment_method: condition === "partial" ? "bank_transfer" : null,
    p_payment_date: condition === "partial" ? today : null,
    p_payment_notes: condition === "partial" ? "Concurrent local advance" : null,
    p_request_key: requestKey,
  },
);

try {
  const sharedKey = randomUUID();
  const identical = await Promise.all([
    confirm(actorA.client, partialPurchaseId, sharedKey, "partial", 250),
    confirm(actorB.client, partialPurchaseId, sharedKey, "partial", 250),
  ]);
  for (const result of identical) assert.ifError(result.error);
  assert.equal(identical[0].data[0].accounts_payable_id, identical[1].data[0].accounts_payable_id);
  assert.equal(identical[0].data[0].supplier_payment_id, identical[1].data[0].supplier_payment_id);
  assert.deepEqual(identical.map((result) => result.data[0].replayed).sort(), [false, true]);

  const partialPayables = await admin.from("accounts_payable")
    .select("id,paid_amount,balance,status")
    .eq("purchase_id", partialPurchaseId);
  assert.ifError(partialPayables.error);
  assert.equal(partialPayables.data.length, 1);
  assert.deepEqual(partialPayables.data[0], {
    id: identical[0].data[0].accounts_payable_id,
    paid_amount: 250,
    balance: 750,
    status: "partial",
  });
  const partialPayments = await admin.from("supplier_payments")
    .select("id")
    .eq("accounts_payable_id", partialPayables.data[0].id);
  assert.ifError(partialPayments.error);
  assert.equal(partialPayments.data.length, 1, "identical concurrent confirmation creates one payment");

  const competing = await Promise.all([
    confirm(actorA.client, competingPurchaseId, randomUUID(), "credit"),
    confirm(actorB.client, competingPurchaseId, randomUUID(), "credit"),
  ]);
  assert.equal(competing.filter((result) => !result.error).length, 1, "one competing confirmation commits");
  assert.equal(competing.filter((result) => result.error).length, 1, "one competing confirmation is rejected");
  assert.match(competing.find((result) => result.error).error.message, /PURCHASE_ALREADY_CONFIRMED/);

  const competingPayables = await admin.from("accounts_payable")
    .select("id")
    .eq("purchase_id", competingPurchaseId);
  assert.ifError(competingPayables.error);
  assert.equal(competingPayables.data.length, 1, "competing keys still create one payable");

  const intents = await admin.from("financial_events")
    .select("source_type,event_purpose")
    .in("source_id", [partialPurchaseId, competingPurchaseId]);
  assert.ifError(intents.error);
  assert.equal(intents.data.filter((event) => event.source_type === "purchase" && event.event_purpose === "purchase_confirmed").length, 2);

  console.log("Purchase AP automation concurrency: replay, payment, competing-key exclusion, and durable intent OK");
} finally {
  const disabled = await admin.from("purchase_feature_flags").update({
    enabled: false,
    enabled_at: null,
    reason: "Local concurrency validation completed with feature disabled",
  }).eq("key", "purchase_ap_automation_v1");
  assert.ifError(disabled.error);
}
