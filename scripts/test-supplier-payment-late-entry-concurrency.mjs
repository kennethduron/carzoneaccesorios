import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const apiUrl = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const parsedUrl = new URL(apiUrl);
assert.ok(
  parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost",
  "This concurrency test refuses to target a non-local Supabase instance.",
);
assert.equal(parsedUrl.port, "54321");
assert.ok(serviceRoleKey && anonKey, "Local Supabase keys are required.");

const admin = createClient(apiUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const ids = {
  user: randomUUID(),
  supplier: randomUUID(),
  payable: randomUUID(),
  payment: randomUUID(),
  payableAccount: randomUUID(),
  bankAccount: randomUUID(),
  expenseAccount: randomUUID(),
  recognitionEvent: randomUUID(),
  recognitionEntry: randomUUID(),
  request: randomUUID(),
  lostResponseRequest: randomUUID(),
};
const email = `late-payment-concurrency-${suffix}@example.test`;
const password = `Local-${randomUUID()}!`;

async function query(promise, label) {
  const result = await promise;
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

const originalFlag = await query(
  admin
    .from("accounting_feature_flags")
    .select("state, cutover_at, updated_by")
    .eq("key", "supplier_payment_draft_v2")
    .single(),
  "read original flag",
);

let sessionClient = null;
try {
  await query(
    admin.auth.admin.createUser({
      id: ids.user,
      email,
      password,
      email_confirm: true,
    }),
    "create local auth user",
  );
  const technicalRole = await query(
    admin.from("roles").select("id").eq("name", "technical_owner").single(),
    "read technical role",
  );
  await query(
    admin
      .from("users")
      .update({
        role_id: technicalRole.id,
        full_name: "Late payment concurrency fixture",
        active: true,
      })
      .eq("id", ids.user),
    "configure local technical user",
  );

  await query(
    admin.from("accounting_accounts").insert([
      {
        id: ids.payableAccount,
        code: `LT-C-${suffix}-AP`,
        name: "Concurrency payable",
        type: "liability",
        normal_balance: "credit",
        is_active: true,
        created_by: ids.user,
      },
      {
        id: ids.bankAccount,
        code: `LT-C-${suffix}-BK`,
        name: "Concurrency bank",
        type: "asset",
        normal_balance: "debit",
        is_active: true,
        created_by: ids.user,
      },
      {
        id: ids.expenseAccount,
        code: `LT-C-${suffix}-EX`,
        name: "Concurrency expense",
        type: "expense",
        normal_balance: "debit",
        is_active: true,
        created_by: ids.user,
      },
    ]),
    "create local accounts",
  );
  await query(
    admin.from("accounting_mappings").insert([
      {
        mapping_type: "default_account",
        source_key: "accounts_payable",
        account_id: ids.payableAccount,
        priority: 1,
        is_active: true,
        created_by: ids.user,
      },
      {
        mapping_type: "payment_method",
        source_key: "supplier_payment_bank",
        account_id: ids.bankAccount,
        priority: 1,
        is_active: true,
        created_by: ids.user,
      },
    ]),
    "create local mappings",
  );
  await query(
    admin.from("suppliers").insert({
      id: ids.supplier,
      name: `Concurrency supplier ${suffix}`,
      is_active: true,
      created_by: ids.user,
    }),
    "create local supplier",
  );
  await query(
    admin.from("accounts_payable").insert({
      id: ids.payable,
      supplier_id: ids.supplier,
      total_amount: 75,
      paid_amount: 75,
      status: "paid",
      currency: "HNL",
      created_by: ids.user,
      created_at: "2026-07-28T22:06:21Z",
    }),
    "create local payable",
  );
  await query(
    admin.from("journal_entries").insert({
      id: ids.recognitionEntry,
      entry_number: `LT-C-${suffix}`,
      entry_date: "2026-07-28",
      description: "Concurrency payable recognition",
      status: "borrador",
      source_type: "financial_event",
      source_id: ids.recognitionEvent,
      created_by: ids.user,
    }),
    "create recognition draft",
  );
  await query(
    admin.from("journal_entry_lines").insert([
      {
        journal_entry_id: ids.recognitionEntry,
        account_id: ids.expenseAccount,
        debit: 75,
        credit: 0,
        description: "Concurrency expense",
      },
      {
        journal_entry_id: ids.recognitionEntry,
        account_id: ids.payableAccount,
        debit: 0,
        credit: 75,
        description: "Concurrency payable",
      },
    ]),
    "create recognition lines",
  );
  await query(
    admin
      .from("journal_entries")
      .update({
        status: "publicada",
        posted_by: ids.user,
        posted_at: "2026-07-28T22:21:50Z",
      })
      .eq("id", ids.recognitionEntry),
    "publish local recognition",
  );
  await query(
    admin.from("financial_events").insert({
      id: ids.recognitionEvent,
      source_type: "accounts_payable",
      source_id: ids.payable,
      event_purpose: "accounts_payable_created",
      posting_version: "v1",
      status: "posted",
      occurred_at: "2026-07-28T22:06:21Z",
      journal_entry_id: ids.recognitionEntry,
      source_snapshot: {},
      validation_errors: [],
      created_by: ids.user,
    }),
    "create recognition event",
  );

  await query(
    admin
      .from("accounting_feature_flags")
      .update({ state: "disabled", cutover_at: null, updated_by: ids.user })
      .eq("key", "supplier_payment_draft_v2"),
    "temporarily disable local routing",
  );
  await query(
    admin.from("supplier_payments").insert({
      id: ids.payment,
      accounts_payable_id: ids.payable,
      supplier_id: ids.supplier,
      amount: 75,
      payment_method: "bank_transfer",
      payment_method_v2: "bank_transfer",
      status: "paid",
      paid_at: "2026-07-13T06:00:00Z",
      created_at: "2026-07-29T14:08:18Z",
      created_by: ids.user,
      idempotency_key: randomUUID(),
      request_fingerprint: "e".repeat(32),
    }),
    "create pre-fix local payment",
  );
  await query(
    admin
      .from("accounting_feature_flags")
      .update({
        state: "enabled",
        cutover_at: "2026-07-28T20:30:00Z",
        updated_by: ids.user,
      })
      .eq("key", "supplier_payment_draft_v2"),
    "enable local routing",
  );

  sessionClient = createClient(apiUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await query(
    sessionClient.auth.signInWithPassword({ email, password }),
    "sign in local technical user",
  );
  const previewRows = await query(
    sessionClient.rpc("preview_supplier_payment_accounting_repairs_v1", {
      p_payment_id: ids.payment,
    }),
    "preview local payment",
  );
  const preview = previewRows?.[0]?.preview;
  assert.equal(preview?.classification, "eligible_late_recorded");

  const badFingerprint = await sessionClient.rpc(
    "repair_late_recorded_supplier_payment_draft_v1",
    {
      p_request_key: randomUUID(),
      p_payment_id: ids.payment,
      p_expected_fingerprint: "0".repeat(64),
      p_reason: "Concurrency rollback validation",
    },
  );
  assert.ok(badFingerprint.error, "A stale fingerprint must roll back.");

  const payload = {
    p_request_key: ids.request,
    p_payment_id: ids.payment,
    p_expected_fingerprint: preview.expected_fingerprint,
    p_reason: "Concurrent authorized recovery",
  };
  const [first, second] = await Promise.all([
    sessionClient.rpc("repair_late_recorded_supplier_payment_draft_v1", payload),
    sessionClient.rpc("repair_late_recorded_supplier_payment_draft_v1", payload),
  ]);
  assert.ifError(first.error);
  assert.ifError(second.error);
  const results = [first.data, second.data];
  assert.equal(new Set(results.map((item) => item.outbox_id)).size, 1);
  assert.equal(
    results.filter((item) => item.idempotent_replay === true).length,
    1,
    "Exactly one concurrent caller must observe an idempotent replay.",
  );

  const outboxes = await query(
    admin
      .from("accounting_outbox_v2")
      .select("id", { count: "exact" })
      .eq("source_id", ids.payment),
    "count concurrent outboxes",
  );
  assert.equal(outboxes.length, 1);
  const repairs = await query(
    admin
      .from("supplier_payment_accounting_repairs")
      .select("id", { count: "exact" })
      .eq("payment_id", ids.payment),
    "count concurrent ledger rows",
  );
  assert.equal(repairs.length, 1);

  // Simulate a lost HTTP response: replaying after the caller discarded the
  // first result returns the same protected economic effect.
  const lostResponseReplay = await sessionClient.rpc(
    "repair_late_recorded_supplier_payment_draft_v1",
    {
      ...payload,
      p_request_key: ids.lostResponseRequest,
    },
  );
  assert.ifError(lostResponseReplay.error);
  assert.equal(lostResponseReplay.data.idempotent_replay, true);
  assert.equal(lostResponseReplay.data.outbox_id, first.data.outbox_id);

  console.log("Supplier payment late-entry concurrency/timeout contracts: OK");
} finally {
  await admin
    .from("supplier_payment_accounting_repairs")
    .delete()
    .eq("payment_id", ids.payment);
  await admin
    .from("accounting_event_log")
    .delete()
    .eq("source_type", "supplier_payment")
    .eq("source_id", ids.payment);
  const { data: eventRows } = await admin
    .from("financial_events")
    .select("id, journal_entry_id")
    .eq("source_type", "supplier_payment")
    .eq("source_id", ids.payment);
  const draftIds = (eventRows ?? []).map((row) => row.journal_entry_id).filter(Boolean);
  if (draftIds.length) {
    await admin.from("journal_entry_lines").delete().in("journal_entry_id", draftIds);
    await admin.from("journal_entries").delete().in("id", draftIds);
  }
  await admin
    .from("financial_events")
    .delete()
    .eq("source_type", "supplier_payment")
    .eq("source_id", ids.payment);
  await admin.from("accounting_outbox_v2").delete().eq("source_id", ids.payment);
  await admin.from("supplier_payments").delete().eq("id", ids.payment);
  await admin.from("financial_events").delete().eq("id", ids.recognitionEvent);
  await admin.from("journal_entry_lines").delete().eq("journal_entry_id", ids.recognitionEntry);
  await admin.from("journal_entries").delete().eq("id", ids.recognitionEntry);
  await admin.from("accounts_payable").delete().eq("id", ids.payable);
  await admin.from("suppliers").delete().eq("id", ids.supplier);
  await admin
    .from("accounting_mappings")
    .delete()
    .in("account_id", [ids.payableAccount, ids.bankAccount]);
  await admin
    .from("accounting_accounts")
    .delete()
    .in("id", [ids.payableAccount, ids.bankAccount, ids.expenseAccount]);
  await admin
    .from("accounting_feature_flags")
    .update(originalFlag)
    .eq("key", "supplier_payment_draft_v2");
  if (sessionClient) await sessionClient.auth.signOut();
  await admin.auth.admin.deleteUser(ids.user);
}
