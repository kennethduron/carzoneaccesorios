import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const envFile = await readFile(new URL("../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(
  envFile
    .split(/\r?\n/)
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
assert.ok(env.NEXT_PUBLIC_SUPABASE_URL, "Missing NEXT_PUBLIC_SUPABASE_URL");
assert.ok(env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");
assert.ok(env.SUPABASE_SERVICE_ROLE_KEY, "Missing SUPABASE_SERVICE_ROLE_KEY");

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const productionUrl = "https://carzoneaccesorios.com";
const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = `RoleTest-${suffix}-A1!`;
const testUsers = [];
let backupLogId = null;

const { data: roles, error: rolesError } = await admin.from("roles").select("id, name");
assert.ifError(rolesError);
const roleIds = new Map(roles.map((role) => [role.name, role.id]));

async function createTestUser(label, role) {
  const email = `codex-role-${label}-${suffix}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `Codex ${label}` },
  });
  assert.ifError(error);
  assert.ok(data.user?.id, `Missing auth user for ${label}`);
  testUsers.push(data.user.id);

  const { error: profileError } = await admin.from("users").upsert({
    id: data.user.id,
    role_id: roleIds.get(role),
    full_name: `Codex ${label}`,
    username: `codex_${label}_${suffix}`.replaceAll("-", "_"),
    email,
    active: true,
  });
  assert.ifError(profileError);
  return { id: data.user.id, email, role };
}

async function signedInClient(user) {
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: user.email, password });
  assert.ifError(error);
  return client;
}

async function changeRole(client, target, role) {
  const { data, error } = await client.rpc("change_user_role", {
    target_user_id: target.id,
    target_role_name: role,
    change_reason: "Prueba automatizada de jerarquia",
    technical_confirmation: "CONFIRMAR CAMBIO TECNICO",
  });
  assert.ifError(error);
  return data;
}

async function setActive(client, target, active) {
  const { data, error } = await client.rpc("set_user_active", {
    target_user_id: target.id,
    next_active: active,
    change_reason: "Prueba automatizada de jerarquia",
    technical_confirmation: "CONFIRMAR CAMBIO TECNICO",
  });
  assert.ifError(error);
  return data;
}

async function ssrCookieHeader(client) {
  const {
    data: { session },
  } = await client.auth.getSession();
  assert.ok(session, "Missing authenticated session");
  const key = `sb-${new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
  const encoded = `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  const chunks = [];
  for (let index = 0; index < encoded.length; index += 3180) {
    chunks.push(encoded.slice(index, index + 3180));
  }
  return chunks.map((value, index) => `${chunks.length === 1 ? key : `${key}.${index}`}=${value}`).join("; ");
}

async function assertRoute(client, path, { status, location = null }) {
  const response = await fetch(`${productionUrl}${path}`, {
    headers: { cookie: await ssrCookieHeader(client) },
    redirect: "manual",
  });
  assert.equal(response.status, status, `${path} returned ${response.status}`);
  if (location) {
    assert.equal(response.headers.get("location"), location, `${path} must redirect to ${location}`);
  }
}

try {
  const technicalOwner = await createTestUser("technical", "technical_owner");
  const businessOwner = await createTestUser("business", "business_owner");
  const delegatedAdmin = await createTestUser("admin", "admin");
  const seller = await createTestUser("seller", "vendedor");
  const employee = await createTestUser("employee", "cliente");

  const technicalClient = await signedInClient(technicalOwner);
  const businessClient = await signedInClient(businessOwner);
  const adminClient = await signedInClient(delegatedAdmin);
  const sellerClient = await signedInClient(seller);

  assert.equal((await changeRole(businessClient, employee, "admin")).ok, true, "business_owner must assign admin");
  assert.equal((await changeRole(businessClient, employee, "vendedor")).ok, true, "business_owner must assign operational roles");
  assert.equal((await changeRole(businessClient, technicalOwner, "cliente")).ok, false, "business_owner must not modify technical_owner");
  assert.equal((await setActive(businessClient, businessOwner, false)).ok, false, "business_owner must not suspend self");

  assert.equal((await changeRole(adminClient, employee, "bodega")).ok, true, "admin must assign operational roles");
  assert.equal((await changeRole(adminClient, employee, "admin")).ok, false, "admin must not assign admin");
  assert.equal((await changeRole(adminClient, businessOwner, "cliente")).ok, false, "admin must not modify business_owner");
  assert.equal((await changeRole(adminClient, delegatedAdmin, "cliente")).ok, false, "admin must not change own role");
  assert.equal((await setActive(adminClient, delegatedAdmin, false)).ok, false, "admin must not suspend self");

  assert.equal((await changeRole(sellerClient, employee, "cliente")).ok, false, "vendedor must not change roles");
  assert.equal((await setActive(sellerClient, employee, false)).ok, false, "vendedor must not suspend users");

  assert.equal((await changeRole(technicalClient, employee, "business_owner")).ok, true, "technical_owner must assign business_owner");
  assert.equal((await changeRole(technicalClient, employee, "cliente")).ok, true, "technical_owner must assign any role");
  assert.equal((await setActive(technicalClient, businessOwner, false)).ok, true, "technical_owner must suspend business_owner");
  assert.equal((await setActive(technicalClient, businessOwner, true)).ok, true, "technical_owner must reactivate business_owner");

  const customerClient = await signedInClient(employee);
  await assertRoute(technicalClient, "/admin/seguridad", { status: 200 });
  await assertRoute(technicalClient, "/admin/uso", { status: 200 });
  await assertRoute(businessClient, "/admin/seguridad", { status: 200 });
  await assertRoute(businessClient, "/admin/uso", { status: 307, location: "/sin-permiso" });
  await assertRoute(adminClient, "/admin/seguridad", { status: 200 });
  await assertRoute(adminClient, "/admin/uso", { status: 307, location: "/sin-permiso" });
  await assertRoute(sellerClient, "/admin", { status: 200 });
  await assertRoute(sellerClient, "/admin/seguridad", { status: 307, location: "/sin-permiso" });
  await assertRoute(customerClient, "/admin", { status: 307, location: "/sin-permiso" });

  const { data: backupLog, error: backupInsertError } = await technicalClient
    .from("backup_logs")
    .insert({ requested_by: technicalOwner.id, backup_type: "manual", status: "requested", notes: "Role hierarchy RLS test" })
    .select("id")
    .single();
  assert.ifError(backupInsertError);
  backupLogId = backupLog.id;

  const { data: technicalBackups, error: technicalBackupsError } = await technicalClient.from("backup_logs").select("id").eq("id", backupLogId);
  assert.ifError(technicalBackupsError);
  assert.equal(technicalBackups.length, 1, "technical_owner must read backups");

  const { data: businessBackups, error: businessBackupsError } = await businessClient.from("backup_logs").select("id").eq("id", backupLogId);
  assert.ifError(businessBackupsError);
  assert.equal(businessBackups.length, 0, "business_owner must not read technical backups");

  const { count: blockedAuditCount, error: blockedAuditError } = await admin
    .from("audit_logs")
    .select("id", { count: "exact", head: true })
    .in("record_id", testUsers)
    .like("action", "%blocked");
  assert.ifError(blockedAuditError);
  assert.ok((blockedAuditCount ?? 0) >= 6, "Blocked security attempts must remain audited");

  console.log("Remote role hierarchy RPC/RLS checks passed.");
} finally {
  if (backupLogId) {
    await admin.from("backup_logs").delete().eq("id", backupLogId);
  }
  for (const userId of testUsers.reverse()) {
    await admin.auth.admin.deleteUser(userId);
  }
}
