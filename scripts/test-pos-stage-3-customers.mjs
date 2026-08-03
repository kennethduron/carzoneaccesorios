import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const migration = read("supabase/migrations/202607280001_pos_customer_commercial_rules.sql");
const completionMigration = read("supabase/migrations/202608030001_pos_customer_commercial_profile.sql");
const operationalUxMigration = read("supabase/migrations/202608030002_pos_final_operational_ux_guards.sql");
const types = read("src/types/point-of-sale.ts");
const service = read("src/services/supabase/pos-customer.service.ts");
const requestAuth = read("src/lib/auth/pos-customer-request.ts");
const workspace = read("src/components/admin/pos-customer-workspace.tsx");
const page = read("src/app/admin/pos/page.tsx");

for (const contract of [
  "search_pos_customers_v1",
  "create_pos_customer_v1",
  "update_pos_customer_v1",
  "resolve_customer_pricing_mode_v1",
  "evaluate_wholesale_eligibility_v1",
  "commercial_version",
  "pg_advisory_xact_lock",
  "claim_pos_idempotency_v1",
]) {
  assert.match(migration, new RegExp(contract), `Missing DB contract: ${contract}`);
}
assert.match(operationalUxMigration, /get_selectable_pos_customer_context_v1/);

for (const permission of [
  "pos:access",
  "pos:customers:search",
  "pos:customers:create",
  "pos:customers:update",
  "customers:read_commercial",
  "customers:read_credit",
]) {
  assert.ok(migration.includes(permission), `Missing permission ${permission}`);
}

assert.match(migration, /where name in \('technical_owner', 'business_owner', 'admin'\)/);
assert.match(migration, /where name in \('contadora', 'vendedor', 'bodega', 'soporte', 'cliente'\)/);
assert.doesNotMatch(migration, /insert\s+into\s+public\.(orders|payments|invoices|inventory_movements|accounts_receivable)\b/i);
assert.doesNotMatch(migration, /update\s+public\.(orders|payments|invoices|inventory_movements|accounts_receivable)\b/i);
assert.doesNotMatch(migration, /delete\s+from\s+public\.(orders|payments|invoices|inventory_movements|accounts_receivable)\b/i);
assert.match(migration, /credit_enabled', false/);
assert.match(migration, /portal_linked', false/);
assert.match(migration, /wholesale_status, active, status/);
assert.match(migration, /false, 'none', true, 'active'/);
assert.match(migration, /merchandise_final/);
assert.doesNotMatch(migration, /\b(shipping|delivery|cash_on_delivery|cod)_amount\b/i);
assert.match(migration, /status = 'overdue'/);
assert.match(migration, /status = 'suspended'/);
assert.match(migration, /mask_pos_customer_email_v1/);
assert.match(migration, /mask_pos_customer_phone_v1/);

for (const name of [
  "PosCustomerSearchResult",
  "PosCustomerContext",
  "PosCustomerCreditSummary",
  "PosWholesaleEligibility",
  "PosCustomerWriteResult",
]) {
  assert.ok(types.includes(name), `Missing TypeScript contract: ${name}`);
}

assert.match(service, /server-only/);
assert.match(service, /get_selectable_pos_customer_context_v1/);
assert.match(service, /save_pos_customer_commercial_profile_v1/);
assert.match(completionMigration, /save_pos_customer_commercial_profile_v1/);
assert.match(completionMigration, /set_customer_commercial_credit/);
assert.match(completionMigration, /grant_customer_wholesale_access_v1/);
assert.match(completionMigration, /return_customer_to_retail_v1/);
assert.match(service, /evaluate_wholesale_eligibility_v1/);
assert.match(requestAuth, /hasDatabasePosPermission/);
assert.match(requestAuth, /hasPosPermission\(profile, "pos:access"\)/);
assert.match(page, /requirePermission\("pos:access"\)/);
assert.match(workspace, /setTimeout\(\(\) => void runSearch\(query\), 300\)/);
assert.match(workspace, /AbortController/);
assert.match(workspace, /aria-activedescendant/);
assert.match(workspace, /event\.key === "Enter"/);
assert.match(workspace, /event\.key === "Escape"/);
assert.match(workspace, /Cargar más/);
assert.match(workspace, /Editar configuración comercial/i);
assert.match(workspace, /Habilitar crédito comercial/i);
assert.match(workspace, /Mayorista/i);
assert.doesNotMatch(workspace, /Evaluar elegibilidad mayorista/i);
assert.doesNotMatch(workspace, /Crédito \(solo lectura\)/i);
assert.match(workspace, /siguiente etapa/i);
assert.doesNotMatch(workspace, /finalizar venta|cobrar ahora|emitir factura/i);

console.log("POS Stage 3 customer structural contract: OK");
