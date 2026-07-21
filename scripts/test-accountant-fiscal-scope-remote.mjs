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

const { data: accountantRole, error: roleError } = await supabase
  .from("roles")
  .select("permissions")
  .eq("name", "contadora")
  .single();
assert.ifError(roleError);

const expectedPermissions = [
  "admin:access",
  "customers:link_portal_account",
  "products:read",
  "products:create",
  "products:update",
  "products:import",
  "products:images_manage",
  "products:export",
  "products:adjust_stock",
  "inventory:read",
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
  "accounting:edit_draft_entries",
  "accounting:post",
  "accounting:manage",
  "accounting:reverse",
  "accounting:settings",
  "accounting:close_period",
  "accounting:reopen_period",
  "accounting:view_reports",
  "accounting:export",
];
assert.deepEqual([...accountantRole.permissions].sort(), [...expectedPermissions].sort(), "remote contadora permissions must match the approved fiscal/accounting/import scope");

for (const forbidden of [
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
]) {
  assert.equal(accountantRole.permissions.includes(forbidden), false, `remote contadora must not have ${forbidden}`);
}

const allowedFiscalNotifications = [
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
];

const { data: prefsWithAccountant, error: operationalError } = await supabase
  .from("notification_preferences")
  .select("notification_type, destination_roles")
  .contains("destination_roles", ["contadora"]);
assert.ifError(operationalError);
const operationalPrefs = prefsWithAccountant.filter((preference) => !allowedFiscalNotifications.includes(preference.notification_type));
assert.equal(operationalPrefs.length, 0, "remote contadora must not remain in operational notification preferences");

const { data: fiscalPrefs, error: fiscalError } = await supabase
  .from("notification_preferences")
  .select("notification_type, email_enabled, destination_roles")
  .in("notification_type", allowedFiscalNotifications);
assert.ifError(fiscalError);
assert.ok(fiscalPrefs.length > 0, "remote fiscal notification preferences must be queryable");
for (const preference of fiscalPrefs) {
  assert.equal(preference.destination_roles.includes("contadora"), true, `${preference.notification_type} must include contadora`);
}

console.log("Remote accountant fiscal scope checks passed.");
