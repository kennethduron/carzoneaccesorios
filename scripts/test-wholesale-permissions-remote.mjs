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
const permission = "wholesale:manage";

const { data: roles, error: rolesError } = await supabase
  .from("roles")
  .select("name, permissions")
  .in("name", ["technical_owner", "admin", "business_owner", "vendedor", "bodega", "contadora", "soporte", "cliente"]);

assert.ifError(rolesError);
const rolesByName = new Map(roles.map((role) => [role.name, role.permissions]));

for (const role of ["technical_owner", "admin", "business_owner"]) {
  assert.equal(rolesByName.get(role)?.includes(permission), true, `${role} must have ${permission} remotely`);
}

for (const role of ["vendedor", "bodega", "contadora", "soporte", "cliente"]) {
  assert.equal(rolesByName.get(role)?.includes(permission), false, `${role} must not have ${permission} remotely`);
}

const { data: users, error: usersError } = await supabase
  .from("users")
  .select("email, active, roles(name)")
  .in("email", ["kennethduron.paz@gmail.com", "car.zone.accesorioshn@gmail.com"]);

assert.ifError(usersError);
const usersByEmail = new Map(users.map((user) => [user.email?.toLowerCase(), user]));
const technicalOwner = usersByEmail.get("kennethduron.paz@gmail.com");
const businessOwner = usersByEmail.get("car.zone.accesorioshn@gmail.com");

assert.equal(technicalOwner?.active, true, "Protected technical owner must be active");
assert.equal(technicalOwner?.roles?.name, "technical_owner", "Protected technical owner must retain technical_owner");
assert.equal(businessOwner?.active, true, "Business owner must be active");
assert.equal(businessOwner?.roles?.name, "business_owner", "Business owner must retain business_owner");

console.log("Remote wholesale permission checks passed.");
