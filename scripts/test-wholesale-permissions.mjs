import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  allPermissions,
  hasEffectivePermission,
  rolePermissions,
} from "../src/lib/auth/permissions.ts";

const permission = "wholesale:manage";
const protectedTechnicalEmail = "kennethduron.paz@gmail.com";
const businessOwnerEmail = "car.zone.accesorioshn@gmail.com";

assert.equal(allPermissions.includes(permission), true, "technical_owner must inherit wholesale:manage");
assert.equal(hasEffectivePermission("technical_owner", allPermissions, permission, protectedTechnicalEmail), true);
assert.equal(hasEffectivePermission("cliente", rolePermissions.cliente, permission, protectedTechnicalEmail), true);
assert.equal(hasEffectivePermission("admin", rolePermissions.admin, permission), true);
assert.equal(hasEffectivePermission("business_owner", rolePermissions.business_owner, permission, businessOwnerEmail), true);

for (const role of ["vendedor", "bodega", "contadora", "soporte", "cliente"]) {
  assert.equal(rolePermissions[role].includes(permission), false, `${role} must not receive wholesale:manage`);
  assert.equal(hasEffectivePermission(role, rolePermissions[role], permission), false, `${role} must not manage wholesale status`);
}

const actions = await readFile(new URL("../src/app/admin/crm/actions.ts", import.meta.url), "utf8");
assert.equal(actions.includes("Solo admin o business_owner puede cambiar el estado mayorista."), false);
assert.equal(actions.includes("Solo admin o business_owner puede aprobar solicitudes mayoristas."), false);
assert.match(actions, /hasEffectivePermission\(profile\.role, profile\.permissions, "wholesale:manage", profile\.email\)/);

const migration = await readFile(
  new URL("../supabase/migrations/202605310001_wholesale_management_permission.sql", import.meta.url),
  "utf8",
);
assert.match(migration, /public\.has_permission\('wholesale:manage'\)/);
assert.match(migration, /'technical_owner', 'admin', 'business_owner'/);
assert.match(migration, /'vendedor', 'bodega', 'contadora', 'soporte', 'cliente'/);

console.log("Wholesale permission checks passed.");
