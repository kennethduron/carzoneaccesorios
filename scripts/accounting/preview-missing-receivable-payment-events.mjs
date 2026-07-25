import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pageSize = 1000;

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta la variable ${name}.`);
  return value;
}

function serviceClient() {
  return createClient(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

async function readAll(buildQuery) {
  const rows = [];
  for (let start = 0; ; start += pageSize) {
    const { data, error } = await buildQuery().range(start, start + pageSize - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data ?? []).length < pageSize) return rows;
  }
}

async function readOptional(buildQuery) {
  try {
    return await readAll(buildQuery);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("accounting_outbox") && message.includes("schema cache")) return [];
    if (message.includes("does not exist") && message.includes("accounting_outbox")) return [];
    throw error;
  }
}

function hnDate(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function groupCount(rows, keyFor) {
  const result = {};
  for (const row of rows) {
    const key = keyFor(row) || "sin_dato";
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function groupAmount(rows, keyFor) {
  const result = {};
  for (const row of rows) {
    const key = keyFor(row) || "sin_dato";
    result[key] = Math.round(((result[key] ?? 0) + Number(row.amount ?? 0)) * 100) / 100;
  }
  return result;
}

function maskId(value) {
  return typeof value === "string" && value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

function activeMappingKeys(mappings, paymentDate) {
  return new Set(
    mappings
      .filter((mapping) => (
        mapping.is_active
        && mapping.accounting_accounts?.is_active
        && (!mapping.effective_from || mapping.effective_from <= paymentDate)
        && (!mapping.effective_to || mapping.effective_to >= paymentDate)
      ))
      .map((mapping) => `${mapping.mapping_type}:${mapping.source_key}`),
  );
}

function isClosed(periods, date) {
  return periods.some((period) => (
    period.status === "closed"
    && period.start_date <= date
    && period.end_date >= date
  ));
}

export async function collectReceivablePaymentAccountingPreview() {
  const supabase = serviceClient();
  const [payments, events, mappings, periods, manualEntries] = await Promise.all([
    readAll(() => supabase
      .from("accounts_receivable_payments")
      .select("id, receivable_id, customer_id, amount, payment_method, reference, received_at, voided_at")
      .is("voided_at", null)
      .order("received_at", { ascending: true })),
    readAll(() => supabase
      .from("financial_events")
      .select("id, source_id, status, journal_entry_id, occurred_at, validation_errors")
      .eq("source_type", "receivable_payment")
      .eq("event_purpose", "receivable_payment")
      .eq("posting_version", "v1")),
    readAll(() => supabase
      .from("accounting_mappings")
      .select("mapping_type, source_key, is_active, effective_from, effective_to, accounting_accounts(is_active)")
      .in("mapping_type", ["payment_method", "receivable"])),
    readAll(() => supabase
      .from("accounting_periods")
      .select("start_date, end_date, status")
      .order("start_date", { ascending: true })),
    readAll(() => supabase
      .from("journal_entries")
      .select("id, entry_date, description, status")
      .is("source_type", null)
      .order("entry_date", { ascending: true })),
  ]);
  const outbox = await readOptional(() => supabase
    .from("accounting_outbox")
    .select("id, source_id, status, attempts, last_error")
    .eq("source_type", "receivable_payment")
    .eq("event_purpose", "receivable_payment")
    .eq("posting_version", "v1"));

  const manualEntryIds = manualEntries.map((entry) => entry.id);
  const manualLines = manualEntryIds.length > 0
    ? await readAll(() => supabase
        .from("journal_entry_lines")
        .select("journal_entry_id, customer_id, debit, credit")
        .in("journal_entry_id", manualEntryIds))
    : [];
  const manualTotals = new Map();
  for (const line of manualLines) {
    const current = manualTotals.get(line.journal_entry_id) ?? {
      debit: 0,
      credit: 0,
      customerIds: new Set(),
    };
    current.debit += Number(line.debit ?? 0);
    current.credit += Number(line.credit ?? 0);
    if (line.customer_id) current.customerIds.add(line.customer_id);
    manualTotals.set(line.journal_entry_id, current);
  }

  const eventByPayment = new Map(events.map((event) => [event.source_id, event]));
  const outboxByPayment = new Map(outbox.map((row) => [row.source_id, row]));
  const missingPayments = payments.filter((payment) => !eventByPayment.has(payment.id));
  const unlinkedPayments = payments.filter((payment) => !eventByPayment.get(payment.id)?.journal_entry_id);
  const recoverablePayments = payments.filter((payment) => {
    const event = eventByPayment.get(payment.id);
    return !event || (!event.journal_entry_id && !outboxByPayment.has(payment.id));
  });
  const possibleManualByPayment = new Map();

  for (const payment of unlinkedPayments) {
    const date = hnDate(payment.received_at);
    const amount = Math.round(Number(payment.amount) * 100) / 100;
    const candidates = manualEntries.filter((entry) => {
      if (entry.entry_date !== date) return false;
      const totals = manualTotals.get(entry.id);
      if (!totals) return false;
      const exactTotals = Math.round(totals.debit * 100) / 100 === amount
        && Math.round(totals.credit * 100) / 100 === amount;
      const customerMatch = totals.customerIds.size === 0 || totals.customerIds.has(payment.customer_id);
      return exactTotals && customerMatch;
    });
    if (candidates.length > 0) possibleManualByPayment.set(payment.id, candidates);
  }

  const missingMappings = [];
  const closedPeriodPayments = [];
  for (const payment of missingPayments) {
    const date = hnDate(payment.received_at);
    const keys = activeMappingKeys(mappings, date);
    const missing = [
      `payment_method:${payment.payment_method}`,
      "receivable:accounts_receivable",
    ].filter((key) => !keys.has(key));
    if (missing.length > 0) missingMappings.push({ paymentId: payment.id, missing });
    if (isClosed(periods, date)) closedPeriodPayments.push(payment.id);
  }

  return {
    payments,
    events,
    outbox,
    periods,
    mappings,
    missingPayments,
    recoverablePayments,
    possibleManualByPayment,
    missingMappings,
    closedPeriodPayments,
    eventByPayment,
    outboxByPayment,
  };
}

export function publicPreviewReport(preview) {
  const withJournal = preview.events.filter((event) => event.journal_entry_id).length;
  const possibleManual = [...preview.possibleManualByPayment.keys()];
  const missingAmount = preview.missingPayments.reduce(
    (sum, payment) => sum + Number(payment.amount ?? 0),
    0,
  );

  return {
    mode: "READ_ONLY_PREVIEW",
    generated_at: new Date().toISOString(),
    counts: {
      active_payments: preview.payments.length,
      exact_events: preview.events.length,
      missing_events: preview.missingPayments.length,
      recovery_candidates: preview.recoverablePayments.length,
      unlinked_events_without_outbox: preview.recoverablePayments.filter((payment) => (
        preview.eventByPayment.has(payment.id) && !preview.outboxByPayment.has(payment.id)
      )).length,
      exact_events_with_journal: withJournal,
      outbox_rows: preview.outbox.length,
      possible_manual_equivalents: possibleManual.length,
      missing_mapping_payments: preview.missingMappings.length,
      closed_period_payments: preview.closedPeriodPayments.length,
    },
    amounts: {
      missing_total_hnl: Math.round(missingAmount * 100) / 100,
      missing_by_method_hnl: groupAmount(preview.missingPayments, (row) => row.payment_method),
      missing_by_period_hnl: groupAmount(preview.missingPayments, (row) => hnDate(row.received_at).slice(0, 7)),
    },
    distributions: {
      active_payments_by_method: groupCount(preview.payments, (row) => row.payment_method),
      missing_by_method: groupCount(preview.missingPayments, (row) => row.payment_method),
      missing_by_period: groupCount(preview.missingPayments, (row) => hnDate(row.received_at).slice(0, 7)),
      event_statuses: groupCount(preview.events, (row) => row.status),
      outbox_statuses: groupCount(preview.outbox, (row) => row.status),
    },
    missing_mapping_keys: groupCount(
      preview.missingMappings.flatMap((item) => item.missing.map((key) => ({ key }))),
      (row) => row.key,
    ),
    missing_sample: preview.missingPayments.slice(0, 25).map((payment) => ({
      payment_id: maskId(payment.id),
      receivable_id: maskId(payment.receivable_id),
      amount_hnl: Number(payment.amount),
      method: payment.payment_method,
      received_date: hnDate(payment.received_at),
      possible_manual_equivalent: preview.possibleManualByPayment.has(payment.id),
      missing_mappings: preview.missingMappings.find((item) => item.paymentId === payment.id)?.missing ?? [],
      closed_period: preview.closedPeriodPayments.includes(payment.id),
    })),
    pending_event_sample: preview.events
      .filter((event) => event.status === "pending" && !event.journal_entry_id)
      .slice(0, 25)
      .map((event) => {
        const payment = preview.payments.find((row) => row.id === event.source_id);
        if (!payment) {
          return {
            event_id: maskId(event.id),
            payment_id: maskId(event.source_id),
            payment_found: false,
            event_status: event.status,
          };
        }
        const date = hnDate(payment.received_at);
        const keys = activeMappingKeys(preview.mappings, date);
        return {
          event_id: maskId(event.id),
          payment_id: maskId(payment.id),
          receivable_id: maskId(payment.receivable_id),
          amount_hnl: Number(payment.amount),
          method: payment.payment_method,
          received_date: date,
          event_status: event.status,
          journal_entry_id: null,
          outbox_status: preview.outboxByPayment.get(payment.id)?.status ?? null,
          validation_errors: Array.isArray(event.validation_errors)
            ? event.validation_errors.map(String).slice(0, 10)
            : [],
          possible_manual_equivalent: preview.possibleManualByPayment.has(payment.id),
          missing_mappings: [
            `payment_method:${payment.payment_method}`,
            "receivable:accounts_receivable",
          ].filter((key) => !keys.has(key)),
          closed_period: isClosed(preview.periods, date),
        };
      }),
    safety: {
      writes_executed: false,
      pii_masked: true,
      repair_executed: false,
    },
  };
}

async function main() {
  const preview = await collectReceivablePaymentAccountingPreview();
  console.log(JSON.stringify(publicPreviewReport(preview), null, 2));
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
