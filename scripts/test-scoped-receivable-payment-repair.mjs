import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  assertPostRepair,
  decimalToMinorUnits,
  parseRepairArgs,
  scopedPublicReport,
  validateApplyPreflight,
} from "./accounting/scoped-receivable-payment-repair.mjs";

const paymentId = "8fb0c6c5-1234-4234-9234-1234567890ab";
const eventId = "8f71d025-1234-4234-9234-1234567890ab";
const journalId = "8aa00000-1234-4234-9234-1234567890ab";

function options(overrides = {}) {
  return {
    apply: true,
    paymentId,
    expectedEventId: eventId,
    expectedAmount: 1_134_000n,
    expectedDate: "2026-07-11",
    expectedMethod: "bank_transfer",
    ...overrides,
  };
}

function preview(overrides = {}) {
  return {
    paymentId,
    payments: [{
      id: paymentId,
      receivable_id: "81000000-1234-4234-9234-1234567890ab",
      customer_id: "82000000-1234-4234-9234-1234567890ab",
      amount: "11340.00",
      payment_method: "bank_transfer",
      received_at: "2026-07-11T14:00:00-06:00",
      voided_at: null,
      balance_before: "11340.00",
      balance_after: "0.00",
    }],
    receivables: [{ id: "81000000-1234-4234-9234-1234567890ab", balance_due: "0.00" }],
    events: [{
      id: eventId,
      source_type: "receivable_payment",
      source_id: paymentId,
      event_purpose: "receivable_payment",
      posting_version: "v1",
      status: "pending",
      journal_entry_id: null,
      source_snapshot: { event_type: "receivable_payment_received" },
    }],
    outbox: [],
    journalEntries: [],
    journalLines: [],
    possibleManualEntries: [],
    debitMapping: {
      mapping_type: "payment_method",
      source_key: "bank_transfer",
      account_id: "83000000-1234-4234-9234-1234567890ab",
      is_active: true,
      accounting_accounts: { code: "1101004", name: "BAC AHORRO LPS", is_active: true },
    },
    creditMapping: {
      mapping_type: "receivable",
      source_key: "accounts_receivable",
      account_id: "84000000-1234-4234-9234-1234567890ab",
      is_active: true,
      accounting_accounts: { code: "1102001", name: "CLIENTES", is_active: true },
    },
    mappings: [],
    periods: [{ status: "open" }],
    paymentDate: "2026-07-11",
    closedPeriod: false,
    controlEvents: [{
      id: "85000000-1234-4234-9234-1234567890ab",
      event_purpose: "receivable_paid",
      status: "skipped",
      journal_entry_id: null,
    }],
    auditRows: [],
    ...overrides,
  };
}

function rejects(fn, expression) {
  assert.throws(fn, expression);
}

assert.deepEqual(
  parseRepairArgs(["--payment-id", paymentId]),
  {
    apply: false,
    paymentId,
    expectedEventId: null,
    expectedAmount: null,
    expectedDate: null,
    expectedMethod: null,
  },
);
assert.equal(parseRepairArgs([`--payment-id=${paymentId}`]).paymentId, paymentId);
rejects(() => parseRepairArgs([]), /preview dirigido requiere --payment-id/i);
rejects(() => parseRepairArgs(["--apply"]), /reparacion productiva requiere --payment-id/i);
rejects(() => parseRepairArgs(["--payment-id=8fb0c6c5"]), /UUID completo/i);
rejects(() => parseRepairArgs(["--payment-id=not-a-uuid"]), /UUID completo/i);
rejects(() => parseRepairArgs([`--payment-id=${paymentId},${eventId}`]), /UUID completo/i);
rejects(() => parseRepairArgs([`--payment-id=${paymentId} OR 1=1`]), /UUID completo/i);
rejects(
  () => parseRepairArgs(["--apply", `--payment-id=${paymentId}`]),
  /son obligatorios --expected-amount/i,
);
assert.equal(
  parseRepairArgs([
    "--apply",
    `--payment-id=${paymentId}`,
    `--expected-event-id=${eventId}`,
    "--expected-amount=11340.00",
    "--expected-date=2026-07-11",
    "--expected-method=bank_transfer",
  ]).expectedAmount,
  1_134_000n,
);
assert.equal(decimalToMinorUnits("11340.00"), 1_134_000n);
rejects(() => decimalToMinorUnits("11340.001"), /maximo de dos decimales/i);

assert.equal(validateApplyPreflight(preview(), options()).event.id, eventId);
rejects(() => validateApplyPreflight(preview({ payments: [] }), options()), /Abono no encontrado/i);
rejects(
  () => validateApplyPreflight(preview({ payments: [preview().payments[0], preview().payments[0]] }), options()),
  /Resultado ambiguo/i,
);
rejects(
  () => validateApplyPreflight(preview({
    payments: [{ ...preview().payments[0], voided_at: "2026-07-12T00:00:00Z" }],
  }), options()),
  /anulado/i,
);
rejects(() => validateApplyPreflight(preview(), options({ expectedAmount: 1n })), /importe/i);
rejects(
  () => validateApplyPreflight(preview(), options({ expectedDate: "2026-07-12" })),
  /fecha/i,
);
rejects(
  () => validateApplyPreflight(preview(), options({ expectedMethod: "cash" })),
  /metodo/i,
);
rejects(
  () => validateApplyPreflight(preview(), options({
    expectedEventId: "86000000-1234-4234-9234-1234567890ab",
  })),
  /expected-event-id/i,
);
rejects(() => validateApplyPreflight(preview({ events: [] }), options()), /no existe/i);
rejects(
  () => validateApplyPreflight(preview({ events: [preview().events[0], preview().events[0]] }), options()),
  /multiples eventos/i,
);
rejects(
  () => validateApplyPreflight(preview({
    events: [{ ...preview().events[0], journal_entry_id: journalId }],
    journalEntries: [{ id: journalId }],
  }), options()),
  /ya tiene una partida/i,
);
rejects(
  () => validateApplyPreflight(preview({ possibleManualEntries: [{ id: journalId }] }), options()),
  /manual equivalente/i,
);
rejects(() => validateApplyPreflight(preview({ debitMapping: null }), options()), /payment_method/i);
rejects(() => validateApplyPreflight(preview({ creditMapping: null }), options()), /receivable/i);
rejects(() => validateApplyPreflight(preview({ closedPeriod: true }), options()), /cerrado/i);
assert.doesNotThrow(
  () => validateApplyPreflight(preview({ periods: [], closedPeriod: false }), options()),
  "La ausencia de una fila de periodo no debe bloquear si la fecha no esta cerrada",
);
rejects(
  () => validateApplyPreflight(preview({
    controlEvents: [{
      event_purpose: "receivable_paid",
      status: "ready",
      journal_entry_id: null,
    }],
  }), options()),
  /control receivable_paid/i,
);
rejects(
  () => validateApplyPreflight(preview({
    events: [{ ...preview().events[0], source_snapshot: { event_type: "receivable_paid" } }],
  }), options()),
  /receivable_paid esta excluido/i,
);

const post = preview({
  events: [{ ...preview().events[0], status: "draft_created", journal_entry_id: journalId }],
  outbox: [{ id: "87000000-1234-4234-9234-1234567890ab", status: "completed", last_error: null }],
  journalEntries: [{
    id: journalId,
    status: "borrador",
    entry_date: "2026-07-11",
    posted_at: null,
    posted_by: null,
  }],
  journalLines: [
    { debit: "11340.00", credit: "0.00" },
    { debit: "0.00", credit: "11340.00" },
  ],
});
assert.deepEqual(assertPostRepair(preview(), post), {
  existing_event_reused: true,
  payment_unchanged: true,
  outbox_completed: true,
  journal_entry_id: journalId,
  journal_status: "borrador",
  published: false,
  total_debits_minor: "1134000",
  total_credits_minor: "1134000",
  difference_minor: "0",
});

const report = scopedPublicReport(preview());
assert.equal(report.scope, "SINGLE_RECEIVABLE_PAYMENT");
assert.equal(report.selected_records, 1);
assert.equal(report.payment.id, "8fb0c6c5...");
assert.equal(report.repair.proposed_writes.financial_events, 0);
assert.equal(report.repair.proposed_writes.published_entries, 0);
assert.equal(report.safety.global_collection, false);

const scopedSource = await readFile(
  "scripts/accounting/scoped-receivable-payment-repair.mjs",
  "utf8",
);
const repairSource = await readFile(
  "scripts/accounting/repair-missing-receivable-payment-events.mjs",
  "utf8",
);
assert.match(scopedSource, /from\("accounts_receivable_payments"\)[\s\S]*\.eq\("id", paymentId\)/);
assert.doesNotMatch(scopedSource, /readAll|recoverablePayments|collectReceivablePaymentAccountingPreview/);
assert.doesNotMatch(repairSource, /for\s*\(const payment of|recoverablePayments/);
assert.match(repairSource, /RECEIVABLE_PAYMENT_REPAIR_CONFIRM/);
assert.match(repairSource, /process_receivable_payment_accounting_outbox_v1/);
assert.match(repairSource, /create_journal_draft_from_financial_event/);
assert.doesNotMatch(repairSource, /post_journal_entry/);

console.log("Scoped receivable-payment repair checks passed.");
