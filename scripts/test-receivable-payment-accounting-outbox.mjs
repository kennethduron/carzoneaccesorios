import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files = {
  migration: "supabase/migrations/202607240001_receivable_payment_accounting_outbox.sql",
  actions: "src/app/admin/pedidos/actions.ts",
  dispatcher: "src/services/accounting/accounting-event-dispatcher.ts",
  engine: "src/services/accounting/financial-event-engine.ts",
  outbox: "src/services/accounting/receivable-payment-outbox.ts",
  journal: "src/services/accounting/journal-draft-generator.ts",
  ui: "src/components/admin/accounts-receivable-manager.tsx",
  eventsUi: "src/components/admin/financial-center-manager.tsx",
  docs: "docs/accounting/receivable-payment-accounting.md",
};

const source = Object.fromEntries(
  await Promise.all(
    Object.entries(files).map(async ([key, file]) => [key, await readFile(file, "utf8")]),
  ),
);

assert.match(source.migration, /create table public\.accounting_outbox/i);
assert.match(source.migration, /after insert on public\.accounts_receivable_payments/i);
assert.match(source.migration, /enqueue_receivable_payment_accounting_v1/i);
assert.match(source.migration, /accounting_outbox_source_unique unique/i);
assert.match(source.migration, /references public\.accounts_receivable_payments\(id\) on delete restrict/i);
assert.match(source.migration, /for update skip locked/i);
assert.match(source.migration, /attempts = attempts \+ 1/i);
assert.match(source.migration, /source_type = 'receivable_payment'/i);
assert.match(source.migration, /event_purpose = 'receivable_payment'/i);
assert.match(source.migration, /posting_version = 'v1'/i);
assert.match(source.migration, /payment\.received_at at time zone 'America\/Tegucigalpa'/i);
assert.match(source.migration, /round\(payment\.amount, 2\)/i);
assert.match(source.migration, /payment_method', payment\.payment_method/i);
assert.match(source.migration, /event_purpose = 'receivable_paid'[\s\S]*control no monetario/i);
assert.match(source.migration, /revoke insert, update, delete on public\.financial_events from authenticated/i);
assert.match(source.migration, /revoke insert, update, delete on public\.accounting_outbox from authenticated/i);
assert.doesNotMatch(source.migration, /update public\.accounting_automation_settings/i);
assert.doesNotMatch(source.migration, /set status = 'publicada'[\s\S]*receivable_payment\.outbox/i);

for (const role of ["technical_owner", "business_owner", "admin", "contadora"]) {
  assert.match(source.migration, new RegExp(`'${role}'`));
}

assert.match(source.engine, /candidate\.event_purpose === "invoice_issued" \|\| candidate\.event_purpose === "receivable_paid"/);
assert.match(source.engine, /status: "skipped"/);
assert.match(source.dispatcher, /isReceivablePaidControl/);
assert.match(source.actions, /processReceivablePaymentAccountingOutbox/);
assert.match(source.actions, /outbox_id: string/);
assert.match(source.actions, /eventStatus: accountingResult\.eventStatus/);
assert.doesNotMatch(source.actions, /sourceType: "receivable_payment"[\s\S]{0,180}dispatchAccountingEvent/);
assert.match(source.outbox, /force_retry: input\.forceRetry/);
assert.match(source.outbox, /generateJournalDraftFromFinancialEvent\(eventId, input\.actorId, client\)/);
assert.match(source.journal, /resolveAccountingMappings\(requirements, client, entryDate\)/);
assert.match(source.ui, /sessionStorage\.setItem\(pendingIdempotencyStorageKey/);
assert.match(source.ui, /sessionStorage\.removeItem\(pendingIdempotencyStorageKey/);
assert.doesNotMatch(
  source.ui,
  /else \{[\s\S]{0,180}idempotencyKey: newIdempotencyKey/,
  "Una respuesta incierta no debe rotar la clave de idempotencia.",
);
assert.match(source.eventsUi, /Reintentar procesamiento/);
assert.match(source.eventsUi, /no es un dry run/i);
assert.match(source.docs, /nunca se publica automáticamente/i);
assert.match(source.docs, /receivable_paid/);
assert.match(
  await readFile("scripts/accounting/repair-missing-receivable-payment-events.mjs", "utf8"),
  /preview\.recoverablePayments/,
);

console.log("Receivable-payment accounting outbox structural checks passed.");
