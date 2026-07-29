import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const apiUrl = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const mode = process.argv[2] ?? "setup";
const parsedUrl = new URL(apiUrl);

assert.ok(
  parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost",
  "This browser fixture refuses to target a non-local Supabase instance.",
);
assert.equal(parsedUrl.port, "54321");
assert.ok(serviceRoleKey, "The local Supabase service-role key is required.");

const admin = createClient(apiUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const technicalEmail = "late-payment-browser-owner@example.test";
const accountantEmail = "late-payment-browser-accountant@example.test";
const password = "Local-Late-Payment-2026!";
const ids = {
  supplier: "b1000000-0000-4000-8000-000000000001",
  payable: "b1000000-0000-4000-8000-000000000002",
  payment: "b1000000-0000-4000-8000-000000000003",
  payableAccount: "b1000000-0000-4000-8000-000000000004",
  bankAccount: "b1000000-0000-4000-8000-000000000005",
  expenseAccount: "b1000000-0000-4000-8000-000000000006",
  recognitionEvent: "b1000000-0000-4000-8000-000000000007",
  recognitionEntry: "b1000000-0000-4000-8000-000000000008",
  legacyEvent: "b1000000-0000-4000-8000-000000000009",
};

async function query(promise, label) {
  const result = await promise;
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  return result.data;
}

async function authUsers() {
  const matches = [];
  for (let page = 1; page <= 10; page += 1) {
    const data = await query(
      admin.auth.admin.listUsers({ page, perPage: 100 }),
      "list local auth users",
    );
    matches.push(
      ...data.users.filter((user) =>
        [technicalEmail, accountantEmail].includes(user.email ?? ""),
      ),
    );
    if (data.users.length < 100) break;
  }
  return matches;
}

async function cleanup() {
  const { data: paymentEvents } = await admin
    .from("financial_events")
    .select("journal_entry_id")
    .eq("source_type", "supplier_payment")
    .eq("source_id", ids.payment);
  const paymentDraftIds = (paymentEvents ?? [])
    .map((event) => event.journal_entry_id)
    .filter(Boolean);

  await admin.from("supplier_payment_accounting_repairs").delete().eq("payment_id", ids.payment);
  await admin.from("accounting_event_log").delete().eq("source_id", ids.payment);
  if (paymentDraftIds.length > 0) {
    await admin.from("journal_entry_lines").delete().in("journal_entry_id", paymentDraftIds);
    await admin.from("journal_entries").delete().in("id", paymentDraftIds);
  }
  await admin.from("financial_events").delete().eq("source_id", ids.payment);
  await admin.from("accounting_outbox_v2").delete().eq("source_id", ids.payment);
  await admin.from("supplier_payments").delete().eq("id", ids.payment);
  await admin.from("financial_events").delete().in("id", [ids.recognitionEvent, ids.legacyEvent]);
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

  for (const user of await authUsers()) {
    await admin.auth.admin.deleteUser(user.id);
  }
}

if (mode === "cleanup") {
  await cleanup();
  console.log("Supplier payment late-entry browser fixture cleanup: OK");
  process.exit(0);
}

await cleanup();

await query(
  admin.from("roles").upsert(
    {
      name: "contadora",
      description: "Contadora local para pruebas visuales",
      permissions: ["admin:access", "accounting:read", "payables:read"],
    },
    { onConflict: "name" },
  ),
  "ensure local accountant role",
);
const roles = await query(
  admin.from("roles").select("id, name").in("name", ["technical_owner", "contadora"]),
  "read local roles",
);
const technicalRoleId = roles.find((role) => role.name === "technical_owner")?.id;
const accountantRoleId = roles.find((role) => role.name === "contadora")?.id;
assert.ok(technicalRoleId && accountantRoleId, "Required local roles are missing.");

const technical = await query(
  admin.auth.admin.createUser({
    email: technicalEmail,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Technical Owner Browser Local" },
  }),
  "create local technical user",
);
const accountant = await query(
  admin.auth.admin.createUser({
    email: accountantEmail,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Contadora Browser Local" },
  }),
  "create local accountant user",
);
await query(
  admin
    .from("users")
    .update({ role_id: technicalRoleId, active: true })
    .eq("id", technical.user.id),
  "configure local technical user",
);
await query(
  admin
    .from("users")
    .update({ role_id: accountantRoleId, active: true })
    .eq("id", accountant.user.id),
  "configure local accountant user",
);

await query(
  admin
    .from("accounting_feature_flags")
    .update({
      state: "enabled",
      cutover_at: "2026-07-28T20:30:00Z",
      updated_by: technical.user.id,
    })
    .eq("key", "supplier_payment_draft_v2"),
  "configure local cutover",
);

await query(
  admin.from("accounting_accounts").insert([
    {
      id: ids.payableAccount,
      code: "2101001-VISUAL",
      name: "PROVEEDORES LOCALES",
      type: "liability",
      normal_balance: "credit",
      is_active: true,
      created_by: technical.user.id,
    },
    {
      id: ids.bankAccount,
      code: "1101005-VISUAL",
      name: "BAC CHEQUES LPS",
      type: "asset",
      normal_balance: "debit",
      is_active: true,
      created_by: technical.user.id,
    },
    {
      id: ids.expenseAccount,
      code: "5101001-VISUAL",
      name: "COMPRAS LOCALES",
      type: "expense",
      normal_balance: "debit",
      is_active: true,
      created_by: technical.user.id,
    },
  ]),
  "create local visual accounts",
);
await query(
  admin.from("accounting_mappings").insert([
    {
      mapping_type: "default_account",
      source_key: "accounts_payable",
      account_id: ids.payableAccount,
      priority: 1,
      is_active: true,
      created_by: technical.user.id,
    },
    {
      mapping_type: "payment_method",
      source_key: "supplier_payment_bank",
      account_id: ids.bankAccount,
      priority: 1,
      is_active: true,
      created_by: technical.user.id,
    },
  ]),
  "create local visual mappings",
);
await query(
  admin.from("suppliers").insert({
    id: ids.supplier,
    name: "ALMACÉN VISUAL LOCAL",
    is_active: true,
    created_by: technical.user.id,
  }),
  "create local visual supplier",
);
await query(
  admin.from("accounts_payable").insert({
    id: ids.payable,
    supplier_id: ids.supplier,
    total_amount: 3200,
    paid_amount: 3200,
    status: "paid",
    currency: "HNL",
    created_by: technical.user.id,
    created_at: "2026-07-28T22:06:21Z",
  }),
  "create local visual payable",
);
await query(
  admin.from("journal_entries").insert({
    id: ids.recognitionEntry,
    entry_number: "PC-20260728-VISUAL",
    entry_date: "2026-07-28",
    description: "Reconocimiento CxP visual local",
    status: "borrador",
    source_type: "financial_event",
    source_id: ids.recognitionEvent,
    created_by: technical.user.id,
  }),
  "create local recognition draft",
);
await query(
  admin.from("journal_entry_lines").insert([
    {
      journal_entry_id: ids.recognitionEntry,
      account_id: ids.expenseAccount,
      debit: 3200,
      credit: 0,
      description: "Compra local visual",
    },
    {
      journal_entry_id: ids.recognitionEntry,
      account_id: ids.payableAccount,
      debit: 0,
      credit: 3200,
      description: "CxP local visual",
    },
  ]),
  "create local recognition lines",
);
await query(
  admin
    .from("journal_entries")
    .update({
      status: "publicada",
      posted_by: technical.user.id,
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
    created_by: technical.user.id,
  }),
  "create local recognition event",
);

await query(
  admin
    .from("accounting_feature_flags")
    .update({ state: "disabled", cutover_at: null, updated_by: technical.user.id })
    .eq("key", "supplier_payment_draft_v2"),
  "temporarily disable local routing",
);
await query(
  admin.from("supplier_payments").insert({
    id: ids.payment,
    accounts_payable_id: ids.payable,
    supplier_id: ids.supplier,
    amount: 3200,
    payment_method: "bank_transfer",
    payment_method_v2: "bank_transfer",
    status: "paid",
    paid_at: "2026-07-13T06:00:00Z",
    created_at: "2026-07-29T14:08:18Z",
    created_by: technical.user.id,
    idempotency_key: "browser-fixture-late-payment",
    request_fingerprint: "b".repeat(32),
  }),
  "create pre-fix local visual payment",
);
await query(
  admin.from("financial_events").insert({
    id: ids.legacyEvent,
    source_type: "supplier_payment",
    source_id: ids.payment,
    event_purpose: "supplier_payment_paid",
    posting_version: "v1",
    status: "pending",
    occurred_at: "2026-07-13T06:00:00Z",
    source_snapshot: {},
    validation_errors: [],
    created_by: technical.user.id,
  }),
  "create local legacy payment event",
);
await query(
  admin
    .from("accounting_feature_flags")
    .update({
      state: "enabled",
      cutover_at: "2026-07-28T20:30:00Z",
      updated_by: technical.user.id,
    })
    .eq("key", "supplier_payment_draft_v2"),
  "restore local routing",
);

console.log(
  JSON.stringify({
    ok: true,
    technicalEmail,
    accountantEmail,
    password,
    paymentId: ids.payment,
  }),
);
