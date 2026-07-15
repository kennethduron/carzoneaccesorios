import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL("../" + path, import.meta.url), "utf8");

const reportNames = [
  ["balance-comprobacion", "getTrialBalanceReport"],
  ["libro-mayor", "getGeneralLedgerReport"],
  ["balance-general", "getBalanceSheetReport"],
  ["estado-resultados", "getIncomeStatementReport"],
];

const [migration, service, errorBoundary, ...routeSources] = await Promise.all([
  read("supabase/migrations/202607150002_accounting_report_aggregates_rpc.sql"),
  read("src/services/supabase/accounting-reports.service.ts"),
  read("src/app/admin/error.tsx"),
  ...reportNames.flatMap(([route]) => [
    read(`src/app/admin/${route}/page.tsx`),
    read(`src/app/api/admin/contabilidad/${route}/pdf/route.ts`),
    read(`src/app/api/admin/contabilidad/${route}/excel/route.ts`),
  ]),
]);

assert.match(migration, /create or replace function public\.get_accounting_report_aggregates/);
assert.match(migration, /p_date_from date default null/);
assert.match(migration, /p_date_to date default null/);
assert.match(migration, /p_account_ids uuid\[\] default null/);
assert.match(migration, /p_mode text default 'period'/);
assert.match(migration, /stable\s+security invoker\s+set search_path = public/);
assert.match(migration, /entries\.status = 'publicada'/);
assert.match(migration, /coalesce\(sum\(lines\.debit\), 0\)::numeric\(20, 2\)/);
assert.match(migration, /coalesce\(sum\(lines\.credit\), 0\)::numeric\(20, 2\)/);
assert.match(migration, /when 'opening' then p_date_from is not null and entries\.entry_date < p_date_from/);
assert.match(migration, /when 'period' then[\s\S]*entries\.entry_date >= p_date_from[\s\S]*entries\.entry_date <= p_date_to/);
assert.match(migration, /when 'as_of' then p_date_to is null or entries\.entry_date <= p_date_to/);
assert.match(migration, /p_account_ids is null or lines\.account_id = any\(p_account_ids\)/);
assert.match(migration, /revoke all on function[\s\S]*from public/);
assert.match(migration, /revoke all on function[\s\S]*from anon/);
assert.match(migration, /grant execute on function[\s\S]*to authenticated/);

const functionBody = migration.slice(migration.indexOf("as $function$"), migration.indexOf("$function$;", migration.indexOf("as $function$")));
assert.doesNotMatch(functionBody, /\b(insert|update|delete|truncate)\b/i);

assert.match(service, /\.rpc\("get_accounting_report_aggregates"/);
assert.match(service, /mode: "opening"/);
assert.match(service, /mode: "both"/);
assert.match(service, /mode: mode === "asOfEnd" \? "as_of" : "period"/);
assert.match(service, /journal_entries\.status", "publicada"/);
assert.doesNotMatch(service, /debit\.sum\(\)|credit\.sum\(\)/);
assert.match(service, /\[accounting-report-data-error\]/);
assert.match(service, /No fue posible cargar el reporte contable/);
assert.doesNotMatch(errorBoundary, /configuración de Supabase/);

for (let index = 0; index < reportNames.length; index += 1) {
  const [, serviceFunction] = reportNames[index];
  const [page, pdf, excel] = routeSources.slice(index * 3, index * 3 + 3);
  assert.match(page, /requirePermission\("accounting:view_reports"\)/);
  assert.match(page, new RegExp(serviceFunction));
  for (const exporter of [pdf, excel]) {
    assert.match(exporter, /requirePermission\("accounting:export"\)/);
    assert.match(exporter, new RegExp(serviceFunction));
    assert.match(exporter, /accounting-report-export/);
  }
}

console.log("Accounting report aggregate structure checks passed.", {
  rpcReadOnly: true,
  securityInvoker: true,
  publishedOnly: true,
  postgrestAggregatesRemoved: true,
  pages: reportNames.length,
  exporters: reportNames.length * 2,
});
