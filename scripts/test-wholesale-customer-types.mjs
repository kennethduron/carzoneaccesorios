import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migration = await readFile(
  new URL("../supabase/migrations/202606120001_wholesale_customer_types.sql", import.meta.url),
  "utf8",
);
const syncMigration = await readFile(
  new URL("../supabase/migrations/202606120002_wholesale_first_purchase_sync.sql", import.meta.url),
  "utf8",
);
const actions = await readFile(new URL("../src/app/admin/crm/actions.ts", import.meta.url), "utf8");
const checkout = await readFile(new URL("../src/app/checkout/actions.ts", import.meta.url), "utf8");
const account = await readFile(new URL("../src/app/actions/wholesale.ts", import.meta.url), "utf8");

assert.match(migration, /wholesale_customer_type text not null default 'new'/);
assert.match(migration, /wholesale_first_purchase_completed boolean not null default false/);
assert.match(migration, /wholesale_customer_type in \('new', 'existing'\)/);
assert.match(migration, /public\.current_actor_role\(\) in \('technical_owner', 'business_owner', 'admin'\)/);
assert.match(migration, /public\.has_permission\('wholesale:manage'\)/);
assert.match(migration, /complete_wholesale_first_purchase/);
assert.match(migration, /wholesale\.first_purchase_completed/);
assert.match(syncMigration, /deferrable initially deferred/);
assert.match(syncMigration, /wholesale\.first_purchase_reopened/);
assert.match(actions, /wholesaleManagementRoles: AppRole\[\] = \["technical_owner", "business_owner", "admin"\]/);
assert.match(actions, /wholesale_management\.denied/);
assert.match(actions, /changeWholesaleCustomerTypeAction/);
assert.doesNotMatch(actions, /Mayorista aprobado por/);
assert.match(
  checkout,
  /Para activar tu primera compra mayorista, el monto mínimo debe ser de L 10,000\. Después de tu primera compra mayorista, podrás comprar cualquier monto\./,
);
assert.match(account, /wholesale_customer_type === "existing"/);

console.log("Wholesale customer type structure checks passed.");
