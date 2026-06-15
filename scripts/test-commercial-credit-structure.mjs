import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [
  enumMigration,
  creditMigration,
  invoiceMigration,
  permissionAuditMigration,
  finalMigration,
  permissions,
  checkoutAction,
  checkoutView,
  crmAction,
  crmManager,
  accountPage,
  accountActions,
  notificationToast,
  receivablesPage,
  receivablesManager,
  orderActions,
  ordersManager,
  orderWorkflow,
  emailQueue,
  cronJobs,
  vercelConfig,
] = await Promise.all([
  read("supabase/migrations/202606130001_commercial_credit_payment_method.sql"),
  read("supabase/migrations/202606130002_commercial_credit_accounts_receivable.sql"),
  read("supabase/migrations/202606130003_commercial_credit_invoice_independence.sql"),
  read("supabase/migrations/202606130004_commercial_credit_permission_audit.sql"),
  read("supabase/migrations/202606140001_commercial_credit_final_adjustments.sql"),
  read("src/lib/auth/permissions.ts"),
  read("src/app/checkout/actions.ts"),
  read("src/components/store/checkout-view.tsx"),
  read("src/app/admin/crm/actions.ts"),
  read("src/components/admin/crm-manager.tsx"),
  read("src/app/cuenta/page.tsx"),
  read("src/app/cuenta/actions.ts"),
  read("src/components/store/customer-credit-notification-toast.tsx"),
  read("src/app/admin/cuentas-por-cobrar/page.tsx"),
  read("src/components/admin/accounts-receivable-manager.tsx"),
  read("src/app/admin/pedidos/actions.ts"),
  read("src/components/admin/admin-orders-manager.tsx"),
  read("src/utils/order-workflow.ts"),
  read("src/lib/notifications/email-queue.ts"),
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

for (const role of ["technical_owner", "business_owner", "admin"]) {
  assert.match(permissions, new RegExp(`${role}:[\\s\\S]*?"credit:manage"[\\s\\S]*?"credit:mark_paid"`));
}
assert.match(permissions, /contadora:[\s\S]*?"credit:read"[\s\S]*?"receivables:read"[\s\S]*?"receivables:export"/);
for (const role of ["vendedor", "bodega", "soporte", "cliente"]) {
  const roleBlock = permissions.match(new RegExp(`${role}: \\[[\\s\\S]*?\\],`))?.[0] ?? "";
  assert.doesNotMatch(roleBlock, /credit:manage|credit:mark_paid|receivables:read/);
}

assert.match(checkoutView, /methods\.push\(\["Crédito Comercial"/);
assert.match(checkoutView, /blocksCommercialCreditLimit/);
assert.match(checkoutAction, /paymentMethod === "commercial_credit" && !user/);
assert.match(creditMigration, /open_credit_balance \+ recalculated_total > credit_account\.credit_limit/);
assert.match(creditMigration, /raise exception 'Este pedido supera/);
assert.match(orderWorkflow, /order\.payment_method === "commercial_credit"/);

assert.match(finalMigration, /add column if not exists payment_received_method/);
assert.match(finalMigration, /accounts_receivable_paid_payment_method_required/);
assert.match(finalMigration, /payment_received_method in \('bank_transfer', 'card', 'cash'\)/);
assert.match(finalMigration, /mark_credit_receivable_paid_authorized\(\s*target_receivable_id uuid,\s*received_payment_method text,/);
assert.match(finalMigration, /commercial_credit\.payment_method_recorded/);
assert.match(finalMigration, /commercial_credit\.paid_edit_denied/);
assert.match(finalMigration, /commercial_credit\.payment_method_required/);
assert.match(finalMigration, /set status = 'paid',[\s\S]*?balance_due = 0,[\s\S]*?paid_at = now\(\)/);
assert.match(orderActions, /markCreditReceivablePaidAction\(input: \{/);
assert.match(orderActions, /paymentMethod: CreditPaymentReceivedMethod/);
assert.match(orderActions, /received_payment_method: paymentMethod/);
assert.match(receivablesManager, /Método con el que pagó el cliente/);
assert.match(receivablesManager, /payment_received_reference/);
assert.match(ordersManager, /Método con el que pagó el cliente/);
assert.match(ordersManager, /creditPaymentIsPaid/);
assert.doesNotMatch(orderActions, /markCreditReceivablePaidAction\(receivableId: string\)/);

assert.match(crmAction, /saveCustomerCommercialCreditAction/);
assert.match(crmAction, /\["technical_owner", "business_owner", "admin"\]\.includes\(viewer\.role\)/);
assert.match(crmAction, /profile\.creditAccount = null;[\s\S]*?profile\.receivables = \[\]/);
assert.match(crmManager, /tab\.id !== "credito" \|\| canManageCredit/);
const creditComponent = crmManager.slice(crmManager.indexOf("function CustomerProfileCredit"));
assert.doesNotMatch(creditComponent, /Notas internas/);
assert.doesNotMatch(creditComponent, /textarea/);

assert.match(receivablesPage, /receivables:read/);
assert.match(receivablesPage, /\["technical_owner", "business_owner", "admin"\]\.includes\(profile\.role\)/);
assert.match(receivablesManager, /Pago completo únicamente/);
assert.match(receivablesManager, /canMarkPaid && row\.status !== "paid"/);
assert.match(accountPage, /\{creditAccount \? \(/);
assert.match(accountPage, /CustomerCreditNotificationToast/);
assert.match(accountActions, /eq\("user_id", profile\.id\)/);
assert.match(notificationToast, /Crédito comercial habilitado\. Ahora puedes realizar compras a crédito según las condiciones asignadas\./);

assert.match(finalMigration, /commercial_credit\.enabled/);
assert.match(finalMigration, /Tu crédito comercial ha sido habilitado/);
assert.match(finalMigration, /credit\.enabled:' \|\| target_customer_id::text/);
assert.match(finalMigration, /on conflict \(idempotency_key\) where idempotency_key is not null do nothing/);
assert.match(finalMigration, /commercial_credit\.enabled_email_queued/);
assert.match(finalMigration, /commercial_credit\.visual_notification_created/);
assert.match(emailQueue, /Límite autorizado/);
assert.match(emailQueue, /Plazo de pago/);

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
assert.match(finalMigration, /status in \('pending', 'retrying'\)/);
assert.match(cronJobs, /checkCommercialCreditRemindersJob/);
assert.match(vercelConfig, /\/api\/cron\/check-commercial-credit/);
assert.match(invoiceMigration, /order_record\.payment_method <> 'commercial_credit'/);

console.log("Commercial credit final structure checks passed.", {
  checkoutFourthOptionKept: true,
  partialPayments: false,
  realPaymentMethodRequired: true,
  enabledEmailIdempotent: true,
  customerToast: true,
  notesFieldHidden: true,
});
