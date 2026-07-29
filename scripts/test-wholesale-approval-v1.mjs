import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const migration = read("supabase/migrations/202607280010_wholesale_approval_direct_grant_and_notifications.sql");
const actions = read("src/app/admin/crm/actions.ts");
const profile = read("src/components/admin/customer-profile-wholesale.tsx");
const dialog = read("src/components/admin/wholesale-grant-dialog.tsx");
const notificationService = read("src/services/supabase/customer-portal-notifications.service.ts");
const notificationUi = read("src/components/store/customer-wholesale-notification-toast.tsx");

for (const required of [
  "grant_customer_wholesale_access_v1",
  "transition_customer_wholesale_access_v1",
  "wholesale_access_history",
  "wholesale_idempotency_requests",
  "customer_portal_notifications",
  "WHOLESALE_VERSION_CONFLICT",
  "WHOLESALE_IDEMPOTENCY_CONFLICT",
  "for update",
]) {
  assert.ok(migration.includes(required), `Falta el control SQL: ${required}`);
}

assert.match(migration, /p_source\s+text/);
assert.match(migration, /p_source not in \('customer_request', 'admin_direct_grant'\)/);
assert.match(migration, /alter column wholesale_request_source drop not null/);
assert.match(migration, /'request_source_preserved', saved_customer\.wholesale_request_source/);
assert.match(migration, /p_wholesale_customer_type = 'new', minimum_amount/);
assert.match(migration, /insert into public\.customer_portal_notifications/);
assert.match(migration, /c\.user_id = auth\.uid\(\)/);
assert.doesNotMatch(migration, /insert into public\.orders|insert into public\.order_items|insert into public\.inventory_movements|insert into public\.journal_entries/i);

assert.match(actions, /\.rpc\("grant_customer_wholesale_access_v1"/);
assert.match(actions, /\.rpc\("transition_customer_wholesale_access_v1"/);
assert.match(actions, /expectedCommercialVersion/);
assert.match(actions, /requestKey/);

assert.match(profile, /Otorgar como mayorista nuevo/);
assert.match(profile, /Otorgar como mayorista existente/);
assert.match(profile, /cuenta del portal todavía no vinculada/);
assert.match(dialog, /size-11/);
assert.match(dialog, /aria-modal="true"/);
assert.match(notificationService, /customer_portal_notifications/);
assert.match(notificationUi, /claimCustomerWholesaleToastAction/);

console.log("Wholesale approval v1 structural checks: PASS");
