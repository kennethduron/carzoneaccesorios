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
  description: "Purchase recognition concurrency local only",
  permissions: [
    "purchases:manage",
    "payables:manage",
    "accounting:manage",
    "accounting:settings",
  ],
}, { onConflict: "name" }).select("id").single();
assert.ifError(role.error);

async function createActor(label) {
  const email = `purchase-recognition-${label}-${randomUUID()}@example.test`;
  const password = `Local-${randomUUID()}!a9`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(created.error);
  const updated = await admin.from("users").update({
    role_id: role.data.id,
    full_name: `Purchase recognition ${label} local only`,
    active: true,
  }).eq("id", created.data.user.id);
  assert.ifError(updated.error);
  const client = createClient(status.API_URL, status.ANON_KEY, options);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  return { id: created.data.user.id, client };
}

const [actorA, actorB] = await Promise.all([
  createActor("actor-a"),
  createActor("actor-b"),
]);
const suffix = randomUUID().slice(0, 8);
const supplierId = randomUUID();
const productId = randomUUID();
const inventoryAccountId = randomUUID();
const payableAccountId = randomUUID();

try {
  const category = await admin.from("categories").select("id").limit(1).single();
  assert.ifError(category.error);
  assert.ifError((await admin.from("suppliers").insert({
    id: supplierId,
    name: `PURCHASE RECOGNITION CONCURRENCY ${suffix} LOCAL ONLY`,
    is_active: true,
    created_by: actorA.id,
  })).error);
  assert.ifError((await admin.from("products").insert({
    id: productId,
    category_id: category.data.id,
    sku: `PRC-${suffix}`,
    slug: `purchase-recognition-concurrency-${suffix}`,
    name: `PURCHASE RECOGNITION CONCURRENCY ${suffix}`,
    brand: "Fixture",
    stock: 10,
    reserved_stock: 0,
    retail_price: 200,
    wholesale_price: 180,
    cost_price: 100,
  })).error);
  assert.ifError((await admin.from("accounting_accounts").insert([
    {
      id: inventoryAccountId,
      code: `PRCI-${suffix}`,
      name: `Inventario concurrencia ${suffix}`,
      type: "asset",
      normal_balance: "debit",
      is_active: true,
      created_by: actorA.id,
    },
    {
      id: payableAccountId,
      code: `PRCP-${suffix}`,
      name: `Proveedores concurrencia ${suffix}`,
      type: "liability",
      normal_balance: "credit",
      is_active: true,
      created_by: actorA.id,
    },
  ])).error);
  assert.ifError((await admin.from("accounting_mappings").insert([
    {
      mapping_type: "inventory",
      source_key: "purchase_inventory",
      account_id: inventoryAccountId,
      priority: 1,
      is_active: true,
      effective_from: today,
      created_by: actorA.id,
    },
    {
      mapping_type: "default_account",
      source_key: "accounts_payable",
      account_id: payableAccountId,
      priority: 1,
      is_active: true,
      effective_from: today,
      created_by: actorA.id,
    },
  ])).error);

  assert.ifError((await admin.from("purchase_feature_flags").update({
    enabled: true,
    enabled_at: new Date(Date.now() - 60_000).toISOString(),
    reason: "Local recognition concurrency activation",
  }).eq("key", "purchase_ap_automation_v1")).error);
  assert.ifError((await admin.from("accounting_feature_flags").update({
    state: "enabled",
    cutover_at: new Date(Date.now() - 60_000).toISOString(),
    updated_by: actorA.id,
  }).eq("key", "purchase_recognition_draft_v2")).error);

  const saved = await actorA.client.rpc("save_purchase_with_inventory", {
    target_purchase_id: null,
    purchase_data: {
      supplier_id: supplierId,
      purchase_number: `PRC-CONCURRENT-${suffix}`,
      purchase_date: today,
      shipping_amount: 0,
      currency: "HNL",
      notes: "LOCAL SYNTHETIC ONLY",
    },
    items_data: [{
      product_id: productId,
      description: "LOCAL SYNTHETIC INVENTORY",
      quantity: 10,
      unit_cost: 100,
      tax_amount: 0,
      discount_amount: 0,
    }],
  });
  assert.ifError(saved.error);
  const purchaseId = saved.data[0].purchase_id;
  const requestKey = randomUUID();
  const confirm = (client) => client.rpc("confirm_purchase_with_payable_v1", {
    target_purchase_id: purchaseId,
    p_payment_condition: "credit",
    p_due_date: dueDate,
    p_initial_payment_amount: 0,
    p_payment_method: null,
    p_payment_date: null,
    p_payment_notes: null,
    p_request_key: requestKey,
  });

  const confirmations = await Promise.all([confirm(actorA.client), confirm(actorB.client)]);
  for (const result of confirmations) assert.ifError(result.error);
  assert.deepEqual(
    confirmations.map((result) => result.data[0].replayed).sort(),
    [false, true],
    "One confirmation commits and the concurrent retry replays.",
  );
  const payableId = confirmations[0].data[0].accounts_payable_id;

  const outboxes = await admin.from("accounting_outbox_v2")
    .select("id,status")
    .eq("source_type", "accounts_payable")
    .eq("source_id", payableId)
    .eq("event_purpose", "accounts_payable_created")
    .eq("posting_version", "v2");
  assert.ifError(outboxes.error);
  assert.equal(outboxes.data.length, 1, "Concurrent confirmation creates one recognition outbox.");

  const processing = await Promise.all([
    admin.rpc("process_accounting_outbox_v2", {
      target_outbox_id: outboxes.data[0].id,
      worker_token: `concurrent-a-${suffix}`,
      force_retry: false,
    }),
    admin.rpc("process_accounting_outbox_v2", {
      target_outbox_id: outboxes.data[0].id,
      worker_token: `concurrent-b-${suffix}`,
      force_retry: false,
    }),
  ]);
  for (const result of processing) assert.ifError(result.error);

  const events = await admin.from("financial_events")
    .select("id,journal_entry_id")
    .eq("source_type", "accounts_payable")
    .eq("source_id", payableId)
    .eq("event_purpose", "accounts_payable_created")
    .eq("posting_version", "v2");
  assert.ifError(events.error);
  assert.equal(events.data.length, 1, "Concurrent workers create one V2 event.");
  assert.ok(events.data[0].journal_entry_id, "The canonical event has one draft.");

  const entries = await admin.from("journal_entries")
    .select("id,status")
    .eq("source_type", "financial_event")
    .eq("source_id", events.data[0].id);
  assert.ifError(entries.error);
  assert.deepEqual(entries.data, [{
    id: events.data[0].journal_entry_id,
    status: "borrador",
  }]);

  const lines = await admin.from("journal_entry_lines")
    .select("account_id,debit,credit")
    .eq("journal_entry_id", events.data[0].journal_entry_id);
  assert.ifError(lines.error);
  assert.equal(lines.data.length, 2);
  assert.equal(
    lines.data.reduce((sum, line) => sum + Number(line.debit), 0),
    lines.data.reduce((sum, line) => sum + Number(line.credit), 0),
    "The concurrent canonical result is balanced.",
  );

  console.log("Purchase recognition concurrency: one AP, one outbox, one V2 event, and one balanced draft OK");
} finally {
  assert.ifError((await admin.from("accounting_feature_flags").update({
    state: "disabled",
    cutover_at: null,
  }).eq("key", "purchase_recognition_draft_v2")).error);
  assert.ifError((await admin.from("purchase_feature_flags").update({
    enabled: false,
    enabled_at: null,
    reason: "Local recognition concurrency validation completed",
  }).eq("key", "purchase_ap_automation_v1")).error);
}
