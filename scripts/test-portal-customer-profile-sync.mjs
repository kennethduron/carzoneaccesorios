import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const migration = read("supabase/migrations/202607280013_portal_customer_profile_sync.sql");
const authActions = read("src/app/auth/actions.ts");
const callback = read("src/app/auth/callback/route.ts");
const checkout = read("src/app/checkout/actions.ts");
const crmPage = read("src/app/admin/clientes/page.tsx");
const crmService = read("src/services/supabase/admin-crm.service.ts");
const crmManager = read("src/components/admin/crm-manager.tsx");
const dashboard = read("src/app/admin/page.tsx");
const recoveryRoute = read("src/app/api/admin/portal-customer-profile/route.ts");

for (const contract of [
  "ensure_portal_customer_profile_core_v1",
  "ensure_my_portal_customer_profile_v1",
  "ensure_portal_customer_profile_internal_v1",
  "ensure_admin_portal_customer_profile_v1",
  "preview_admin_portal_customer_profile_v1",
  "search_admin_crm_customer_ids_v1",
  "portal_customer_profile_syncs",
  "portal_customer_profile_sync_requests",
  "portal_customer_link_reviews",
  "pg_advisory_xact_lock",
  "IDEMPOTENCY_CONFLICT",
  "REVIEW_REQUIRED",
  "portal_customer_registered",
  "portal_customer_link_review_required",
]) {
  assert.ok(migration.includes(contract), `Missing portal customer contract: ${contract}`);
}

assert.match(migration, /profile_row\.role_name <> 'cliente'/);
assert.match(migration, /normalized_email is not null/);
assert.match(migration, /normalized_phone is not null/);
assert.match(migration, /normalized_tax_id is not null/);
assert.doesNotMatch(migration, /contact_name\s*=/i, "Names must not be used as linking authority");
assert.match(migration, /false,\s*'none',\s*'new'/);
assert.match(migration, /'portal_registration'/);
assert.doesNotMatch(
  migration,
  /\b(insert into|update|delete from)\s+public\.(orders|order_items|payments|invoices|inventory_movements|accounts_receivable|customer_credit_accounts|journal_entries)\b/i,
);

assert.match(authActions, /publicRegistrationSchema\.safeParse/);
assert.match(authActions, /ensurePortalCustomerProfileForUser\(data\.user\.id, "registration"\)/);
assert.match(authActions, /ensureMyPortalCustomerProfile\(supabase, data\.user\.id, "login"/);
assert.match(callback, /ensurePortalCustomerProfileForUser/);
assert.match(checkout, /"checkout_recovery"/);
assert.ok(
  checkout.indexOf('"checkout_recovery"') < checkout.indexOf('rpc("create_checkout_order_v3"'),
  "Checkout identity recovery must run before order creation",
);
assert.match(crmService, /search_admin_crm_customer_ids_v1/);
assert.match(crmPage, /customerQuery: initialQuery/);
assert.match(crmPage, /initialCustomerId/);
assert.match(crmManager, /router\.replace/);
assert.match(dashboard, /portal_customer_registered/);
assert.match(recoveryRoute, /expectedState/);
assert.match(recoveryRoute, /hasEffectivePermission/);
assert.match(recoveryRoute, /origin !== request\.nextUrl\.origin/);

console.log("Portal customer profile structural, security, CRM search, notification, and checkout guard contract: OK");
