import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
assert.ok(serviceKey && anonKey, "Local Supabase keys are required.");
assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost):54321$/, "This test is local-only.");

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const marker = `POS-FINAL-UX-LOCAL-ONLY-${Date.now()}`;
const password = `Cz-${crypto.randomUUID()}!a9`;
const customerIds = [];
let userId = null;
let roleId = null;
let originalPermissions = null;
let draftId = null;

async function count(table) {
  const { count: value, error } = await admin.from(table).select("id", { count: "exact", head: true });
  assert.ifError(error);
  return value ?? 0;
}

const economicTables = [
  "orders", "order_items", "invoices", "invoice_items", "payments", "accounts_receivable",
  "inventory_movements", "financial_events", "accounting_outbox_v2", "journal_entries", "journal_entry_lines",
];

try {
  const before = Object.fromEntries(await Promise.all(economicTables.map(async (table) => [table, await count(table)])));
  const permissions = [
    "pos:create_sale", "pos:access", "pos:customers:search", "customers:read_commercial", "customers:read_credit",
    "pos:drafts:create", "pos:drafts:read", "pos:drafts:edit_own", "pos:drafts:edit_any", "pos:drafts:abandon",
    "pos:confirm_sale",
  ];
  const role = await admin.from("roles").select("id,permissions").eq("name", "technical_owner").single();
  assert.ifError(role.error);
  roleId = role.data.id;
  originalPermissions = role.data.permissions;
  const permissionSet = [...new Set([...(Array.isArray(originalPermissions) ? originalPermissions : []), ...permissions])];
  const roleUpdate = await admin.from("roles").update({ permissions: permissionSet }).eq("id", roleId);
  assert.ifError(roleUpdate.error);

  const auth = await admin.auth.admin.createUser({
    email: `${marker.toLowerCase()}@example.test`,
    password,
    email_confirm: true,
    user_metadata: { full_name: marker },
  });
  assert.ifError(auth.error);
  userId = auth.data.user.id;
  const profile = await admin.from("users").update({ role_id: roleId, active: true }).eq("id", userId);
  assert.ifError(profile.error);

  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const login = await client.auth.signInWithPassword({ email: `${marker.toLowerCase()}@example.test`, password });
  assert.ifError(login.error);

  const inserted = await admin.from("customers").insert([
    { contact_name: `${marker} ACTIVO`, source: "pos", lead_status: "cliente", active: true, status: "active", is_wholesale: false, wholesale_status: "none" },
    { contact_name: `${marker} INACTIVO`, source: "pos", lead_status: "cliente", active: false, status: "inactive", is_wholesale: false, wholesale_status: "none" },
    { contact_name: `${marker} SUSPENDIDO`, source: "pos", lead_status: "cliente", active: true, status: "active", is_wholesale: false, wholesale_status: "suspended" },
  ]).select("id,contact_name,commercial_version");
  assert.ifError(inserted.error);
  customerIds.push(...inserted.data.map((row) => row.id));
  const active = inserted.data.find((row) => row.contact_name.endsWith("ACTIVO"));
  const inactive = inserted.data.find((row) => row.contact_name.endsWith("INACTIVO"));
  const suspended = inserted.data.find((row) => row.contact_name.endsWith("SUSPENDIDO"));
  assert.ok(active && inactive && suspended);

  const search = await client.rpc("search_pos_customers_v1", { p_query: marker, p_limit: 20, p_offset: 0, p_include_inactive: true });
  assert.ifError(search.error);
  assert.deepEqual(search.data.map((row) => row.customer_id), [active.id]);

  const activeContext = await client.rpc("get_selectable_pos_customer_context_v1", { target_customer_id: active.id });
  assert.ifError(activeContext.error);
  assert.equal(activeContext.data[0].customer_status, "active");
  for (const customer of [inactive, suspended]) {
    const result = await client.rpc("get_selectable_pos_customer_context_v1", { target_customer_id: customer.id });
    assert.equal(result.data, null);
    assert.match(result.error?.message ?? "", /POS_CUSTOMER_SUSPENDED/);
  }

  const legacyContext = await client.rpc("get_pos_customer_context_v1", { target_customer_id: active.id });
  assert.equal(legacyContext.data, null);
  assert.equal(legacyContext.error?.code, "42501");

  const created = await client.rpc("create_selectable_pos_sale_draft_v1", { p_request_key: crypto.randomUUID(), p_customer_id: active.id });
  assert.ifError(created.error);
  draftId = created.data.draftId;
  assert.equal(created.data.items.length, 0);

  const legacyCreate = await client.rpc("create_pos_sale_draft_v1", { p_request_key: crypto.randomUUID(), p_customer_id: active.id });
  assert.equal(legacyCreate.data, null);
  assert.equal(legacyCreate.error?.code, "42501");

  const suspendActive = await admin.from("customers")
    .update({ is_wholesale: false, wholesale_status: "suspended" })
    .eq("id", active.id)
    .select("commercial_version")
    .single();
  assert.ifError(suspendActive.error);

  const saveSuspended = await client.rpc("save_pos_sale_draft_v1", {
    p_request_key: crypto.randomUUID(),
    p_draft_id: draftId,
    p_expected_version: 1,
    p_customer_id: active.id,
    p_expected_customer_commercial_version: suspendActive.data.commercial_version,
    p_items: [],
    p_delivery_mode: "store_immediate",
    p_delivery_address: null,
    p_delivery_notes: null,
    p_internal_notes: marker,
    p_delivery_charge: 0,
    p_cash_on_delivery_charge: 0,
    p_other_charges: 0,
  });
  assert.equal(saveSuspended.data, null);
  assert.match(saveSuspended.error?.message ?? "", /POS_CUSTOMER_SUSPENDED/);

  const confirmSuspended = await client.rpc("confirm_selectable_pos_sale_v1", {
    p_draft_id: draftId,
    p_request_key: crypto.randomUUID(),
    p_expected_draft_version: 1,
    p_invoice_date: new Date().toISOString().slice(0, 10),
    p_payment_payload: { method: "cash", amount_tendered: 1 },
  });
  assert.equal(confirmSuspended.data, null);
  assert.match(confirmSuspended.error?.message ?? "", /POS_CUSTOMER_SUSPENDED/);

  const legacyConfirm = await client.rpc("confirm_pos_sale_v1", {
    p_draft_id: draftId,
    p_request_key: crypto.randomUUID(),
    p_expected_draft_version: 1,
    p_invoice_date: new Date().toISOString().slice(0, 10),
    p_payment_payload: { method: "cash", amount_tendered: 1 },
  });
  assert.equal(legacyConfirm.data, null);
  assert.equal(legacyConfirm.error?.code, "42501");

  const after = Object.fromEntries(await Promise.all(economicTables.map(async (table) => [table, await count(table)])));
  assert.deepEqual(after, before, "Operational UX tests changed economic tables");
  console.log(JSON.stringify({ marker, assertions: 22, activeOnlySearch: true, suspendedContextRejected: true, suspendedSaveRejected: true, suspendedConfirmationRejected: true, economicCountsStable: true }, null, 2));
} finally {
  if (draftId) {
    await admin.from("pos_sale_draft_items").delete().eq("draft_id", draftId);
    await admin.from("pos_sale_drafts").delete().eq("id", draftId);
  }
  if (customerIds.length) await admin.from("customers").delete().in("id", customerIds);
  if (userId) {
    await admin.from("users").delete().eq("id", userId);
    await admin.auth.admin.deleteUser(userId);
  }
  if (roleId && originalPermissions) await admin.from("roles").update({ permissions: originalPermissions }).eq("id", roleId);
}
