import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  allPermissions,
  hasEffectivePermission,
  rolePermissions,
} from "../src/lib/auth/permissions.ts";

const protectedTechnicalEmail = "kennethduron.paz@gmail.com";
const operationalRoles = ["vendedor", "bodega", "contadora", "soporte", "cliente"];

for (const permission of ["security:read", "security:manage", "system:monitoring", "system:backups", "technical:tools"]) {
  assert.equal(allPermissions.includes(permission), true, `technical_owner must inherit ${permission}`);
  assert.equal(hasEffectivePermission("technical_owner", allPermissions, permission, protectedTechnicalEmail), true);
}

assert.equal(hasEffectivePermission("admin", [], "technical:tools"), false, "admin must not be an implicit superuser");
assert.equal(rolePermissions.business_owner.includes("roles:assign_admin"), true);
assert.equal(rolePermissions.business_owner.includes("technical:tools"), false);
assert.equal(rolePermissions.business_owner.includes("system:backups"), false);
assert.equal(rolePermissions.admin.includes("roles:assign_operational"), true);
assert.equal(rolePermissions.admin.includes("roles:assign_admin"), false);
assert.equal(rolePermissions.admin.includes("technical:tools"), false);
assert.equal(rolePermissions.bodega.includes("orders:manage_logistics"), true);
assert.equal(rolePermissions.bodega.includes("orders:manage"), false);
assert.equal(rolePermissions.contadora.includes("fiscal:read"), true);
assert.equal(rolePermissions.contadora.includes("reports:fiscal_read"), true);
assert.equal(rolePermissions.contadora.includes("invoices:read"), true);
assert.equal(rolePermissions.contadora.includes("payments:manage"), false);
assert.equal(rolePermissions.contadora.includes("payments:confirm"), false);
assert.equal(rolePermissions.contadora.includes("orders:read"), true);
assert.equal(rolePermissions.contadora.includes("invoices:create"), true);
assert.equal(rolePermissions.contadora.includes("crm:manage"), false);
assert.equal(rolePermissions.contadora.includes("customers:link_portal_account"), true);
assert.equal(rolePermissions.contadora.includes("customers:update_identity"), false);
for (const role of ["business_owner", "admin"]) {
  assert.equal(rolePermissions[role].includes("customers:update_identity"), true, `${role} must edit customer identity`);
}
for (const role of ["vendedor", "bodega", "contadora", "soporte", "cliente"]) {
  assert.equal(rolePermissions[role].includes("customers:update_identity"), false, `${role} must not edit customer identity`);
}
assert.equal(rolePermissions.contadora.includes("inventory:read"), true);
assert.equal(rolePermissions.contadora.includes("inventory:manage"), false);
assert.equal(rolePermissions.admin.includes("inventory:read"), true);
assert.equal(rolePermissions.business_owner.includes("inventory:read"), true);
assert.equal(rolePermissions.bodega.includes("inventory:read"), true);

for (const role of operationalRoles) {
  assert.equal(rolePermissions[role].includes("security:read"), false, `${role} must not access security`);
  assert.equal(rolePermissions[role].includes("technical:tools"), false, `${role} must not access technical tools`);
}

assert.equal(rolePermissions.cliente.includes("admin:access"), false, "cliente must not access admin");
assert.equal(hasEffectivePermission("cliente", rolePermissions.cliente, "technical:tools", protectedTechnicalEmail), true);

const accessControl = await readFile(new URL("../src/lib/auth/access-control.ts", import.meta.url), "utf8");
assert.match(accessControl, /securityAccessRoles: AppRole\[\] = \["technical_owner", "business_owner", "admin"\]/);
assert.match(accessControl, /profile\.role === "business_owner"[\s\S]*return \["admin", \.\.\.operationalRoles\]/);
assert.match(accessControl, /profile\.role === "admin"[\s\S]*return operationalRoles/);
assert.match(accessControl, /profile\.id === user\.id[\s\S]*return false/);
assert.match(accessControl, /isProtectedTechnicalUser\(user\) \|\| user\.role === "business_owner"/);

const proxy = await readFile(new URL("../src/proxy.ts", import.meta.url), "utf8");
assert.match(proxy, /pathname\.startsWith\("\/admin\/seguridad"\)/);
assert.match(proxy, /pathname\.startsWith\("\/admin\/uso"\)/);

const migration = await readFile(
  new URL("../supabase/migrations/202605310002_role_hierarchy_least_privilege.sql", import.meta.url),
  "utf8",
);
assert.match(migration, /roles\.name = 'technical_owner'/);
assert.doesNotMatch(migration, /roles\.name in \('admin', 'technical_owner'\)/);
assert.match(migration, /create function public\.change_user_role[\s\S]*returns jsonb/);
assert.match(migration, /No puedes modificar tu propia cuenta\./);
assert.match(migration, /Este usuario tecnico esta protegido\./);
assert.match(migration, /public\.has_permission\('system:backups'\)/);
assert.match(migration, /public\.advance_order_logistics/);

console.log("Role hierarchy checks passed.");
