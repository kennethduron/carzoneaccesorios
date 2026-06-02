import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../supabase/migrations/202606020001_smart_notifications_user_push_resend.sql", import.meta.url), "utf8");
const checkoutView = await readFile(new URL("../src/components/store/checkout-view.tsx", import.meta.url), "utf8");
const checkoutActions = await readFile(new URL("../src/app/checkout/actions.ts", import.meta.url), "utf8");
const orderEmail = await readFile(new URL("../src/lib/notifications/order-email.ts", import.meta.url), "utf8");
const provider = await readFile(new URL("../src/lib/email/email-provider.ts", import.meta.url), "utf8");
const fcm = await readFile(new URL("../src/lib/notifications/fcm.ts", import.meta.url), "utf8");
const cron = await readFile(new URL("../src/lib/cron.ts", import.meta.url), "utf8");
const cronJobs = await readFile(new URL("../src/lib/notifications/cron-jobs.ts", import.meta.url), "utf8");
const preferences = await readFile(new URL("../src/components/admin/notification-preferences-form.tsx", import.meta.url), "utf8");
const adminOrderActions = await readFile(new URL("../src/app/admin/pedidos/actions.ts", import.meta.url), "utf8");

assert.match(migration, /email_updates_opt_in boolean not null default false/);
assert.match(migration, /notification_user_preferences/);
assert.match(migration, /fcm_device_tokens/);
assert.match(migration, /delivered.+approved/s);
assert.match(migration, /customer\.order_cancelled/);

assert.match(checkoutView, /receiveOrderEmailUpdates/);
assert.match(checkoutView, /Siempre enviaremos el correo inicial/);
assert.match(checkoutActions, /email_updates_opt_in: Boolean\(input\.checkout\.receiveOrderEmailUpdates\)/);

assert.match(orderEmail, /buildCustomerOrderReceivedHtml/);
assert.match(orderEmail, /customer-order-received/);
assert.match(orderEmail, /customer_updates_disabled/);
assert.match(orderEmail, /customer-order-change/);
assert.match(adminOrderActions, /notifyCustomerOfOrderChange/);

assert.match(provider, /EMAIL_PROVIDER=resend/);
assert.match(provider, /EMAIL_ENABLED/);
assert.match(provider, /RESEND_REPLY_TO/);
assert.match(provider, /RESEND_FROM_NAME/);

assert.match(fcm, /FCM_PROJECT_ID/);
assert.match(fcm, /FCM_CLIENT_EMAIL/);
assert.match(fcm, /FCM_PRIVATE_KEY/);
assert.match(fcm, /registerFcmDeviceToken/);
assert.match(fcm, /sendFcmNotification/);

assert.match(preferences, /Mis preferencias/);
assert.match(preferences, /Reglas por rol/);
assert.match(preferences, /saveUserNotificationPreferenceAction/);
assert.match(cron, /authorization/);
assert.match(cron, /operational_cron_runs/);
assert.match(cronJobs, /notification_user_preferences/);
assert.match(cronJobs, /inventory\.critical_low_stock/);
assert.match(cronJobs, /idempotencyScope/);

console.log("Smart notifications structural checks passed.");
