import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import {
  assertStage6LocalEnvironment,
  readStage6LocalStatus,
  stage6Marker,
} from "./pos-stage-6-local-guard.mjs";

const outputIndex = process.argv.indexOf("--output");
assert.ok(outputIndex >= 0 && process.argv[outputIndex + 1], "Use --output <absolute-json-path>.");
const output = process.argv[outputIndex + 1];
const guard = assertStage6LocalEnvironment();
const status = readStage6LocalStatus();
const db = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const countedTables = [
  "roles", "users", "categories", "company_settings", "fiscal_settings",
  "customers", "customer_credit_accounts", "products", "inventory_movements",
  "pos_sale_drafts", "pos_sale_draft_items", "orders", "order_items", "invoices",
  "invoice_items", "payments", "accounts_receivable", "accounts_receivable_payments",
  "accounting_accounts", "accounting_mappings",
  "financial_events", "accounting_outbox", "accounting_outbox_v2", "journal_entries",
  "journal_entry_lines", "accounting_periods", "customer_merge_operations",
];
const counts = {};
for (const table of countedTables) {
  const { count, error } = await db.from(table).select("id", { count: "exact", head: true });
  assert.ifError(error, table);
  counts[table] = count ?? 0;
}

async function stableRows(table, projection, order) {
  const { data, error } = await db.from(table).select(projection).order(order);
  assert.ifError(error, table);
  return data ?? [];
}

const technical = {
  roles: await stableRows("roles", "name,permissions", "name"),
  accountingFeatureFlags: await stableRows("accounting_feature_flags", "key,state,cutover_at,version", "key"),
  checkoutFeatureFlags: await stableRows("checkout_feature_flags", "key,enabled,version", "key"),
  orderPriceFeatureFlags: await stableRows("order_price_feature_flags", "key,enabled", "key"),
  customerFeatureFlags: await stableRows("customer_feature_flags", "key,enabled,version", "key"),
  automation: await stableRows("accounting_automation_settings", "key,value", "key"),
  fiscal: await stableRows(
    "fiscal_settings",
    "id,legal_name,rtn,cai,cai_authorization_date,invoice_range_start,invoice_range_end,current_invoice_number,emission_deadline",
    "id",
  ),
};

async function prefixCount(table, columns) {
  const expression = columns.map((column) => `${column}.ilike.%${stage6Marker}%`).join(",");
  const { count, error } = await db.from(table).select("id", { count: "exact", head: true }).or(expression);
  assert.ifError(error, `${table} prefix`);
  return count ?? 0;
}

const prefixCounts = {
  roles: await prefixCount("roles", ["description"]),
  users: await prefixCount("users", ["full_name", "email"]),
  companies: await prefixCount("company_settings", ["company_name", "invoice_prefix", "order_prefix"]),
  fiscal: await prefixCount("fiscal_settings", ["legal_name", "cai", "email"]),
  customers: await prefixCount("customers", ["contact_name", "business_name", "email"]),
  products: await prefixCount("products", ["sku", "internal_code", "name"]),
  accounts: await prefixCount("accounting_accounts", ["code", "name", "description"]),
  orders: await prefixCount("orders", ["order_number", "customer_name"]),
  invoices: await prefixCount("invoices", ["invoice_number", "cai"]),
  drafts: await prefixCount("pos_sale_drafts", ["internal_notes"]),
};
const authUsers = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
assert.ifError(authUsers.error);
prefixCounts.authUsers = authUsers.data.users.filter((user) =>
  user.email?.includes(stage6Marker) || user.user_metadata?.full_name?.includes(stage6Marker)
).length;

const psql = (sql) => execFileSync("docker", [
  "exec", guard.container, "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", sql,
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const migrations = psql("select version from supabase_migrations.schema_migrations order by version;")
  .split(/\r?\n/).filter(Boolean);
const schemaDigest = psql(`
  with definitions as (
    select 'function:' || n.nspname || '.' || p.proname || ':' || pg_get_function_identity_arguments(p.oid)
      || ':' || pg_get_functiondef(p.oid) as value
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
    union all
    select 'policy:' || schemaname || '.' || tablename || '.' || policyname || ':'
      || coalesce(qual, '') || ':' || coalesce(with_check, '') from pg_policies where schemaname = 'public'
    union all
    select 'rls:' || n.nspname || '.' || c.relname || ':' || c.relrowsecurity::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  ) select md5(string_agg(value, E'\\n' order by value)) from definitions;
`);
const sha256 = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const comparable = { counts, prefixCounts, migrations, schemaDigest, technical };
const report = {
  generatedAt: new Date().toISOString(),
  marker: stage6Marker,
  guard,
  ...comparable,
  comparableSha256: sha256(comparable),
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  output,
  comparableSha256: report.comparableSha256,
  finalMigration: migrations.at(-1),
  prefixCounts,
  counts,
}, null, 2));
