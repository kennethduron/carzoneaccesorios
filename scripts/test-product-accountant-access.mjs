import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const permissions = read("src/lib/auth/permissions.ts");
const permissionTypes = read("src/types/auth.ts");
const productAccess = read("src/lib/auth/product-access.ts");
const page = read("src/app/admin/productos/page.tsx");
const adminPage = read("src/app/admin/page.tsx");
const actions = read("src/app/admin/productos/actions.ts");
const manager = read("src/components/admin/product-manager.tsx");
const migration = read("supabase/migrations/202607150001_granular_product_permissions.sql");
const imageRules = read("src/utils/product-image-rules.ts");

const allowed = [
  "products:read",
  "products:create",
  "products:update",
  "products:import",
  "products:images_manage",
  "products:export",
];
const forbidden = [
  "products:delete",
  "products:adjust_stock",
  "products:manage",
  "inventory:manage",
  "technical:tools",
];

const contadoraBlock = permissions.match(/contadora:\s*\[(.*?)\n\s*\],/s)?.[1] ?? "";
for (const permission of allowed) {
  assert.match(contadoraBlock, new RegExp(`"${permission.replace(":", "\\:")}"`), `contadora missing ${permission}`);
  assert.match(permissionTypes, new RegExp(`\\| "${permission.replace(":", "\\:")}"`), `Permission union missing ${permission}`);
}
for (const permission of forbidden) {
  assert.doesNotMatch(contadoraBlock, new RegExp(`"${permission.replace(":", "\\:")}"`), `contadora unexpectedly has ${permission}`);
}
assert.match(contadoraBlock, /"inventory:read"/, "contadora must receive read-only inventory access");

assert.match(productAccess, /const hasLegacyManage = hasPermission\(profile, "products:manage"\)/);
assert.match(productAccess, /hasPermission\(profile, "inventory:manage"\)/);
assert.doesNotMatch(productAccess, /inventory:read/, "inventory read must never enable product stock adjustment");
assert.match(page, /requireProductCapability\("read"\)/);
assert.match(page, /capabilities=\{capabilities\}/);
assert.match(adminPage, /permissions: \["products:read", "products:manage"\]/);

assert.match(actions, /requireProductCapability\("manageImages"\)/);
assert.match(actions, /requireProductCapability\(input\.id \? "update" : "create"\)/);
assert.match(actions, /requireProductCapability\("deleteProducts"\)/);
assert.match(actions, /requireProductCapability\("importProducts"\)/);
assert.match(actions, /save_product_catalog_locked/);
assert.match(actions, /capabilities\.adjustStock \? await setProductStockLocked/);
assert.match(actions, /product_save_compensation/);
assert.match(actions, /cloudinary_reference_check_failed/);
assert.doesNotMatch(actions, /requirePermission\("products:manage"\)/);

assert.match(manager, /capabilities\.create/);
assert.match(manager, /capabilities\.update/);
assert.match(manager, /capabilities\.deleteProducts/);
assert.match(manager, /capabilities\.importProducts/);
assert.match(manager, /capabilities\.manageImages/);
assert.match(manager, /capabilities\.adjustStock/);
assert.match(manager, /Stock ignorado:/);
assert.match(manager, /Importando productos\.\.\./);
assert.match(manager, /spreadsheetSafeValue/);
assert.doesNotMatch(manager, /contadora/i, "UI must render capabilities, not role names");

const roleUpdate = migration.match(/update public\.roles(.*?)where name = 'contadora';/s)?.[0] ?? "";
for (const permission of allowed) assert.match(roleUpdate, new RegExp(permission.replace(":", "\\:")));
for (const permission of forbidden) assert.doesNotMatch(roleUpdate, new RegExp(permission.replace(":", "\\:")));

const saveRpc = migration.match(/create or replace function public\.save_product_catalog_locked(.*?)revoke all on function public\.save_product_catalog_locked/s)?.[1] ?? "";
assert.ok(saveRpc, "save_product_catalog_locked definition missing");
assert.doesNotMatch(saveRpc, /product_data->>'stock'/);
assert.doesNotMatch(saveRpc, /product_data->>'reserved_stock'/);
assert.match(saveRpc, /if image_count > 5/);
assert.match(saveRpc, /for update;/);
assert.match(migration, /public\.has_permission\('products:adjust_stock'\)/);
assert.match(migration, /public\.has_permission\('inventory:manage'\)/);
assert.match(migration, /create policy "Product deleters can delete products"/);
assert.match(migration, /create policy "Product image managers can insert product images"/);

const authenticatedInsertGrant = migration.match(/grant insert \((.*?)\) on public\.products to authenticated;/s)?.[1] ?? "";
const authenticatedUpdateGrant = migration.match(/grant update \((.*?)\) on public\.products to authenticated;/s)?.[1] ?? "";
for (const grant of [authenticatedInsertGrant, authenticatedUpdateGrant]) {
  assert.ok(grant, "authenticated product column grant missing");
  assert.doesNotMatch(grant, /(^|\W)stock(\W|$)/);
  assert.doesNotMatch(grant, /reserved_stock|available_stock/);
}

assert.match(imageRules, /image\/jpeg/);
assert.match(imageRules, /image\/png/);
assert.match(imageRules, /image\/webp/);
assert.doesNotMatch(imageRules, /image\/svg\+xml/);

console.log("PRODUCT_ACCOUNTANT_ACCESS_STRUCTURE_PASS");
