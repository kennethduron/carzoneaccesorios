import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { notificationCatalog } from "../src/lib/notifications/catalog.ts";
import { rolePermissions } from "../src/lib/auth/permissions.ts";

const allowedPermissions = new Set([
  "admin:access",
  "customers:link_portal_account",
  "products:read",
  "products:create",
  "products:update",
  "products:import",
  "products:images_manage",
  "products:export",
  "notifications:read",
  "invoices:read",
  "invoices:export",
  "fiscal:read",
  "fiscal:reports",
  "settings:fiscal",
  "tax:read",
  "tax:export",
  "reports:fiscal_read",
  "reports:fiscal_export",
  "credit:read",
  "credit:mark_paid",
  "receivables:read",
  "receivables:export",
  "receivables:import",
  "receivables:apply",
  "receivables:assign",
  "receivables:review",
  "suppliers:read",
  "suppliers:manage",
  "purchases:read",
  "purchases:manage",
  "payables:read",
  "payables:manage",
  "payables:import",
  "payables:apply",
  "payables:assign",
  "payables:review",
  "accounting:read",
  "accounting:create",
  "accounting:post",
  "accounting:manage",
  "accounting:close_period",
  "accounting:view_reports",
  "accounting:export",
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
  "users:read",
  "users:create",
  "roles:assign",
  "roles:assign_admin",
  "roles:assign_operational",
  "system:monitoring",
  "system:backups",
  "technical:tools",
  "settings:manage",
  "commercial_settings:manage",
  "reports:read",
  "reports:export",
  "invoices:create",
  "invoices:correct",
  "invoices:manage",
  "receivables:rollback",
  "payables:rollback",
  "accounting:settings",
  "accounting:reverse",
  "accounting:reopen_period",
];

assert.deepEqual(new Set(rolePermissions.contadora), allowedPermissions, "contadora must match the approved fiscal/accounting/import/product scope");
for (const permission of forbiddenPermissions) {
  assert.equal(rolePermissions.contadora.includes(permission), false, `contadora must not have ${permission}`);
}

const allowedNotifications = new Set([
  "credit.due_7_days",
  "credit.due_3_days",
  "credit.due_1_day",
  "credit.due_today",
  "credit.overdue",
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
