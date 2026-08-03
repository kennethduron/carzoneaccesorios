import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const password = process.env.WHOLESALE_PROFILE_PASSWORD;
assert.ok(serviceKey && password, "Local service key and password are required.");
assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost):54321$/, "Fixtures are local-only.");

const marker = "WHOLESALE-PROFILE-REFRESH-LOCAL-ONLY";
const email = `${marker.toLowerCase()}@example.test`;
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const permissions = [
  "admin:access", "crm:manage", "customers:read", "customers:manage",
  "customers:read_commercial", "customers:read_credit", "customers:update_identity",
  "wholesale:manage", "credit:read", "credit:manage", "credit:mark_paid",
  "orders:read", "invoices:read",
];

const { data: role, error: roleError } = await admin.from("roles").upsert({
  name: "technical_owner",
  description: marker,
  permissions,
}, { onConflict: "name" }).select("id").single();
assert.ifError(roleError);

const { data: existingCustomers, error: existingError } = await admin
  .from("customers")
  .select("id")
  .ilike("contact_name", `${marker}%`);
assert.ifError(existingError);
if (existingCustomers.length) {
  assert.ifError((await admin.from("customers").delete().in("id", existingCustomers.map((customer) => customer.id))).error);
}

const { data: authList, error: authListError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
assert.ifError(authListError);
for (const user of authList.users.filter((candidate) => candidate.email === email)) {
  assert.ifError((await admin.auth.admin.deleteUser(user.id)).error);
}

const { data: authUser, error: authError } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: `${marker} Administrador` },
});
assert.ifError(authError);
assert.ifError((await admin.from("users").update({ role_id: role.id, active: true }).eq("id", authUser.user.id)).error);

const requestedAt = new Date().toISOString();
const { data: customers, error: customersError } = await admin.from("customers").insert([
  {
    contact_name: `${marker} Cliente pendiente`,
    business_name: `${marker} Empresa`,
    email: `${marker.toLowerCase()}-pending@example.test`,
    phone: "+504 9999-4411",
    source: "crm",
    lead_status: "cliente",
    active: true,
    status: "active",
    is_wholesale: false,
    wholesale_status: "pending",
    wholesale_request_source: "cuenta_registrada",
    wholesale_requested_at: requestedAt,
    commercial_version: 1,
    commercial_notes: "Datos comerciales conservados durante la actualizacion.",
  },
  {
    contact_name: `${marker} Cliente alterno`,
    business_name: `${marker} Alterna`,
    email: `${marker.toLowerCase()}-alternate@example.test`,
    phone: "+504 9999-4422",
    source: "crm",
    lead_status: "cliente",
    active: true,
    status: "active",
    is_wholesale: false,
    wholesale_status: "none",
    commercial_version: 1,
  },
]).select("id, contact_name, commercial_version, wholesale_requested_at");
assert.ifError(customersError);

const pending = customers.find((customer) => customer.contact_name.endsWith("Cliente pendiente"));
assert.ok(pending);
assert.ifError((await admin.from("customer_credit_accounts").insert({
  customer_id: pending.id,
  is_credit_enabled: true,
  credit_limit: 15000,
  terms_days: 30,
  status: "active",
  activated_at: new Date().toISOString(),
  activated_by: authUser.user.id,
  notes: "Credito local para certificar que el perfil completo se conserva.",
})).error);

console.log(JSON.stringify({
  marker,
  email,
  pendingCustomerId: pending.id,
  alternateCustomerId: customers.find((customer) => customer.contact_name.endsWith("Cliente alterno"))?.id,
  query: marker,
}, null, 2));
