import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [
  enumMigration,
  creditMigration,
  invoiceMigration,
  permissionAuditMigration,
  permissions,
  checkoutAction,
  checkoutView,
  crmAction,
  crmManager,
  accountPage,
  receivablesPage,
  receivablesManager,
  orderActions,
  orderWorkflow,
  cronJobs,
  vercelConfig,
] = await Promise.all([
  read("supabase/migrations/202606130001_commercial_credit_payment_method.sql"),
  read("supabase/migrations/202606130002_commercial_credit_accounts_receivable.sql"),
  read("supabase/migrations/202606130003_commercial_credit_invoice_independence.sql"),
  read("supabase/migrations/202606130004_commercial_credit_permission_audit.sql"),
  read("src/lib/auth/permissions.ts"),
  read("src/app/checkout/actions.ts"),
  read("src/components/store/checkout-view.tsx"),
  read("src/app/admin/crm/actions.ts"),
  read("src/components/admin/crm-manager.tsx"),
  read("src/app/cuenta/page.tsx"),
  read("src/app/admin/cuentas-por-cobrar/page.tsx"),
  read("src/components/admin/accounts-receivable-manager.tsx"),
  read("src/app/admin/pedidos/actions.ts"),
  read("src/utils/order-workflow.ts"),
  read("src/lib/notifications/cron-jobs.ts"),
  read("vercel.json"),
]);

assert.match(enumMigration, /add value if not exists 'commercial_credit'/);
assert.match(creditMigration, /create table if not exists public\.customer_credit_accounts/);
assert.match(creditMigration, /create table if not exists public\.accounts_receivable/);
assert.match(creditMigration, /accounts_receivable_no_partial_payments/);
assert.match(creditMigration, /status in \('open', 'overdue'\) and balance_due = original_amount/);
assert.match(creditMigration, /status = 'paid' and balance_due = 0/);
assert.match(permissionAuditMigration, /commercial_credit\.permission_denied/);
assert.match(permissionAuditMigration, /return false/);
assert.match(permissionAuditMigration, /return query/);

for (const role of ["technical_owner", "business_owner", "admin"]) {
  assert.match(permissions, new RegExp(`${role}:[\\s\\S]*?"credit:manage"[\\s\\S]*?"credit:mark_paid"`));
}
assert.match(permissions, /contadora:[\s\S]*?"credit:read"[\s\S]*?"receivables:read"[\s\S]*?"receivables:export"/);
for (const role of ["vendedor", "bodega", "soporte", "cliente"]) {
  const roleBlock = permissions.match(new RegExp(`${role}: \\[[\\s\\S]*?\\],`))?.[0] ?? "";
  assert.doesNotMatch(roleBlock, /credit:manage|credit:mark_paid|receivables:read/);
}

assert.match(checkoutView, /if \(accountInfo\.credit\)[\s\S]*?methods\.push\(\["Crédito Comercial"/);
assert.match(checkoutView, /blocksCommercialCreditLimit/);
assert.match(checkoutAction, /paymentMethod === "commercial_credit" && !user/);
assert.match(creditMigration, /open_credit_balance \+ recalculated_total > credit_account\.credit_limit/);
assert.match(creditMigration, /raise exception 'Este pedido supera/);

assert.match(creditMigration, /insert into public\.accounts_receivable/);
assert.match(creditMigration, /original_amount,[\s\S]*?balance_due,[\s\S]*?due_date/);
assert.match(creditMigration, /delete from public\.invoices[\s\S]*?status = 'draft'/);
assert.match(invoiceMigration, /order_record\.payment_method <> 'commercial_credit'/);
assert.match(invoiceMigration, /public\.fiscal_invoice_number_value/);
assert.match(invoiceMigration, /public\.increment_fiscal_invoice_number/);

assert.match(creditMigration, /apply_credit_inventory_on_delivery/);
assert.match(creditMigration, /new\.status::text in \('entregado', 'delivered'\)/);
assert.match(creditMigration, /if order_record\.payment_method = 'commercial_credit' then[\s\S]*?return new/);
assert.match(orderWorkflow, /order\.payment_method === "commercial_credit"/);

assert.match(creditMigration, /create or replace function public\.mark_credit_receivable_paid\(target_receivable_id uuid\)/);
assert.doesNotMatch(creditMigration, /mark_credit_receivable_paid\([^)]*(amount|monto)/i);
assert.match(creditMigration, /set status = 'paid',[\s\S]*?balance_due = 0,[\s\S]*?paid_at = now\(\)/);
assert.match(orderActions, /markCreditReceivablePaidAction\(receivableId: string\)/);
assert.doesNotMatch(orderActions, /markCreditReceivablePaidAction\([^)]*,/);

assert.match(crmAction, /saveCustomerCommercialCreditAction/);
assert.match(crmAction, /\["technical_owner", "business_owner", "admin"\]\.includes\(viewer\.role\)/);
assert.match(crmAction, /profile\.creditAccount = null;[\s\S]*?profile\.receivables = \[\]/);
assert.match(crmManager, /tab\.id !== "credito" \|\| canManageCredit/);

assert.match(receivablesPage, /receivables:read/);
assert.match(receivablesPage, /\["technical_owner", "business_owner", "admin"\]\.includes\(profile\.role\)/);
assert.match(receivablesManager, /Sin pagos parciales/);
assert.match(receivablesManager, /canMarkPaid && row\.status !== "paid"/);
assert.match(accountPage, /\{creditAccount \? \(/);

for (const template of [
  "commercial_credit.created",
  "commercial_credit.reminder_7_days",
  "commercial_credit.reminder_3_days",
  "commercial_credit.reminder_1_day",
  "commercial_credit.overdue",
]) {
  assert.match(creditMigration, new RegExp(template.replaceAll(".", "\\.")));
}
assert.match(creditMigration, /scheduled_at/);
assert.match(creditMigration, /idempotency_key/);
assert.match(creditMigration, /update public\.email_queue[\s\S]*?status = 'cancelled'/);
assert.match(cronJobs, /checkCommercialCreditRemindersJob/);
assert.match(vercelConfig, /\/api\/cron\/check-commercial-credit/);

console.log("Commercial credit structure checks passed.", {
  partialPayments: false,
  authorizedManagers: ["technical_owner", "business_owner", "admin"],
  accountantReadOnly: true,
  customerVisibilityConditional: true,
  scheduledEmails: 5,
});
