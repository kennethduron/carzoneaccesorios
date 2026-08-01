import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files = {
  core: "supabase/migrations/202607310008_customer_merge_core.sql",
  preview: "supabase/migrations/202607310009_customer_merge_preview_and_matching.sql",
  execution: "supabase/migrations/202607310010_customer_merge_execution.sql",
  guards: "supabase/migrations/202607310011_customer_canonical_guards_and_integrations.sql",
  action: "src/app/admin/crm/actions.ts",
  mergeActions: "src/app/admin/crm/customer-merge-actions.ts",
  wizard: "src/components/admin/customer-merge-wizard.tsx",
  crm: "src/components/admin/crm-manager.tsx",
};

const source = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, path]) => [key, await readFile(path, "utf8")])));

assert.match(source.core, /merged_into_customer_id uuid references public\.customers\(id\) on delete restrict/);
assert.match(source.core, /customer_merge_operations/);
assert.match(source.core, /customer_identity_values/);
assert.match(source.core, /where name in \('technical_owner', 'business_owner'\)/);
assert.match(source.core, /where name in \('admin', 'vendedor', 'contadora', 'bodega', 'soporte', 'cliente'\)/);
assert.match(source.preview, /preview_customer_merge_v1/);
assert.match(source.preview, /CUSTOMER_MERGE_TWO_PORTAL_ACCOUNTS/);
assert.match(source.preview, /CUSTOMER_MERGE_CHECKOUT_IN_PROGRESS/);
assert.match(source.execution, /pg_advisory_xact_lock/);
assert.match(source.execution, /for update/);
assert.match(source.execution, /CUSTOMER_MERGE_INVARIANT_FAILED/);
assert.match(source.execution, /idempotentReplay/);
assert.match(source.guards, /CUSTOMER_ALIAS_READ_ONLY/);
assert.match(source.action, /CUSTOMER_LEGACY_MERGE_DISABLED/);
assert.doesNotMatch(source.action, /export async function mergeDuplicateCustomerAction[\s\S]*?Promise\.all\(updates\)/);
assert.match(source.mergeActions, /requirePermission\("customers:merge"\)/);
assert.match(source.wizard, /Los límites de crédito nunca se suman/);
assert.match(source.wizard, /Facturas emitidas, partidas publicadas/);
assert.match(source.crm, /CustomerMergeWizard/);
assert.doesNotMatch(source.crm, /DuplicateMergeConfirmModal/);

console.log("Customer canonical merge structural contract passed.");
