import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("supabase/migrations/202609020002_sales_commercial_phase3_commissions_workspace.sql");
const permissions = read("src/lib/auth/permissions.ts");
const commissionRequest = read("src/lib/auth/commission-request.ts");
const ruleRoute = read("src/app/api/admin/commission-sellers/[sellerId]/rules/route.ts");
const adjustmentRoute = read("src/app/api/admin/commissions/[entryId]/route.ts");
const sellerProducts = read("src/components/admin/seller-products.tsx");
const sellerCustomers = read("src/components/admin/seller-customers.tsx");
const sellersManager = read("src/components/admin/sellers-manager.tsx");
const commissionsManager = read("src/components/admin/commissions-manager.tsx");
const sellerWorkspace = read("src/components/admin/seller-workspace-dashboard.tsx");
const myCommissions = read("src/components/admin/my-commissions-dashboard.tsx");
const mySales = read("src/components/admin/my-sales-dashboard.tsx");

for (const table of ["sales_commission_rules", "sales_commission_entries", "sales_commission_events"]) {
  assert.match(migration, new RegExp(`create table public\\.${table}`));
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
}
for (const permission of ["sales:seller_dashboard:read_own", "commissions:read_own", "commissions:read_all", "commissions:rules:manage", "commissions:adjust"]) {
  assert.match(permissions, new RegExp(permission.replaceAll(":", "\\:")));
}
assert.match(migration, /rule_type in \('PERCENTAGE','FIXED_AMOUNT'\)/);
assert.match(migration, /rule\.effective_from<=order_record\.confirmed_at/);
assert.match(migration, /eligible_base\*rule_record\.rule_value\/100/);
assert.match(migration, /taxable_base_snapshot,0\)\+coalesce\(item\.exempt_amount_snapshot/);
assert.match(migration, /potential_amount \* collected \/ entry_record\.collectible_sale_total_snapshot/);
assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('commission-order:'/);
assert.match(migration, /pg_advisory_xact_lock\(hashtextextended\('commission-rule:'/);
assert.match(migration, /unique \(order_id, attribution_revision\)/);
assert.match(migration, /sales_commission_entries_active_order_idx/);
assert.match(migration, /on conflict\(idempotency_key\) do nothing/);
assert.match(migration, /after insert or update of amount,status,payment_status on public\.payments/);
assert.match(migration, /after insert or update of amount,voided_at on public\.accounts_receivable_payments/);
assert.match(migration, /after update of status,seller_id on public\.orders/);
assert.match(migration, /no historical commission backfill/);
assert.doesNotMatch(migration, /commission_backfill|backfill_sales_commission/i, "Migration must not contain a historic backfill routine.");
assert.match(migration, /revoke all on public\.sales_commission_rules, public\.sales_commission_entries/);
assert.match(migration, /COMMISSION_LEDGER_IMMUTABLE/);
assert.match(migration, /p_effective_date<today_hn/);
assert.match(migration, /COMMISSION_RULE_FUTURE_ALREADY_EXISTS/);

assert.match(commissionRequest, /technical_owner.*business_owner.*admin/);
assert.match(ruleRoute, /verifySameOriginRequest/);
assert.match(adjustmentRoute, /verifySameOriginRequest/);
assert.doesNotMatch(commissionRequest, /service_role/i);
assert.match(sellerProducts, /limit=15/);
assert.doesNotMatch(sellerProducts, /cost_price|costPrice|marginAmount|marginPercent/);
assert.doesNotMatch(sellerProducts, /Editar|Guardar producto/);
assert.match(sellerCustomers, /Datos permitidos/);
assert.match(sellerCustomers, /Mayorista, credito, limite, notas sensibles y cuenta web no pueden modificarse/);
assert.doesNotMatch(sellerCustomers, /name="creditLimit"|name="creditMode"|name="customerType"/);
assert.match(sellersManager, /role="dialog"/);
assert.match(sellersManager, /aria-modal="true"/);
assert.match(sellersManager, /Las ventas anteriores conservaran su regla historica/);
assert.match(sellersManager, /Confirmo que revise tipo, valor y fecha de vigencia/);
assert.match(commissionsManager, /Detalle de comision/);
assert.match(commissionsManager, /Registrar ajuste/);
assert.doesNotMatch(commissionsManager, />Exportar</);
assert.match(sellerWorkspace, /Mi rendimiento comercial/);
assert.match(sellerWorkspace, /Mi comision/);
assert.match(sellerWorkspace, /Borradores abiertos/);
assert.match(sellerWorkspace, /Solicitudes de precio/);
assert.match(sellerWorkspace, /lg:grid-cols-4 2xl:grid-cols-7/, "Seller metrics must keep four columns at 1440px and use seven only at 2XL.");
assert.doesNotMatch(sellerWorkspace, /lg:grid-cols-4 xl:grid-cols-7/, "The truncated 1440px seven-column metric layout must not return.");
assert.match(myCommissions, /Solo tus comisiones/);
assert.match(myCommissions, /Regla vigente/);
for (const contract of [
  /role="dialog"/,
  /aria-modal="true"/,
  /document\.activeElement as HTMLElement\|null/,
  /event\.key==="Escape"/,
  /event\.key!=="Tab"/,
  /event\.shiftKey/,
  /previous\?\.focus\(\)/,
]) assert.match(myCommissions, contract, `My commission detail accessibility contract is missing: ${contract}`);
for (const contract of [
  /flex h-full w-full flex-col/,
  /sm:w-\[70vw\]/,
  /lg:w-\[40vw\]/,
  /lg:max-w-2xl/,
  /flex-1 space-y-4 overflow-y-auto/,
  /document\.activeElement as HTMLElement\|null/,
  /event\.key==="Escape"/,
  /event\.shiftKey/,
  /previous\?\.focus\(\)/,
]) assert.match(sellersManager, contract, `Commission rule drawer responsive/accessibility contract is missing: ${contract}`);
assert.match(commissionsManager, /hidden overflow-x-auto md:block/, "Elevated commission table must use a bounded inner scroller.");
assert.match(commissionsManager, /divide-y md:hidden/, "Elevated commission records must become cards below the tablet breakpoint.");
assert.match(mySales, /CommissionStrip/);
assert.match(mySales, /por ganar/);
assert.ok([sellerProducts, sellerCustomers, sellersManager, commissionsManager, sellerWorkspace, myCommissions].every((source) => !source.includes("min-w-[1920px]")), "Responsive views must not impose desktop-width canvases.");

console.log("Phase 3 structure: RBAC, money model, integrations, seller-safe views, responsive contracts, and no export OK");
