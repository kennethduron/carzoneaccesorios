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
assert.ok(env.SUPABASE_SERVICE_ROLE_KEY, "Missing SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const roleNames = ["technical_owner", "business_owner", "admin", "vendedor", "bodega", "contadora", "soporte", "cliente"];
const { data: roles, error: rolesError } = await supabase.from("roles").select("name, permissions").in("name", roleNames);
assert.ifError(rolesError);
const rolesByName = new Map(roles.map((role) => [role.name, role.permissions]));

assert.deepEqual([...rolesByName.keys()].sort(), [...roleNames].sort(), "All final roles must exist remotely");
for (const permission of ["technical:tools", "system:backups", "system:monitoring", "security:manage", "users:manage"]) {
  assert.equal(rolesByName.get("technical_owner")?.includes(permission), true, `technical_owner must have ${permission}`);
}
for (const role of ["business_owner", "admin"]) {
  assert.equal(rolesByName.get(role)?.includes("security:read"), true, `${role} must access security`);
  assert.equal(rolesByName.get(role)?.includes("technical:tools"), false, `${role} must not access technical tools`);
  assert.equal(rolesByName.get(role)?.includes("system:backups"), false, `${role} must not access backups`);
}
assert.equal(rolesByName.get("business_owner")?.includes("roles:assign_admin"), true);
assert.equal(rolesByName.get("admin")?.includes("roles:assign_admin"), false);
assert.equal(rolesByName.get("bodega")?.includes("orders:manage_logistics"), true);
assert.equal(rolesByName.get("bodega")?.includes("orders:manage"), false);
assert.equal(rolesByName.get("contadora")?.includes("fiscal:read"), true);
assert.equal(rolesByName.get("contadora")?.includes("reports:fiscal_read"), true);
assert.equal(rolesByName.get("contadora")?.includes("invoices:read"), true);
assert.equal(rolesByName.get("contadora")?.includes("payments:manage"), false);
assert.equal(rolesByName.get("contadora")?.includes("payments:confirm"), false);
assert.equal(rolesByName.get("contadora")?.includes("orders:read"), false);
assert.equal(rolesByName.get("contadora")?.includes("crm:manage"), false);
assert.equal(rolesByName.get("contadora")?.includes("inventory:manage"), false);

for (const role of ["vendedor", "bodega", "contadora", "soporte", "cliente"]) {
  assert.equal(rolesByName.get(role)?.includes("security:read"), false, `${role} must not access security`);
}
assert.equal(rolesByName.get("cliente")?.includes("admin:access"), false, "cliente must not access admin");

const { data: users, error: usersError } = await supabase
  .from("users")
  .select("email, username, active, roles(name)")
  .or("email.eq.kennethduron.paz@gmail.com,email.eq.car.zone.accesorioshn@gmail.com,username.eq.jleiva03");
assert.ifError(usersError);
const technicalOwner = users.find((user) => user.email?.toLowerCase() === "kennethduron.paz@gmail.com");
const businessOwner = users.find(
  (user) => user.email?.toLowerCase() === "car.zone.accesorioshn@gmail.com" || user.username?.toLowerCase() === "jleiva03",
);
assert.equal(technicalOwner?.active, true, "Protected technical owner must be active");
assert.equal(technicalOwner?.roles?.name, "technical_owner", "Protected technical owner must retain technical_owner");
assert.equal(businessOwner?.active, true, "Business owner must be active");
assert.equal(businessOwner?.roles?.name, "business_owner", "Business owner must retain business_owner");

console.log("Remote role hierarchy checks passed.");
