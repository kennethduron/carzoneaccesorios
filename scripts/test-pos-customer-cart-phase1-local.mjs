import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
assert.ok(serviceKey && anonKey, "Local Supabase keys are required.");
assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost):54321$/, "This test is local-only.");

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const marker = "POS-CUSTOMER-CART-LOCAL-ONLY";
const run = Date.now();
const password = `Cz-${crypto.randomUUID()}!a9`;
const authIds = [];

async function count(table) {
  const { count: value, error } = await admin.from(table).select("id", { count: "exact", head: true });
  assert.ifError(error);
  return value ?? 0;
}

async function upsertRole(name, permissions) {
  const { data, error } = await admin.from("roles").upsert({
    name,
    description: `${marker} ${name}`,
    permissions,
  }, { onConflict: "name" }).select("id").single();
  assert.ifError(error);
  return data.id;
}

async function actor(roleName, permissions) {
  const roleId = await upsertRole(roleName, permissions);
  const email = `${marker.toLowerCase()}-${run}-${roleName}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `${marker} ${roleName}` },
  });
  assert.ifError(error);
  authIds.push(data.user.id);
  const { error: updateError } = await admin.from("users").update({ role_id: roleId, active: true }).eq("id", data.user.id);
  assert.ifError(updateError);
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);
  return { client, id: data.user.id };
}

const authorizedPermissions = [
  "pos:create_sale", "pos:access", "pos:customers:search", "pos:customers:create",
  "pos:customers:update", "customers:read_commercial", "customers:read_credit",
  "wholesale:manage", "credit:read", "credit:manage", "customers:link_portal_account",
];

function profileInput(overrides = {}) {
  return {
    p_request_key: crypto.randomUUID(),
    p_customer_id: null,
    p_expected_commercial_version: null,
    p_contact_name: `${marker} ${run} Cliente`,
    p_phone: null,
    p_email: null,
    p_business_name: null,
    p_tax_id: null,
    p_address: null,
    p_city: null,
    p_commercial_notes: null,
    p_customer_type: "retail",
    p_credit_mode: "none",
    p_credit_limit: 0,
    p_credit_terms_days: 30,
    p_credit_notes: null,
    p_change_reason: "Configuración local certificada desde Punto de Venta.",
    ...overrides,
  };
}

const economicTables = [
  "orders", "invoices", "payments", "accounts_receivable",
  "inventory_movements", "journal_entries", "journal_entry_lines",
];

const before = Object.fromEntries(await Promise.all(economicTables.map(async (table) => [table, await count(table)])));
const operator = await actor("technical_owner", authorizedPermissions);
const unauthorized = await actor("soporte", []);

const nameOnlyInput = profileInput({ p_contact_name: `${marker} ${run} Solo Nombre` });
const { data: nameOnly, error: nameOnlyError } = await operator.client.rpc("save_pos_customer_commercial_profile_v1", nameOnlyInput);
assert.ifError(nameOnlyError);
assert.equal(nameOnly.ok, true);
assert.equal(nameOnly.customerType, "retail");
const { data: nameOnlyRow } = await admin.from("customers").select("phone,email,tax_id,user_id,is_wholesale,wholesale_status").eq("id", nameOnly.customerId).single();
assert.equal(nameOnlyRow.phone, null);
assert.equal(nameOnlyRow.email, null);
assert.equal(nameOnlyRow.tax_id, null);
assert.equal(nameOnlyRow.user_id, null);
assert.equal(nameOnlyRow.is_wholesale, false);

const duplicateName = await operator.client.rpc("save_pos_customer_commercial_profile_v1", {
  ...nameOnlyInput,
  p_request_key: crypto.randomUUID(),
});
assert.ifError(duplicateName.error);
assert.equal(duplicateName.data.status, "possible_duplicate");
assert.equal(duplicateName.data.customerId, nameOnly.customerId);

for (const [field, value, code] of [
  ["p_phone", "123", "CUSTOMER_PHONE_INVALID"],
  ["p_email", "correo-invalido", "CUSTOMER_EMAIL_INVALID"],
  ["p_tax_id", "0801-12", "CUSTOMER_RTN_INVALID"],
]) {
  const invalid = await operator.client.rpc("save_pos_customer_commercial_profile_v1", profileInput({
    p_contact_name: `${marker} ${run} Invalid ${field}`,
    [field]: value,
  }));
  assert.equal(invalid.data, null);
  assert.match(invalid.error?.message ?? "", new RegExp(code));
}

const fullRequestKey = crypto.randomUUID();
const fullInput = profileInput({
  p_request_key: fullRequestKey,
  p_contact_name: `${marker} ${run} Mayorista Crédito`,
  p_phone: `+5049${String(run).slice(-7)}`,
  p_email: `${marker.toLowerCase()}-${run}-customer@example.test`,
  p_business_name: `${marker} Empresa`,
  p_tax_id: `0801${String(run).slice(-10)}`,
  p_address: "Tegucigalpa, Honduras",
  p_city: "Tegucigalpa",
  p_commercial_notes: `${marker} nota no sensible`,
  p_customer_type: "wholesale",
  p_credit_mode: "active",
  p_credit_limit: 25000.55,
  p_credit_terms_days: 45,
  p_credit_notes: `${marker} pago a 45 días`,
});
const { data: full, error: fullError } = await operator.client.rpc("save_pos_customer_commercial_profile_v1", fullInput);
assert.ifError(fullError);
assert.equal(full.ok, true);
assert.equal(full.customerType, "wholesale");
assert.equal(full.wholesaleStatus, "approved");

const replay = await operator.client.rpc("save_pos_customer_commercial_profile_v1", fullInput);
assert.ifError(replay.error);
assert.equal(replay.data.customerId, full.customerId);
assert.equal(replay.data.idempotentReplay, true);

const { data: commercial } = await admin.from("customers")
  .select("id,user_id,is_wholesale,wholesale_status,commercial_version")
  .eq("id", full.customerId).single();
assert.equal(commercial.user_id, null);
assert.equal(commercial.is_wholesale, true);
assert.equal(commercial.wholesale_status, "approved");
const { data: credit } = await admin.from("customer_credit_accounts")
  .select("is_credit_enabled,credit_limit,terms_days,status,notes")
  .eq("customer_id", full.customerId).single();
assert.equal(credit.is_credit_enabled, true);
assert.equal(Number(credit.credit_limit), 25000.55);
assert.equal(credit.terms_days, 45);
assert.equal(credit.status, "active");
const { count: wholesaleHistory } = await admin.from("wholesale_access_history")
  .select("id", { count: "exact", head: true }).eq("customer_id", full.customerId);
assert.equal(wholesaleHistory, 1);
const { count: profileAudits } = await admin.from("audit_logs")
  .select("id", { count: "exact", head: true })
  .eq("record_id", full.customerId).eq("action", "pos.customer.commercial_profile_saved");
assert.equal(profileAudits, 1);

const invalidCreditName = `${marker} ${run} Crédito Inválido`;
const invalidCredit = await operator.client.rpc("save_pos_customer_commercial_profile_v1", profileInput({
  p_contact_name: invalidCreditName,
  p_credit_mode: "active",
  p_credit_limit: 0,
}));
assert.equal(invalidCredit.data, null);
assert.match(invalidCredit.error?.message ?? "", /CREDIT_CONFIGURATION_INVALID/);
const { count: invalidCreditRows } = await admin.from("customers")
  .select("id", { count: "exact", head: true }).eq("contact_name", invalidCreditName);
assert.equal(invalidCreditRows, 0);

const denied = await unauthorized.client.rpc("save_pos_customer_commercial_profile_v1", profileInput({
  p_contact_name: `${marker} ${run} Denegado`,
}));
assert.equal(denied.data, null);
assert.equal(denied.error?.code, "42501");

const updateRetail = await operator.client.rpc("save_pos_customer_commercial_profile_v1", profileInput({
  p_customer_id: full.customerId,
  p_expected_commercial_version: commercial.commercial_version,
  p_contact_name: fullInput.p_contact_name,
  p_phone: fullInput.p_phone,
  p_email: fullInput.p_email,
  p_business_name: fullInput.p_business_name,
  p_tax_id: fullInput.p_tax_id,
  p_address: fullInput.p_address,
  p_city: fullInput.p_city,
  p_commercial_notes: fullInput.p_commercial_notes,
  p_customer_type: "retail",
  p_credit_mode: "suspended",
  p_credit_limit: 30000,
  p_credit_terms_days: 60,
  p_credit_notes: `${marker} crédito suspendido`,
}));
assert.ifError(updateRetail.error);
assert.equal(updateRetail.data.customerType, "retail");
assert.equal(updateRetail.data.wholesaleStatus, "none");
const { data: suspendedCredit } = await admin.from("customer_credit_accounts")
  .select("is_credit_enabled,credit_limit,terms_days,status").eq("customer_id", full.customerId).single();
assert.equal(suspendedCredit.is_credit_enabled, true);
assert.equal(suspendedCredit.status, "suspended");
assert.equal(Number(suspendedCredit.credit_limit), 30000);
assert.equal(suspendedCredit.terms_days, 60);
const { count: retailHistory } = await admin.from("wholesale_access_history")
  .select("id", { count: "exact", head: true })
  .eq("customer_id", full.customerId).eq("operation", "return_to_retail");
assert.equal(retailHistory, 1);

const stale = await operator.client.rpc("save_pos_customer_commercial_profile_v1", {
  ...profileInput(),
  p_customer_id: full.customerId,
  p_expected_commercial_version: commercial.commercial_version,
  p_contact_name: fullInput.p_contact_name,
  p_customer_type: "retail",
  p_credit_mode: "unchanged",
});
assert.ifError(stale.error);
assert.equal(stale.data.status, "version_conflict");

const { data: beforeReactivate } = await admin.from("customers")
  .select("commercial_version").eq("id", full.customerId).single();
const reactivate = await operator.client.rpc("save_pos_customer_commercial_profile_v1", profileInput({
  p_customer_id: full.customerId,
  p_expected_commercial_version: beforeReactivate.commercial_version,
  p_contact_name: fullInput.p_contact_name,
  p_phone: fullInput.p_phone,
  p_email: fullInput.p_email,
  p_business_name: fullInput.p_business_name,
  p_tax_id: fullInput.p_tax_id,
  p_address: fullInput.p_address,
  p_city: fullInput.p_city,
  p_commercial_notes: fullInput.p_commercial_notes,
  p_customer_type: "wholesale",
  p_credit_mode: "active",
  p_credit_limit: 35000,
  p_credit_terms_days: 90,
  p_credit_notes: `${marker} crédito reactivado`,
}));
assert.ifError(reactivate.error);
assert.equal(reactivate.data.customerType, "wholesale");
assert.equal(reactivate.data.wholesaleStatus, "approved");

const clientRoleId = await upsertRole("cliente", []);
const portalEmail = `${marker.toLowerCase()}-${run}-portal@example.test`;
const { data: portalAccount, error: portalError } = await admin.auth.admin.createUser({
  email: portalEmail,
  password,
  email_confirm: true,
  user_metadata: { full_name: `${marker} Portal`, phone: fullInput.p_phone },
});
assert.ifError(portalError);
authIds.push(portalAccount.user.id);
await admin.from("users").update({ role_id: clientRoleId, active: true, phone: fullInput.p_phone }).eq("id", portalAccount.user.id);
const { data: beforeLink } = await admin.from("customers").select("commercial_version").eq("id", full.customerId).single();
const link = await operator.client.rpc("link_customer_portal_account_v2", {
  p_request_key: crypto.randomUUID(),
  p_customer_id: full.customerId,
  p_portal_user_id: portalAccount.user.id,
  p_expected_commercial_version: beforeLink.commercial_version,
  p_evidence_source: "manual_verified_identity",
  p_evidence_reference: `manual:${full.customerId}:${portalAccount.user.id}`,
  p_reason: "Identidad verificada manualmente para certificación local aislada.",
});
assert.ifError(link.error);
assert.equal(link.data.ok, true);
const { data: linkedCustomer } = await admin.from("customers")
  .select("user_id,is_wholesale,wholesale_status").eq("id", full.customerId).single();
assert.equal(linkedCustomer.user_id, portalAccount.user.id);
assert.equal(linkedCustomer.is_wholesale, true);
assert.equal(linkedCustomer.wholesale_status, "approved");
const { data: linkedCredit } = await admin.from("customer_credit_accounts")
  .select("credit_limit,terms_days,status").eq("customer_id", full.customerId).single();
assert.equal(Number(linkedCredit.credit_limit), 35000);
assert.equal(linkedCredit.terms_days, 90);
assert.equal(linkedCredit.status, "active");
const { count: linkedProfiles } = await admin.from("customers")
  .select("id", { count: "exact", head: true }).eq("user_id", portalAccount.user.id);
assert.equal(linkedProfiles, 1);

const after = Object.fromEntries(await Promise.all(economicTables.map(async (table) => [table, await count(table)])));
assert.deepEqual(after, before, "Customer setup must not create economic rows");

console.log(JSON.stringify({
  marker,
  assertions: 48,
  nameOnlyCustomerId: nameOnly.customerId,
  commercialCustomerId: full.customerId,
  economicCountsStable: true,
  portalLinkPreservedProfile: true,
  authCreatedOnlyLocally: authIds.length,
}, null, 2));
