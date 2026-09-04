import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read=(path)=>readFileSync(new URL(`../${path}`,import.meta.url),"utf8");
const migration=read("supabase/migrations/202609030001_sales_commercial_phase4_reporting_policies.sql");
const permissions=read("src/lib/auth/permissions.ts");
const authTypes=read("src/types/auth.ts");
const policyUi=read("src/components/admin/commission-policies-manager.tsx");
const dashboard=read("src/components/admin/commercial-reports-dashboard-v2.tsx");
const center=read("src/components/admin/report-center-v2.tsx");
const sheet=read("src/components/admin/accessible-sheet.tsx");
const files=read("src/utils/commercial-report-files.ts");
const generateRoute=read("src/app/api/admin/commercial-reports/generate/route.ts");

for(const table of ["sales_commission_policies","sales_commission_policy_events","sales_commission_assignment_operations","sales_commission_assignment_items","commercial_report_configurations","commercial_report_generations","commercial_report_generation_events"]){assert.match(migration,new RegExp(`create table public\\.${table}`));assert.match(migration,new RegExp(`alter table public\\.${table} enable row level security`))}
for(const permission of ["commissions:policies:manage","commercial:reports:read","commercial:reports:generate"]){assert.ok(permissions.includes(permission));assert.ok(authTypes.includes(permission))}
assert.match(migration,/public\.current_actor_role\(\) in \('technical_owner','business_owner','admin'\)/);
assert.doesNotMatch(permissions,/vendedor:[\s\S]*?commercial:reports:read[\s\S]*?bodega:/,"seller must not receive elevated reporting permissions");
assert.match(migration,/PHASE4_AUDIT_IMMUTABLE/);assert.match(migration,/COMMISSION_POLICY_IMMUTABLE/);
assert.match(migration,/pg_advisory_xact_lock\(hashtextextended\('phase4-assignment:'/);assert.match(migration,/cardinality\(normalized\) not between 1 and 50/);
assert.match(migration,/COMMISSION_ASSIGNMENT_PREVIEW_STALE/);assert.match(migration,/COMMISSION_ASSIGNMENT_CONFLICT/);assert.match(migration,/FUTURE_CONFLICT/);assert.match(migration,/NO_OP/);
assert.match(migration,/policy_id uuid references public\.sales_commission_policies/);assert.match(migration,/assignment_operation_id uuid references/);
assert.doesNotMatch(migration,/\b(drop table|truncate|delete from public\.(orders|products|customers|payments|invoices|accounts_receivable))\b/i);
assert.doesNotMatch(migration,/historical.*backfill|backfill.*commission/i);
assert.match(migration,/commission_net_valid_collected_v1/);assert.match(migration,/sales_commission_entries/);assert.match(migration,/pos_price_requests/);
assert.match(migration,/to_date-from_date>366/);assert.match(migration,/least\(greatest\(coalesce\(p_limit,20\),1\),5000\)/);
assert.match(migration,/report_snapshot jsonb/);assert.match(migration,/snapshot_hash/);assert.match(migration,/commercial_report_generation_state/);
assert.doesNotMatch(migration,/cost_price|margin_amount|margin_percent/);assert.doesNotMatch(dashboard,/cost_price|costPrice|marginAmount|marginPercent/);assert.doesNotMatch(center,/payout|payroll|nómina/i);
assert.match(policyUi,/Política ≠ regla compartida/);assert.match(policyUi,/previewToken/);assert.match(policyUi,/Crear \{preview\.willCreate\} reglas/);
assert.match(dashboard,/hidden overflow-x-auto md:block/);assert.match(dashboard,/divide-y md:hidden/);assert.match(center,/hidden overflow-x-auto md:block/);assert.match(center,/divide-y md:hidden/);
assert.match(center,/offset=\$\{\(page - 1\) \* pageSize\}/);assert.match(center,/Paginación del historial/);
assert.match(center,/format: config\.format/);assert.match(center,/filters: config\.filters/);assert.match(center,/sections: config\.sections/);assert.match(center,/columns: config\.columns/);
for(const normalizedFilter of ["sellerId","channel","customerType","paymentMethod","saleStatus","specialPrice","comparePrevious"])assert.match(center,new RegExp(normalizedFilter));
assert.match(dashboard,/Comparar período anterior/);assert.match(dashboard,/Clientes atendidos/);assert.match(dashboard,/Historial de reglas/);assert.match(dashboard,/Correcciones de atribución/);
for(const contract of [/role="dialog"/,/aria-modal="true"/,/event\.key==="Escape"/,/event\.key!=="Tab"/,/event\.shiftKey/,/restore\.current\?\.focus\(\)/])assert.match(sheet,contract);
assert.match(files,/new jsPDF/);assert.match(files,/new ExcelJS\.Workbook/);assert.match(files,/addWorksheet\("Resumen"/);assert.match(files,/addWorksheet\("Detalle"/);assert.match(files,/autoFilter/);assert.match(files,/state:"frozen"/);
assert.match(generateRoute,/authorizeCommissionRequest\("commercial:reports:generate",true\)/);assert.match(generateRoute,/X-Content-Type-Options/);assert.match(generateRoute,/Cache-Control/);
console.log("Phase 4 structure: policies, atomic bulk assignment, reporting, exports, RBAC, responsive and accessibility contracts OK");
