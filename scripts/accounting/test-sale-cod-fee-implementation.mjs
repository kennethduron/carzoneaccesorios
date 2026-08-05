import { readFile } from "node:fs/promises";

const files = {
  mapping: "supabase/migrations/202608050001_sale_cod_fee_accounting_mapping.sql",
  guard: "supabase/migrations/202608050002_prevent_legacy_v1_when_v2_exists.sql",
  recovery: "supabase/migrations/202608050003_recover_invoice_1025_sales_outbox.sql",
  scanner: "src/services/accounting/financial-event-engine.ts",
  draft: "src/services/accounting/journal-draft-generator.ts",
  ui: "src/components/admin/financial-center-manager.tsx",
  action: "src/app/admin/contabilidad/actions.ts",
  test: "supabase/tests/sale_cod_fee_accounting.sql",
};

const contents = Object.fromEntries(
  await Promise.all(Object.entries(files).map(async ([key, path]) => [key, await readFile(path, "utf8")])),
);

const assertions = [
  [contents.mapping.includes("'revenue', 'sale_cod_fee'"), "mapping uses the canonical revenue:sale_cod_fee contract"],
  [contents.mapping.includes("'4101002'"), "mapping validates account 4101002"],
  [contents.mapping.includes("date '2026-07-16'"), "mapping is effective for invoice 1025"],
  [contents.mapping.includes("ACCOUNTING_MAPPING_CREATED"), "mapping writes append-only authorization evidence"],
  [contents.guard.includes("financial_events_guard_legacy_v1_when_v2_exists"), "database guards V1 event creation"],
  [contents.guard.includes("journal_entries_guard_legacy_v1_when_v2_exists"), "database guards V1 draft creation"],
  [contents.guard.includes("SUPERSEDED_BY_CANONICAL_V2_EVENT"), "V1 neutralization uses the approved reason"],
  [contents.guard.includes("26c413f2-68df-4a16-818a-155f98394d2f"), "sale V1 target is exact"],
  [contents.guard.includes("48398a6a-ed3f-4a89-8786-021beaf1549f"), "COGS V1 target is exact"],
  [contents.recovery.includes("04fde1d0-b14e-4206-869f-e10203246429"), "recovery targets the exact V2 outbox"],
  [contents.recovery.includes("attempt_count <> 8"), "recovery checks all eight prior attempts"],
  [contents.recovery.includes("939ad70f-d748-4724-a0df-cbefae7feb40"), "recovery protects the published COGS journal"],
  [!contents.recovery.includes("process_accounting_outbox_v2("), "recovery migration does not process or publish"],
  [contents.scanner.includes("canonicalV2Coverage"), "scanner checks V2 coverage before V1 registration"],
  [contents.draft.includes("Este evento V1 fue reemplazado"), "draft service rejects superseded V1 events"],
  [contents.ui.includes("Cuenta contable pendiente: Ventas por contraentrega"), "UI names the pending business concept safely"],
  [!contents.ui.includes("Mapping/dato faltante: ${event.outbox.missing_key}"), "UI no longer exposes an internal mapping key"],
  [contents.action.includes("Falta configurar la cuenta contable para ingresos por contraentrega"), "retry action returns the safe COD message"],
  [contents.test.includes("SALE-COD-FEE-LOCAL-ONLY"), "local-only fixture is isolated and searchable"],
  [contents.test.includes("five retries return the existing COD draft"), "idempotency regression covers five retries"],
];

for (const [condition, message] of assertions) {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`PASS: ${message}`);
}

console.log(`PASS: ${assertions.length}/${assertions.length} structural COD accounting checks`);
