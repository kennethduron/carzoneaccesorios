import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { notificationCatalog } from "../src/lib/notifications/catalog.ts";
import { rolePermissions } from "../src/lib/auth/permissions.ts";
import { canRoleReceiveNotificationType, filterPreferencesForRole } from "../src/lib/notifications/accountant-scope.ts";

const accountantForbiddenRoutes = {
  "src/app/admin/crm/page.tsx": "crm:manage",
  "src/app/admin/clientes/page.tsx": "crm:manage",
  "src/app/admin/clientes-mayoristas/page.tsx": "wholesale:manage",
  "src/app/admin/seguridad/page.tsx": "security:read",
  "src/app/admin/uso/page.tsx": "technical:tools",
  "src/app/admin/banners/page.tsx": "commercial_settings:manage",
  "src/app/admin/revision-bac/page.tsx": "commercial_settings:manage",
};

for (const [path, permission] of Object.entries(accountantForbiddenRoutes)) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  assert.match(source, new RegExp(`require(?:Strict)?Permission\\("${permission}"\\)`), `${path} must require ${permission}`);
}
const productsPage = await readFile(new URL("../src/app/admin/productos/page.tsx", import.meta.url), "utf8");
assert.match(productsPage, /requireProductCapability\("read"\)/);
assert.match(productsPage, /capabilities=\{capabilities\}/);

const inventoryPage = await readFile(new URL("../src/app/admin/inventario/page.tsx", import.meta.url), "utf8");
assert.match(inventoryPage, /requirePermission\("admin:access"\)/);
assert.match(inventoryPage, /"inventory:read"/);
assert.match(inventoryPage, /"inventory:manage"/);
assert.match(inventoryPage, /if \(!canReadInventory\) \{[\s\S]*redirect\("\/sin-permiso"\)/);
assert.match(inventoryPage, /canManageInventory=\{canManageInventory\}/);

const ordersPage = await readFile(new URL("../src/app/admin/pedidos/page.tsx", import.meta.url), "utf8");
assert.match(ordersPage, /requirePermission\("admin:access"\)/);
assert.match(ordersPage, /hasEffectivePermission\(profile\.role, profile\.permissions, "orders:read"/);
assert.match(ordersPage, /hasEffectivePermission\(profile\.role, profile\.permissions, "orders:manage_logistics"/);
assert.match(ordersPage, /if \(!canReadOrders\) \{[\s\S]*redirect\("\/sin-permiso"\)/);

assert.equal(rolePermissions.contadora.includes("admin:access"), true);
assert.equal(rolePermissions.contadora.includes("inventory:read"), true);
assert.equal(rolePermissions.contadora.includes("products:adjust_stock"), true);
assert.equal(rolePermissions.contadora.includes("orders:read"), true);
assert.equal(rolePermissions.contadora.includes("invoices:create"), true);
for (const permission of [
  "inventory:manage",
  "products:manage",
  "products:delete",
  "orders:manage_logistics",
  "payments:confirm",
  "payments:reject",
  "invoices:manage",
  "crm:manage",
  "wholesale:manage",
  "security:read",
  "technical:tools",
]) {
  assert.equal(rolePermissions.contadora.includes(permission), false, `contadora must not have ${permission}`);
}

assert.deepEqual(new Set(rolePermissions.bodega), new Set([
  "admin:access",
  "products:read",
  "inventory:read",
  "inventory:manage",
  "shipments:manage",
  "orders:read",
  "orders:manage_logistics",
  "reservations:review",
  "notifications:read",
]));

for (const permission of [
  "payments:confirm",
  "payments:reject",
  "payments:manage",
  "invoices:read",
  "invoices:create",
  "invoices:correct",
  "invoices:manage",
  "reports:fiscal_read",
  "reports:fiscal_export",
  "crm:manage",
  "customers:manage",
  "wholesale:manage",
  "security:read",
  "system:monitoring",
  "system:backups",
  "technical:tools",
]) {
  assert.equal(rolePermissions.bodega.includes(permission), false, `bodega must not have ${permission}`);
}

const pedidosActions = await readFile(new URL("../src/app/admin/pedidos/actions.ts", import.meta.url), "utf8");
assert.match(pedidosActions, /requirePermission\(status === "approved" \? "payments:confirm" : "payments:reject"\)/);
assert.match(pedidosActions, /requirePermission\("invoices:create"\)/);
const fiscalCorrectionAction = pedidosActions.slice(
  pedidosActions.indexOf("export async function correctOrderFiscalCustomerDataAction"),
  pedidosActions.indexOf("export async function", pedidosActions.indexOf("export async function correctOrderFiscalCustomerDataAction") + 1),
);
assert.match(fiscalCorrectionAction, /requirePermission\("admin:access"\)/);
assert.match(fiscalCorrectionAction, /\["technical_owner", "business_owner", "admin"\]\.includes\(profile\.role\)/);
assert.match(fiscalCorrectionAction, /hasEffectivePermission\(profile\.role, profile\.permissions, "invoices:correct", profile\.email\)/);
assert.match(pedidosActions, /orders:manage_logistics/);
assert.match(pedidosActions, /normalizedStatus === "cancelado" && !canManageOrders && !canCancelOrders/);

const invoiceActions = await readFile(new URL("../src/app/admin/facturas/actions.ts", import.meta.url), "utf8");
assert.match(invoiceActions, /requirePermission\("invoices:manage"\)/);
assert.match(invoiceActions, /requirePermission\("invoices:correct"\)/);
assert.match(invoiceActions, /requirePermission\("invoices:create"\)/);

const guide = await readFile(new URL("../src/app/admin/guia/page.tsx", import.meta.url), "utf8");
const help = await readFile(new URL("../src/app/admin/ayuda/page.tsx", import.meta.url), "utf8");
assert.match(guide, /visibleSections = guideSections\.filter\(\(section\) => isVisibleToRole\(profile, section\.roles, section\.permissions\)\)/);
assert.match(help, /visibleBlocks = helpBlocks\.filter\(\(block\) => isBlockVisible\(profile, block\)\)/);
assert.match(help, /visibleTips = dailyTips\.filter\(\(tip\) => hasAnyPermission\(profile, tip\.permissions\)\)/);
assert.doesNotMatch(guide, /Contadora[\s\S]{0,500}Confirma o rechaza pagos/);
assert.doesNotMatch(help, /Contadora[\s\S]{0,500}Confirmar pagos/);

const warehouseAllowedNotifications = new Set([
  "reservation.expired_review_required",
  "reservation.expiring_soon",
  "reservation.extended",
  "reservation.released",
  "order.ready_to_prepare",
  "order.logistics_review",
  "inventory.low_stock",
  "inventory.out_of_stock",
  "inventory.critical_low_stock",
]);

for (const item of notificationCatalog) {
  if (item.defaultRoles.includes("bodega")) {
    assert.equal(warehouseAllowedNotifications.has(item.type), true, `bodega must not receive ${item.type}`);
  }
}

for (const forbiddenNotificationType of [
  "payment.pending",
  "payment.transfer_review",
  "payment.confirmed",
  "invoice.created",
  "crm.followup_overdue",
  "wholesale.request_new",
  "system.cron_failed",
]) {
  assert.equal(canRoleReceiveNotificationType("bodega", forbiddenNotificationType), false, `bodega must not receive ${forbiddenNotificationType}`);
}

const visibleWarehousePreferences = filterPreferencesForRole(
  [
    { notification_type: "inventory.low_stock" },
    { notification_type: "order.ready_to_prepare" },
    { notification_type: "payment.confirmed" },
    { notification_type: "invoice.created" },
    { notification_type: "crm.followup_overdue" },
  ],
  "bodega",
).map((preference) => preference.notification_type);
assert.deepEqual(visibleWarehousePreferences, ["inventory.low_stock", "order.ready_to_prepare"]);

const cronJobs = await readFile(new URL("../src/lib/notifications/cron-jobs.ts", import.meta.url), "utf8");
assert.match(cronJobs, /roleName === "bodega" && preference\?\.email_enabled !== true/);

console.log("Admin access and warehouse scope checks passed.");
