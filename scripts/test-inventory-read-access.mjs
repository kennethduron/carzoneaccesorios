import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { allPermissions, rolePermissions } from "../src/lib/auth/permissions.ts";

const read = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [adminPage, inventoryPage, inventoryManager, inventoryActions, inventoryService, productAccess, permissionTypes, migration] =
  await Promise.all([
    read("src/app/admin/page.tsx"),
    read("src/app/admin/inventario/page.tsx"),
    read("src/components/admin/inventory-manager.tsx"),
    read("src/app/admin/inventario/actions.ts"),
    read("src/services/supabase/admin-inventory.service.ts"),
    read("src/lib/auth/product-access.ts"),
    read("src/types/auth.ts"),
    read("supabase/migrations/202607150006_inventory_read_access_for_accountant.sql"),
  ]);

assert.equal(allPermissions.includes("inventory:read"), true);
assert.match(permissionTypes, /\| "inventory:read"/);

for (const role of ["technical_owner", "admin", "business_owner", "bodega", "contadora"]) {
  assert.equal(rolePermissions[role].includes("inventory:read"), true, `${role} must read inventory`);
}
for (const role of ["vendedor", "soporte", "cliente"]) {
  assert.equal(rolePermissions[role].includes("inventory:read"), false, `${role} must not read inventory`);
}
assert.equal(rolePermissions.contadora.includes("inventory:manage"), false);
assert.equal(rolePermissions.contadora.includes("products:adjust_stock"), false);
assert.equal(rolePermissions.contadora.includes("products:manage"), false);
assert.equal(rolePermissions.contadora.includes("products:delete"), false);

assert.match(adminPage, /\["operacion", "compras", "finanzas"\]/);
assert.match(adminPage, /title: "Inventario — Consulta"/);
assert.match(adminPage, /permissions: \["products:read", "products:manage"\]/);
assert.match(adminPage, /permissions: \["inventory:read", "inventory:manage"\]/);
assert.doesNotMatch(adminPage, /\["operacion", "inventario", "compras", "finanzas"\]/);

assert.match(inventoryPage, /requirePermission\("admin:access"\)/);
assert.match(inventoryPage, /const canManageInventory = hasEffectivePermission[\s\S]*"inventory:manage"/);
assert.match(inventoryPage, /const canReadInventory =[\s\S]*"inventory:read"/);
assert.match(inventoryPage, /if \(!canReadInventory\) \{[\s\S]*redirect\("\/sin-permiso"\)/);
assert.match(inventoryPage, /includeManagementOptions: canManageInventory/);
assert.match(inventoryPage, /canManageInventory=\{canManageInventory\}/);

assert.match(inventoryManager, /canManageInventory: boolean/);
assert.match(inventoryManager, /\{!canManageInventory \? \(/);
assert.match(inventoryManager, /Acceso de consulta\. Las entradas y cambios de inventario se registran mediante Compras/);
assert.match(inventoryManager, /\{canManageInventory \? \([\s\S]*Registrar movimiento/);
assert.match(inventoryManager, /<InventorySearchForm productQuery=\{productQuery\} activeFilter=\{activeFilter\} \/>/);
assert.match(inventoryManager, /Buscar inventario/);
assert.match(inventoryManager, /canManageInventory \? "Opciones cargadas" : "Bajo mínimo"/);
assert.match(inventoryManager, /Stock total/);
assert.match(inventoryManager, /Reservado/);
assert.match(inventoryManager, /Disponible/);
assert.match(inventoryManager, /Stock minimo/);
assert.match(inventoryManager, /Historial/);

assert.match(inventoryService, /includeManagementOptions\?: boolean/);
assert.match(inventoryService, /filters\.includeManagementOptions[\s\S]*\.limit\(1000\)[\s\S]*Promise\.resolve\(\{ data: \[\]/);
assert.match(inventoryService, /movementPageSize/);
assert.match(inventoryService, /\.range\(movementFrom, movementTo\)/);

assert.match(inventoryActions, /createInventoryMovementAction[\s\S]*requirePermission\("inventory:manage"\)/);
assert.doesNotMatch(inventoryActions, /requirePermission\("inventory:read"\)/);
assert.doesNotMatch(productAccess, /inventory:read/);

assert.match(migration, /where name = 'contadora'[\s\S]*permissions[\s\S]*\? 'inventory:manage'/);
assert.match(migration, /"Inventory readers can read movements"[\s\S]*for select/);
assert.match(migration, /"Staff can read inventory reservations"[\s\S]*'inventory:read'/);
assert.match(migration, /"Product staff can read all products"[\s\S]*'inventory:read'/);
assert.match(migration, /get_admin_low_stock_products[\s\S]*security definer[\s\S]*set search_path = public/);
assert.match(migration, /auth\.role\(\) = 'service_role'[\s\S]*'inventory:read'[\s\S]*'inventory:manage'/);
assert.match(migration, /errcode = '42501'/);
assert.match(migration, /revoke all on function public\.get_admin_low_stock_products[\s\S]*from public, anon, authenticated/);
assert.doesNotMatch(migration, /grant (insert|update|delete)/i);
assert.doesNotMatch(migration, /create_inventory_movement_locked/);
assert.doesNotMatch(migration, /set_product_stock_locked/);

console.log("INVENTORY_READ_ACCESS_STRUCTURE_PASS");
