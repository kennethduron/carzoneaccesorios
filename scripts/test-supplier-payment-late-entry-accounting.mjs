import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const [
  migration,
  sqlContract,
  actions,
  page,
  panel,
  service,
  engine,
  permissions,
  authTypes,
  worker,
  cronJob,
  vercelConfig,
] = await Promise.all([
  read("supabase/migrations/202607280014_supplier_payment_late_entry_accounting.sql"),
  read("supabase/tests/supplier_payment_late_entry_accounting.sql"),
  read("src/app/admin/cuentas-por-pagar/actions.ts"),
  read("src/app/admin/cuentas-por-pagar/page.tsx"),
  read("src/components/admin/supplier-payment-accounting-repair-panel.tsx"),
  read("src/services/accounting/supplier-payment-accounting-repairs.ts"),
  read("src/services/accounting/financial-event-engine.ts"),
  read("src/lib/auth/permissions.ts"),
  read("src/types/auth.ts"),
  read("src/services/accounting/accounting-outbox-v2.ts"),
  read("src/lib/accounting/cron-jobs.ts"),
  read("vercel.json"),
]);

function mustContain(text, values, contract) {
  for (const value of values) {
    assert.ok(text.includes(value), `${contract}: missing ${value}`);
  }
}

mustContain(
  migration,
  [
    "supplier_payment_accounting_occurred_at",
    "payment.paid_at < flag.cutover_at",
    "payment.created_at >= flag.cutover_at",
    "late_recorded_supplier_payment",
    "preview_supplier_payment_accounting_repairs_v1",
    "repair_late_recorded_supplier_payment_draft_v1",
    "supplier_payment_accounting_repairs",
    "pg_advisory_xact_lock",
    "for update",
    "accounting:repair_supplier_payment",
    "technical_owner",
    "supplier_payment_historical_before_cutover_skipped",
    "supplier_payment_mapping_missing",
    "supplier_payment_chronology_review_required",
    "manual_publication_required",
    "effective_paid_at",
    "recorded_at",
    "accounting_occurred_at",
    "covered_financial_event_v1_id",
    "route_accounting_fact_v2",
    "supplier_payments_enqueue_accounting_v2",
  ],
  "general SQL contract",
);

const previewBody = migration.slice(
  migration.indexOf("create or replace function public.preview_supplier_payment_accounting_repairs_v1"),
  migration.indexOf("create or replace function public.route_supplier_payment_accounting_v2"),
);
for (const mutation of [
  "insert into public.financial_events",
  "insert into public.accounting_event_log",
  "insert into public.accounting_outbox",
  "update public.",
  "delete from public.",
  "scanFinancialEventsDryRun",
]) {
  assert.ok(
    !previewBody.toLowerCase().includes(mutation.toLowerCase()),
    `read-only preview contains ${mutation}`,
  );
}

const repairBody = migration.slice(
  migration.indexOf("create or replace function public.repair_late_recorded_supplier_payment_draft_v1"),
);
assert.ok(
  !repairBody.includes("insert into public.journal_entries"),
  "Repair must not create a journal entry directly.",
);
assert.ok(
  !repairBody.includes("insert into public.journal_entry_lines"),
  "Repair must not create journal lines directly.",
);
assert.ok(
  !/set\s+status\s*=\s*'publicada'/i.test(migration),
  "Migration must never publish a journal entry.",
);
assert.ok(
  !migration.includes("ALMACEN LA CACHADA"),
  "Migration must not contain a named supplier repair.",
);
assert.ok(
  !migration.includes("2f580ddead3d"),
  "Migration must not contain the production payment reference.",
);
assert.ok(
  !/update\s+public\.accounting_feature_flags/i.test(migration),
  "Migration must not change feature flags or cutover.",
);
assert.ok(
  !/update\s+public\.(supplier_payments|accounts_payable|supplier_invoices|purchases|inventory_movements|products|orders|payments)\b/i.test(
    repairBody,
  ),
  "Repair must not mutate operational or commercial state.",
);

mustContain(
  sqlContract,
  [
    "normal modern payment",
    "late-recorded payment",
    "truly historical payment",
    "null paid_at",
    "eligible_late_recorded",
    "Contadora could not read the preview",
    "Replay was not idempotent",
    "request key was reused",
    "Canonical worker",
    "draft_status",
    "manual_publication_required",
    "Two payments",
    "Inactive financial account",
    "Repair ledger grants",
    "The cutover or feature state changed",
    "The canonical payment changed",
    "The payable changed",
    "rollback;",
  ],
  "transactional SQL coverage",
);

mustContain(
  actions,
  [
    'requirePermission("accounting:repair_supplier_payment")',
    'profile.role !== "technical_owner"',
    "repairLateRecordedSupplierPayment",
    "Pago registrado y enviado al procesamiento contable",
    "Contabilidad pendiente de revisión histórica",
  ],
  "server actions",
);

const registerAction = actions.slice(
  actions.indexOf("export async function registerSupplierPaymentAction"),
  actions.indexOf("export type SupplierPaymentRepairActionInput"),
);
assert.ok(
  !registerAction.includes("processAccountingOutboxV2"),
  "New supplier payments must wait for the canonical scheduler.",
);

mustContain(
  panel,
  [
    "Fecha efectiva",
    "Registrado en el sistema",
    "Fecha propuesta del borrador",
    "Ver vista previa",
    "Confirmar reparación individual",
    "Publicación manual obligatoria",
    "Ir al borrador contable",
    "canRepair && eligible",
    "Procesando…",
  ],
  "administrative UI",
);

mustContain(
  page,
  [
    "getSupplierPaymentAccountingRepairPreviews",
    "SupplierPaymentAccountingRepairPanel",
    "canRepairSupplierPayment",
  ],
  "payables page",
);

mustContain(
  service,
  [
    'import "server-only"',
    "preview_supplier_payment_accounting_repairs_v1",
    "repair_late_recorded_supplier_payment_draft_v1",
    "getSupabaseServerClient",
  ],
  "server-only service",
);
assert.ok(
  !service.includes("getSupabaseAdminClient"),
  "Repair must not be exposed through a service-role client.",
);

mustContain(
  engine,
  [
    "supplier_payment_accounting_repairs",
    '["queued", "processing", "completed"]',
    '"skipped_duplicate" as const',
  ],
  "V1 coverage",
);
mustContain(
  permissions + authTypes,
  ["accounting:repair_supplier_payment"],
  "dedicated permission",
);
mustContain(
  worker + cronJob,
  ["process_accounting_outbox_v2", "claim_due_accounting_outbox_v2", "processDueAccountingOutboxesV2(20)"],
  "canonical worker and scheduler",
);
assert.ok(
  !vercelConfig.includes("/api/cron/process-accounting-outbox-v2"),
  "Existing external scheduler topology must stay intact.",
);

console.log("Supplier payment late-entry accounting structural contracts: OK");
