import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const paths = {
  migration: "supabase/migrations/202608010001_customer_merge_history_details.sql",
  actions: "src/app/admin/crm/customer-merge-actions.ts",
  wizard: "src/components/admin/customer-merge-wizard.tsx",
  history: "src/components/admin/customer-merge-history.tsx",
  confirmation: "src/components/admin/customer-merge-confirmation.tsx",
  security: "src/services/supabase/admin-security.service.ts",
};
const source = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(path, "utf8")])));

assert.match(source.migration, /get_customer_merge_history_details_v1/);
assert.match(source.migration, /\bstable\b/i);
assert.match(source.migration, /security definer/);
assert.match(source.migration, /set search_path = public, pg_temp/);
assert.match(source.migration, /auth\.uid\(\) is null/);
assert.match(source.migration, /CUSTOMER_MERGE_DETAILS_FORBIDDEN/);
assert.match(source.migration, /CUSTOMER_MERGE_PREVIEW_STALE/);
assert.match(source.migration, /CUSTOMER_MERGE_COMMERCIAL_VERSION_CONFLICT/);
assert.match(source.migration, /revoke all on function public\.get_customer_merge_history_details_v1/);
assert.doesNotMatch(source.migration, /\b(?:insert\s+into|update\s+public|delete\s+from|merge_customers_v1\s*\()/i, "details RPC performs no writes and cannot execute a merge");
assert.doesNotMatch(source.migration, /3548cc3e|03d54a49|139f3464|00dba094/i, "migration contains no production customer IDs");

for (const category of ["order", "invoice", "payment", "receivable", "receivable_payment", "accounting_entry", "inventory_reservation", "inventory_movement", "crm_note", "crm_followup", "checkout_request"]) {
  assert.match(source.migration, new RegExp(`'category', '${category}'`));
}
for (const action of ["move_to_primary", "remain_historical", "preserve_immutable"]) {
  assert.match(source.migration, new RegExp(`'action', '${action}'`));
}

assert.match(source.actions, /get_customer_merge_history_details_v1/);
assert.match(source.actions, /p_preview_hash: preview\.previewHash/);
assert.match(source.actions, /p_expected_primary_commercial_version: preview\.primaryCommercialVersion/);
assert.match(source.actions, /customer_merge_execution_v1/);
assert.match(source.wizard, /CustomerMergeHistory/);
assert.match(source.wizard, /CustomerMergeConfirmationSummary/);
assert.match(source.wizard, /executionEnabled/);
assert.match(source.history, /item\.action === "move_to_primary"/);
assert.match(source.history, /item\.action === "preserve_immutable"/);
assert.doesNotMatch(source.history, /relationPlan/);
assert.match(source.confirmation, /details\.assurances\.map/);
assert.match(source.confirmation, /archiveConsequence\.label/);
assert.match(source.security, /customers:customers!customers_user_id_fkey\(id\)/);

console.log("Customer merge wizard detail contract checks passed.");
