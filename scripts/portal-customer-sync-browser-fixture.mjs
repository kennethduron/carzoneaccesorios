import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const mode = process.argv[2] ?? "setup";
const adminEmail = "portal-sync-browser-admin@example.test";
const adminPassword = process.env.PORTAL_SYNC_BROWSER_PASSWORD ?? "Local-Cz-Portal-2026!";
const registrationPrefix = "portal-sync-browser-customer";

if (!serviceKey) {
  throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY.");
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function findAuthUsers() {
  const matches = [];
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    assert.ifError(error);
    matches.push(
      ...data.users.filter(
        (user) => user.email === adminEmail || user.email?.startsWith(`${registrationPrefix}-`),
      ),
    );
    if (data.users.length < 100) break;
  }
  return matches;
}

async function cleanup() {
  const users = await findAuthUsers();
  const userIds = users.map((user) => user.id);
  if (userIds.length > 0) {
    const { data: customers } = await admin.from("customers").select("id").in("user_id", userIds);
    const customerIds = (customers ?? []).map((customer) => customer.id);
    if (customerIds.length > 0) {
      await admin.from("internal_notifications").delete().in("customer_id", customerIds);
      await admin.from("customers").delete().in("id", customerIds);
    }
    await admin.from("portal_customer_link_reviews").delete().in("portal_user_id", userIds);
    await admin.from("portal_customer_profile_sync_requests").delete().in("portal_user_id", userIds);
    await admin.from("portal_customer_profile_syncs").delete().in("portal_user_id", userIds);
    for (const user of users) {
      await admin.auth.admin.deleteUser(user.id);
    }
  }
}

if (mode === "cleanup") {
  await cleanup();
  console.log("Portal customer browser fixture cleanup: OK");
  process.exit(0);
}

await cleanup();
const { data: roles, error: rolesError } = await admin
  .from("roles")
  .upsert(
    [
      { name: "cliente", description: "Cliente de portal", permissions: [] },
      {
        name: "admin",
        description: "Administrador local",
        permissions: [
          "admin:access",
          "crm:manage",
          "customers:manage",
          "customers:link_portal_account",
          "notifications:read",
        ],
      },
    ],
    { onConflict: "name" },
  )
  .select("id, name");
assert.ifError(rolesError);
const adminRoleId = roles.find((role) => role.name === "admin")?.id;
assert.ok(adminRoleId);

const { data: createdAdmin, error: createAdminError } = await admin.auth.admin.createUser({
  email: adminEmail,
  password: adminPassword,
  email_confirm: true,
  user_metadata: {
    full_name: "Administrador Browser Local",
    username: "portal.sync.admin",
    phone: "+504 9999-0000",
  },
});
assert.ifError(createAdminError);
const { error: updateRoleError } = await admin
  .from("users")
  .update({ role_id: adminRoleId, active: true })
  .eq("id", createdAdmin.user.id);
assert.ifError(updateRoleError);

console.log(JSON.stringify({ ok: true, adminEmail, registrationPrefix }));
