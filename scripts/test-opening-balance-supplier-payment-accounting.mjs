import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const [migration, sqlContract, types, panel, worker, lateMigration] =
  await Promise.all([
    read(
      "supabase/migrations/202607280015_opening_balance_supplier_payment_accounting.sql",
    ),
    read("supabase/tests/opening_balance_supplier_payment_accounting.sql"),
    read("src/types/supplier-payment-accounting-repair.ts"),
    read(
      "src/components/admin/supplier-payment-accounting-repair-panel.tsx",
    ),
    read("supabase/migrations/202607280004_supplier_payment_accounting_v2.sql"),
    read(
      "supabase/migrations/202607280014_supplier_payment_late_entry_accounting.sql",
    ),
  ]);

const compatibilityMigration = await read(
  "supabase/migrations/202607280016_opening_balance_pending_event_compatibility.sql",
);

const mustContain = (text, values, contract) => {
  for (const value of values) {
    assert.ok(text.includes(value), `${contract}: missing ${value}`);
  }
};

mustContain(
  migration,
  [
    "resolve_accounts_payable_accounting_recognition_v1",
    "direct_event",
    "opening_balance_control",
    "accounting_opening_balance_batches",
    "protected_count",
    "protected_supplier_count",
    "protected_total",
    "protected_hash",
    "2101001",
    "PROVEEDORES LOCALES",
    "opening_balance_entry_not_posted",
    "opening_balance_entry_reversed",
    "accounts_payable_individual_recognition_incompatible",
    "opening_balance_control_line_ambiguous",
    "opening_balance_control_total_mismatch",
    "opening_balance_auxiliary_count_mismatch",
    "opening_balance_auxiliary_total_mismatch",
    "opening_balance_auxiliary_hash_mismatch",
    "payment_date_before_payable_recognition",
    "supplier_payment_existing_journal",
    "supplier_payment_opening_balance_recognized",
    "supplier_payment_opening_balance_routed",
    "supplier_payment_opening_balance_repair_completed",
    "supplier_payment_opening_balance_validation_failed",
    "pg_advisory_xact_lock",
    "for update",
    "for share",
    "covered_financial_event_v1_id",
    "route_accounting_fact_v2",
    "manual_publication_required",
  ],
  "migration contract",
);

mustContain(
  compatibilityMigration,
  [
    "direct_artifact_count",
    "event.journal_entry_id is not null",
    "event.status <> 'pending'",
    "accounts_payable_individual_recognition_incompatible",
  ],
  "pending manual-scan compatibility contract",
);

const resolverCalls = [
  ...migration.matchAll(
    /resolve_accounts_payable_accounting_recognition_v1\(/g,
  ),
].length;
assert.ok(
  resolverCalls >= 5,
  "Assessment, router and repair must share the canonical resolver.",
);

const resolverBody = migration.slice(
  migration.indexOf(
    "create or replace function public.resolve_accounts_payable_accounting_recognition_v1",
  ),
  migration.indexOf(
    "alter function public.supplier_payment_accounting_assessment_v1",
  ),
);
for (const mutation of [
  "insert into public.",
  "update public.",
  "delete from public.",
]) {
  assert.ok(
    !resolverBody.toLowerCase().includes(mutation),
    `Recognition resolver is not read-only: ${mutation}`,
  );
}

const repairBody = migration.slice(
  migration.lastIndexOf(
    "create or replace function\n  public.repair_late_recorded_supplier_payment_draft_v1",
  ),
);
for (const forbidden of [
  "insert into public.journal_entries",
  "insert into public.journal_entry_lines",
  "update public.supplier_payments",
  "update public.accounts_payable",
  "update public.accounting_feature_flags",
  "process_accounting_outbox_v2",
  "set status = 'publicada'",
]) {
  assert.ok(
    !repairBody.toLowerCase().includes(forbidden.toLowerCase()),
    `Repair contains forbidden operation: ${forbidden}`,
  );
}

for (const forbidden of [
  "KOOLAUDIO S DE RL DE CV",
  "Edgar Joel Leiva Paz",
  "5911527b-53ed-49bf-b6cc-ead2951adf60",
  "cdfc62f3-3b05-49e7-af81-f0a6f59a9ea6",
  "3decb1cc-fa18-49e2-ac9a-c97e84916f5b",
  "a2250e0c-7718-4203-92a1-178429a86018",
]) {
  assert.ok(
    !migration.includes(forbidden),
    `Migration must be general and cannot name ${forbidden}`,
  );
}

assert.ok(
  !/update\s+public\.(supplier_payments|accounts_payable|suppliers|products|orders|inventory_movements)\b/i.test(
    migration,
  ),
  "Migration must not mutate operational or commercial state.",
);
assert.ok(
  !migration.includes("process_accounting_outbox_v2("),
  "Migration must not manually run the scheduler worker.",
);

mustContain(
  sqlContract,
  [
    "direct-event recognition remains valid",
    "valid aggregate opening balance",
    "full opening-balance payment",
    "partial opening-balance payment",
    "multiple payments on one payable",
    "separate Edgar payments",
    "incorrect protected hash",
    "incorrect auxiliary count",
    "incorrect control total",
    "unpublished opening entry",
    "reversed opening entry",
    "different control account",
    "multiple control lines",
    "payable excluded from batch",
    "valid chronology",
    "invalid chronology",
    "inactive mapping",
    "independent, already published artifact",
    "existing outbox",
    "existing draft",
    "idempotent replay",
    "balanced draft",
    "manual publication",
    "V1 event covered",
    "rollback;",
  ],
  "SQL regression coverage",
);

mustContain(
  types + panel,
  [
    "opening_balance_control",
    "opening_balance_recognition",
    "Obligaci\u00f3n reconocida mediante saldo inicial.",
    "Pago elegible",
    "Saldo inicial",
  ],
  "administrative UI",
);

mustContain(
  worker + lateMigration,
  [
    "process_accounting_outbox_v2",
    "supplier_payments_enqueue_accounting_v2",
    "observe_supplier_payment_outbox_v2",
  ],
  "unchanged canonical worker and trigger",
);

console.log(
  "Opening-balance supplier-payment accounting structural contracts: OK",
);
