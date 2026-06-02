import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { notificationCatalog } from "../src/lib/notifications/catalog.ts";
import { rolePermissions } from "../src/lib/auth/permissions.ts";

const allowedPermissions = new Set([
  "admin:access",
  "notifications:read",
  "invoices:read",
  "invoices:export",
  "fiscal:read",
  "fiscal:reports",
  "tax:read",
  "tax:export",
  "reports:fiscal_read",
  "reports:fiscal_export",
]);

const forbiddenPermissions = [
  "orders:read",
  "orders:manage",
  "orders:manage_logistics",
  "customers:read",
  "customers:manage",
  "payments:read",
  "payments:manage",
  "payments:confirm",
  "payments:reject",
  "reservations:review",
  "crm:manage",
  "wholesale:manage",
  "inventory:manage",
  "products:manage",
  "security:read",
  "security:manage",
  "users:manage",
  "roles:assign",
  "system:monitoring",
  "system:backups",
  "technical:tools",
  "settings:fiscal",
  "reports:read",
  "reports:export",
  "invoices:create",
  "invoices:correct",
  "invoices:manage",
];

assert.deepEqual(new Set(rolePermissions.contadora), allowedPermissions, "contadora must be fiscal-only");
for (const permission of forbiddenPermissions) {
  assert.equal(rolePermissions.contadora.includes(permission), false, `contadora must not have ${permission}`);
}

const allowedNotifications = new Set([
  "invoice.created",
  "invoice.cancelled",
  "fiscal.cai_expiring",
  "fiscal.cai_expired",
  "fiscal.range_low",
  "fiscal.invoice_error",
  "fiscal.correlative_invalid",
  "fiscal.report_ready",
]);

for (const item of notificationCatalog) {
  if (item.defaultRoles.includes("contadora")) {
    assert.equal(allowedNotifications.has(item.type), true, `contadora must not receive ${item.type}`);
  }
}

const migration = await readFile(new URL("../supabase/migrations/202606020002_accountant_fiscal_scope.sql", import.meta.url), "utf8");
assert.match(migration, /where name = 'contadora'/);
assert.match(migration, /array_remove\(destination_roles, 'contadora'\)/);
assert.match(migration, /'invoice\.created'/);
assert.match(migration, /'fiscal\.cai_expiring'/);
assert.match(migration, /'payment\.transfer_review'/);

const adminPage = await readFile(new URL("../src/app/admin/page.tsx", import.meta.url), "utf8");
assert.match(adminPage, /const isAccountant = profile\.role === "contadora"/);
assert.match(adminPage, /<AdminShell title="Panel contable">/);
assert.match(adminPage, /if \(isAccountant\) \{[\s\S]*Resumen contable/);

const reportsPage = await readFile(new URL("../src/app/admin/reportes/page.tsx", import.meta.url), "utf8");
assert.match(reportsPage, /reports:fiscal_read/);
assert.match(reportsPage, /getAdminFiscalReports\(filters\)/);

const invoicesPage = await readFile(new URL("../src/app/admin/facturas/page.tsx", import.meta.url), "utf8");
assert.match(invoicesPage, /const canCorrectInvoices = profile\.permissions\.includes\("invoices:correct"\)/);
assert.doesNotMatch(invoicesPage, /\["technical_owner", "admin", "business_owner", "contadora"\]/);

console.log("Accountant fiscal scope checks passed.");
