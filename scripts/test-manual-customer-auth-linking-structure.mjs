import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const migration = readFileSync(
  "supabase/migrations/202607150003_manual_customer_auth_linking.sql",
  "utf8",
);
const checkoutOverloadMigration = readFileSync(
  "supabase/migrations/202607150004_remove_obsolete_checkout_overload.sql",
  "utf8",
);
const wholesale = readFileSync("src/app/actions/wholesale.ts", "utf8");
const crmActions = readFileSync("src/app/admin/crm/actions.ts", "utf8");
const profileSync = readFileSync("src/lib/auth/profile-sync.ts", "utf8");
const authActions = readFileSync("src/app/auth/actions.ts", "utf8");
const authCard = readFileSync("src/components/forms/auth-card.tsx", "utf8");
const permissions = readFileSync("src/lib/auth/permissions.ts", "utf8");
const portal = readFileSync("src/app/cuenta/page.tsx", "utf8");
const customerAccount = readFileSync("src/services/supabase/customer-account.service.ts", "utf8");
const creditService = readFileSync("src/services/supabase/credit.service.ts", "utf8");
const receivableImport = readFileSync("src/services/supabase/accounts-receivable-import.service.ts", "utf8");
const checkoutActions = readFileSync("src/app/checkout/actions.ts", "utf8");

assert.match(migration, /create unique index if not exists customers_user_id_unique_idx/i);
assert.match(migration, /create or replace function public\.link_customer_portal_account_manual/i);
assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/i);
assert.match(migration, /public\.has_permission\('customers:link_portal_account'\)/i);
assert.match(migration, /pg_advisory_xact_lock[\s\S]*for update/i);
assert.match(migration, /customer_portal_link\.linked_manual/i);
assert.match(
  migration,
  /grant execute on function public\.link_customer_portal_account_manual\(uuid, uuid, text, boolean\) to authenticated/i,
);
assert.doesNotMatch(
  migration,
  /grant execute on function public\.link_customer_portal_account_manual\(uuid, uuid, text, boolean\) to anon/i,
);
assert.match(migration, /profile_phone text := nullif/i);
assert.doesNotMatch(migration, /00000000/);
assert.match(migration, /create or replace function public\.create_checkout_order/i);
assert.match(migration, /legacy_customer_email := null/i);
assert.match(
  migration,
  /set_config\('request\.jwt\.claim\.sub', '', true\)[\s\S]{0,1200}create_checkout_order_legacy_20260511[\s\S]{0,900}set_config\('request\.jwt\.claim\.sub', coalesce\(original_jwt_sub, ''\), true\)/i,
);
assert.match(
  migration,
  /if legacy_customer_id <> account_customer_id then[\s\S]{0,300}customers\.phone = legacy_customer_phone[\s\S]{0,300}if not found then/i,
);
assert.match(
  migration,
  /from public\.orders[\s\S]{0,300}orders\.user_id = current_user_id[\s\S]{0,300}customers\.user_id is null/i,
);
assert.doesNotMatch(
  migration,
  /values\s*\(\s*current_user_id,\s*coalesce\(nullif\(normalized_customer_name/i,
);

assert.doesNotMatch(wholesale, /email.ilike|customerFilter/);
assert.doesNotMatch(wholesale, /user_id:\s*user\.id[\s\S]{0,220}from\("customers"\)/);
assert.doesNotMatch(wholesale, /00000000/);
assert.match(wholesale, /user_id:\s*null/);
assert.doesNotMatch(crmActions, /user_id:\s*userProfile/);
assert.match(crmActions, /requirePermission\("customers:link_portal_account"\)/);
assert.match(crmActions, /link_customer_portal_account_manual/);
assert.match(crmActions, /p_confirmed:\s*true/);

assert.doesNotMatch(profileSync, /\.from\("customers"\)/);
assert.doesNotMatch(profileSync, /00000000/);
assert.match(profileSync, /phone = normalizeAuthPhone\(input\.phone \?\? ""\) \|\| null/);

assert.match(authActions, /input\.password\.length < 8/);
assert.match(authCard, /minLength=\{isLogin \? undefined : 8\}/);
assert.match(permissions, /customers:link_portal_account/);
assert.match(portal, /aún no está vinculada con un cliente operativo/);
assert.match(customerAccount, /\.from\("customers"\)\.select\("id"\)\.eq\("user_id", userId\)/);
assert.doesNotMatch(customerAccount, /customers[\s\S]{0,120}ilike\("email"/i);
assert.match(creditService, /\.eq\("customers\.user_id", userId\)/);
assert.match(creditService, /\.eq\("user_id", userId\)/);
assert.doesNotMatch(receivableImport, /customers\.user_id|user_id\s*:/i);
assert.match(checkoutOverloadMigration, /drop function public\.create_checkout_order/i);
assert.match(checkoutActions, /\.rpc\("create_checkout_order_v2"/);
assert.doesNotMatch(checkoutActions, /\.rpc\("create_checkout_order"/);

console.log("Manual customer/Auth linking structural checks passed.");
