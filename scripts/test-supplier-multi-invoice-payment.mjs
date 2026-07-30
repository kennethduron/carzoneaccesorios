import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { supplierMultiPaymentSchema } = await import(
  "../src/schemas/supplier-multi-payment.ts"
);
const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const [
  core,
  accounting,
  actions,
  service,
  schema,
  wizard,
  manager,
  v1Adapter,
  sqlTests,
] = await Promise.all([
  read("supabase/migrations/202607280017_supplier_multi_invoice_payment_core.sql"),
  read("supabase/migrations/202607280018_supplier_multi_invoice_payment_accounting.sql"),
  read("src/app/admin/cuentas-por-pagar/actions.ts"),
  read("src/services/supabase/supplier-multi-payment.service.ts"),
  read("src/schemas/supplier-multi-payment.ts"),
  read("src/components/admin/supplier-multi-payment-wizard.tsx"),
  read("src/components/admin/accounts-payable-manager.tsx"),
  read("src/services/accounting/adapters/purchase-financial-events.ts"),
  read("supabase/tests/supplier_multi_invoice_payment_v1.sql"),
]);

const mustContain = (text, values, label) => {
  for (const value of values) {
    assert.ok(text.includes(value), `${label}: missing ${value}`);
  }
};

mustContain(core, [
  "allocation_mode",
  "legacy_single",
  "applications_v1",
  "supplier_payment_applications",
  "deferrable initially deferred",
  "supplier_payment_allocations_v1",
  "on delete restrict",
  "numeric(12, 2)",
  "revoke insert, update, delete",
  "supplier_multi_invoice_payment_v1",
], "core migration");

mustContain(accounting, [
  "register_supplier_multi_payment_v1",
  "void_supplier_multi_payment_v1",
  "pg_advisory_xact_lock",
  "for update",
  "for share",
  "resolve_accounts_payable_accounting_recognition_v1",
  "supplier_payment_accounting_occurred_at",
  "resolve_accounting_mapping_v2",
  "multi_application_v1",
  "process_supplier_multi_payment_outbox_v1",
  "process_accounting_outbox_v016",
  "cancel_accounting_fact_v2",
  "supplier_multi_payment_started",
  "supplier_multi_payment_completed",
  "supplier_multi_payment_replayed",
  "supplier_multi_payment_accounting_routed",
  "supplier_multi_payment_accounting_failed",
  "supplier_multi_payment_voided",
  "manual_publication_required",
  "'2101001'",
  "'PROVEEDORES LOCALES'",
], "accounting migration");

const registrationBody = accounting.slice(
  accounting.indexOf("create or replace function public.register_supplier_multi_payment_v1"),
  accounting.indexOf("alter function public.process_accounting_outbox_v2"),
);
for (const forbidden of [
  "insert into public.journal_entries",
  "insert into public.journal_entry_lines",
  "post_journal_entry(",
  "payment_account_id',",
]) {
  assert.ok(
    !registrationBody.toLowerCase().includes(forbidden.toLowerCase()),
    `registration RPC contains forbidden accounting/client input: ${forbidden}`,
  );
}

const workerBody = accounting.slice(
  accounting.indexOf("create or replace function public.process_supplier_multi_payment_outbox_v1"),
  accounting.indexOf("create or replace function public.process_accounting_outbox_v2"),
);
assert.equal(
  [...workerBody.matchAll(/insert into public\.journal_entry_lines/g)].length,
  1,
  "worker must use one set-based line insert",
);
assert.ok(workerBody.includes("'borrador'"), "worker must create a manual draft");
assert.ok(!workerBody.includes("post_journal_entry("), "worker must not auto-publish");

mustContain(schema, [
  ".strict()",
  ".max(200,",
  "Una cuenta por pagar no puede aparecer dos veces.",
  "bank_transfer",
  "Math.round(value * 100)",
], "strict Zod contract");
mustContain(actions + service, [
  "register_supplier_multi_payment_v1",
  "void_supplier_multi_payment_v1",
  "requirePermission(\"payables:manage\")",
], "server boundary");
for (const forbidden of [
  '.from("supplier_payments").insert',
  '.from("accounts_payable").update',
  '.from("supplier_invoices").update',
  '.from("accounting_outbox_v2").insert',
]) {
  assert.ok(
    !(actions + service).includes(forbidden),
    `server boundary bypasses canonical RPC: ${forbidden}`,
  );
}

mustContain(wizard + manager, [
  "Registrar pago",
  "Paso ${draft?.step ?? 1} de 5",
  "previousStep",
  "Regresar",
  "sticky",
  "Aplicar saldo completo",
  "Total aplicado",
  "Diferencia",
  "Confirmar pago",
  "localStorage",
  "requestKey",
], "desktop/mobile wizard");
mustContain(v1Adapter, [
  "allocation_mode",
  'if (row.allocation_mode === "applications_v1")',
], "V1 exclusion");
mustContain(sqlTests, [
  "one payable",
  "five applications",
  "identical request replays",
  "one V2 outbox",
  "exactly one V2 event",
  "exactly two journal lines",
  "remains manual",
  "do not enter V1",
  "reversal annuls an existing draft",
  "one compensation outbox",
  "authenticated direct payment insert is denied",
  "legacy and new payments without backfill",
], "SQL regression coverage");

for (const forbidden of [
  "ALMACEN LA CACHADA",
  "KOOLAUDIO",
  "Edgar",
  "CROMOS",
  "Polarizados Siguatepeque",
]) {
  assert.ok(
    !core.includes(forbidden) && !accounting.includes(forbidden),
    `migrations must remain general: ${forbidden}`,
  );
}

const validInput = {
  request_key: "95000000-0000-4000-8000-000000000001",
  supplier_id: "95000000-0000-4000-8000-000000000002",
  payment_method: "cash",
  paid_date: "2026-07-30",
  reference: null,
  notes: null,
  applications: [
    {
      accounts_payable_id: "95000000-0000-4000-8000-000000000003",
      applied_amount: 0.29,
    },
  ],
};
assert.equal(
  supplierMultiPaymentSchema.safeParse(validInput).success,
  true,
  "valid two-decimal amount 0.29 must not be rejected by binary floating point",
);
assert.equal(
  supplierMultiPaymentSchema.safeParse({
    ...validInput,
    applications: [{ ...validInput.applications[0], applied_amount: 0.291 }],
  }).success,
  false,
  "more than two decimals must be rejected",
);
assert.equal(
  supplierMultiPaymentSchema.safeParse({ ...validInput, total: 0.29 }).success,
  false,
  "top-level browser totals are rejected",
);
assert.equal(
  supplierMultiPaymentSchema.safeParse({
    ...validInput,
    applications: [{ ...validInput.applications[0], balance_before: 100 }],
  }).success,
  false,
  "browser-supplied balance snapshots are rejected",
);
assert.equal(
  supplierMultiPaymentSchema.safeParse({
    ...validInput,
    payment_method: "bank_transfer",
    reference: null,
  }).success,
  false,
  "bank transfer without a reference is rejected",
);
assert.equal(
  supplierMultiPaymentSchema.safeParse({
    ...validInput,
    applications: [validInput.applications[0], validInput.applications[0]],
  }).success,
  false,
  "duplicate payable applications are rejected by Zod",
);

console.log("Supplier multi-invoice payment structural contracts: OK");
