import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const contactActions = await readFile(new URL("../src/app/contacto/actions.ts", import.meta.url), "utf8");
const registeredWholesaleActions = await readFile(new URL("../src/app/actions/wholesale.ts", import.meta.url), "utf8");
const notifications = await readFile(new URL("../src/lib/public-form-support.ts", import.meta.url), "utf8");
const migration = await readFile(
  new URL("../supabase/migrations/202605310003_public_contact_workflow_hardening.sql", import.meta.url),
  "utf8",
);
const settingsTypes = await readFile(new URL("../src/types/settings.ts", import.meta.url), "utf8");

assert.match(contactActions, /rpc\("submit_public_general_contact"/);
assert.match(contactActions, /rpc\("submit_public_wholesale_request"/);
assert.doesNotMatch(contactActions, /currentStatus === "approved"/);
assert.doesNotMatch(contactActions, /currentStatus === "suspended"/);
assert.match(contactActions, /Mensaje enviado correctamente\. Nuestro equipo te respondera pronto\./);
assert.match(contactActions, /Tu cuenta mayorista ya esta aprobada\./);
assert.match(contactActions, /Tu acceso mayorista esta suspendido\./);
assert.match(contactActions, /Recibimos tu mensaje\. Nuestro equipo revisara tu caso\./);

assert.match(migration, /notify_general_contact boolean not null default true/);
assert.match(migration, /create or replace function public\.submit_public_general_contact/);
assert.match(migration, /create or replace function public\.submit_public_wholesale_request/);
assert.match(migration, /now\(\) \+ interval '24 hours'/);
assert.match(migration, /assigned_user_id/);
assert.match(migration, /public_form\.contact_general\.submitted/);
assert.match(migration, /public_form\.wholesale\.duplicate_pending/);
assert.match(migration, /public_form\.wholesale\.overwrite_blocked/);
assert.match(migration, /current_wholesale_status in \('approved', 'suspended'\)/);
assert.match(migration, /next_outcome := 'rejected_review'/);

assert.match(registeredWholesaleActions, /route: "\/contacto\/mayoreo\/cuenta"/);
assert.match(registeredWholesaleActions, /ensureRegisteredWholesaleFollowup/);
assert.match(registeredWholesaleActions, /rejectedReview: true/);
assert.match(registeredWholesaleActions, /writeRegisteredWholesaleAudit/);

assert.match(notifications, /sendTransactionalEmail/);
assert.match(notifications, /notification_logs/);
assert.match(notifications, /writeErrorLog/);
assert.match(notifications, /car\.zone\.accesorioshn@gmail\.com/);
assert.match(notifications, /notify_general_contact/);
assert.match(notifications, /notify_wholesale_requests/);
assert.match(settingsTypes, /notify_general_contact: boolean/);

console.log("Public contact workflow structural checks passed.");

