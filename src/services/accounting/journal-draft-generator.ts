import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { writeAuditLog } from "@/lib/audit";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import {
  type MappingRequirement,
  resolveAccountingMappings,
  type ResolvedAccountingAccount,
} from "@/services/accounting/accounting-mapping-resolver";
import type { AccountingMappingType, FinancialEventStatus } from "@/types/financial-center";

export type JournalDraftGenerationResult = {
  ok: boolean;
  message: string;
  journalEntryId?: string;
  status?: FinancialEventStatus;
  validationErrors?: string[];
};

type FinancialEventPurpose =
  | "sale_revenue"
  | "payment_received"
  | "commercial_credit"
  | "receivable_payment"
  | "invoice_issued"
  | "order_cancellation";

type FinancialEventForDraft = {
  id: string;
  source_type: string;
  source_id: string;
  event_purpose: string;
  posting_version: string;
  status: FinancialEventStatus;
  occurred_at: string;
  source_snapshot: unknown;
  validation_errors: unknown;
  journal_entry_id: string | null;
};

type ExistingJournalEntry = {
  id: string;
  status: string;
};

type DraftLine = {
  account_id: string;
  debit: number;
  credit: number;
  description: string;
};

type DraftBuildResult =
  | {
      ok: true;
      description: string;
      entryDate: string;
      lines: DraftLine[];
      requirements: MappingRequirement[];
    }
  | {
      ok: false;
      status: FinancialEventStatus;
      message: string;
      validationErrors: string[];
    };

const supportedPurposes = new Set<FinancialEventPurpose>([
  "sale_revenue",
  "payment_received",
  "commercial_credit",
  "receivable_payment",
  "invoice_issued",
  "order_cancellation",
]);

const invoiceSkippedMessage = "La factura fue registrada como evento financiero, pero no requiere partida adicional en esta fase.";
const cancellationPendingMessage = "La cancelacion requiere reglas de reverso en una fase posterior.";
const missingMappingsMessage = "No se puede generar la partida porque faltan mapeos contables.";
const duplicateDraftMessage = "Este evento ya tiene una partida en borrador asociada.";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toAmount(value: unknown) {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount)) return 0;
  return Math.round(amount * 100) / 100;
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function eventDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa" }).format(new Date());
  }

  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa" }).format(date);
}

function nextEntryNumber() {
  const dateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replaceAll("-", "");
  const suffix = Date.now().toString().slice(-6);
  return `PC-${dateKey}-${suffix}`;
}

function normalizePaymentMethod(value: unknown) {
  const method = cleanText(value).toLowerCase();
  if (method === "transferencia" || method === "transferencia_bancaria" || method === "bank") return "bank_transfer";
  if (method === "tarjeta" || method === "card_link") return "card";
  if (method === "efectivo") return "cash";
  return method;
}

function snapshotAmount(snapshot: Record<string, unknown>) {
  return toAmount(snapshot.amount ?? snapshot.total ?? snapshot.original_amount);
}

function snapshotTax(snapshot: Record<string, unknown>) {
  return toAmount(snapshot.tax ?? snapshot.tax_amount);
}

function sourceNumber(snapshot: Record<string, unknown>, event: FinancialEventForDraft) {
  return (
    cleanText(snapshot.source_number) ||
    cleanText(snapshot.order_number) ||
    cleanText(snapshot.invoice_number) ||
    event.source_id
  );
}

function requirement(mappingType: AccountingMappingType, sourceKey: string, label: string): MappingRequirement {
  return { mappingType, sourceKey, label };
}

function accountLine(account: ResolvedAccountingAccount, debit: number, credit: number, description: string): DraftLine {
  return {
    account_id: account.id,
    debit: toAmount(debit),
    credit: toAmount(credit),
    description,
  };
}

function validateLines(lines: DraftLine[]) {
  const errors: string[] = [];
  if (lines.length < 2) {
    errors.push("La partida debe tener al menos dos lineas contables.");
  }

  for (const line of lines) {
    if (!line.account_id) errors.push("Cada linea debe tener una cuenta contable activa.");
    if (line.debit > 0 && line.credit > 0) errors.push("Una linea no puede tener debito y credito al mismo tiempo.");
    if (line.debit <= 0 && line.credit <= 0) errors.push("Cada linea debe tener debito o credito mayor que cero.");
  }

  const totalDebit = toAmount(lines.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = toAmount(lines.reduce((sum, line) => sum + line.credit, 0));
  if (totalDebit <= 0 || totalCredit <= 0 || totalDebit !== totalCredit) {
    errors.push("La partida debe estar cuadrada: total debito igual a total credito.");
  }

  return errors;
}

async function logAccountingEvent(input: {
  eventType: string;
  entityType: string;
  entityId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  metadata?: Record<string, unknown>;
  createdBy?: string | null;
}, client?: SupabaseClient) {
  const supabase = client ?? (await getSupabaseServerClient());
  await supabase.from("accounting_event_log").insert({
    event_type: input.eventType,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    source_type: input.sourceType ?? null,
    source_id: input.sourceId ?? null,
    metadata: input.metadata ?? {},
    created_by: input.createdBy ?? null,
  });
}

async function updateFinancialEventStatus(
  eventId: string,
  status: FinancialEventStatus,
  validationErrors: string[],
  journalEntryId?: string | null,
  client?: SupabaseClient,
) {
  const supabase = client ?? (await getSupabaseServerClient());
  const payload: Record<string, unknown> = {
    status,
    validation_errors: validationErrors,
  };

  if (journalEntryId !== undefined) {
    payload.journal_entry_id = journalEntryId;
  }

  const { error } = await supabase.from("financial_events").update(payload).eq("id", eventId);
  if (error) {
    throw new Error(error.message);
  }
}

async function findExistingDraft(event: FinancialEventForDraft, client?: SupabaseClient) {
  const supabase = client ?? (await getSupabaseServerClient());

  if (event.journal_entry_id) {
    const { data, error } = await supabase
      .from("journal_entries")
      .select("id, status")
      .eq("id", event.journal_entry_id)
      .maybeSingle<ExistingJournalEntry>();

    if (error) {
      throw new Error(error.message);
    }

    if (data) return data;
  }

  const { data, error } = await supabase
    .from("journal_entries")
    .select("id, status")
    .eq("source_type", "financial_event")
    .eq("source_id", event.id)
    .maybeSingle<ExistingJournalEntry>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? null;
}

async function buildDraft(event: FinancialEventForDraft, client?: SupabaseClient): Promise<DraftBuildResult> {
  const snapshot = asRecord(event.source_snapshot);
  const purpose = event.event_purpose as FinancialEventPurpose;
  const amount = snapshotAmount(snapshot);
  const tax = snapshotTax(snapshot);
  const revenue = toAmount(amount - tax);
  const paymentMethod = normalizePaymentMethod(snapshot.payment_method);
  const number = sourceNumber(snapshot, event);
  const entryDate = eventDate(event.occurred_at);

  if (purpose === "invoice_issued") {
    return {
      ok: false,
      status: "skipped",
      message: invoiceSkippedMessage,
      validationErrors: [invoiceSkippedMessage],
    };
  }

  if (purpose === "order_cancellation") {
    return {
      ok: false,
      status: "pending",
      message: cancellationPendingMessage,
      validationErrors: [cancellationPendingMessage],
    };
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      status: "failed",
      message: "No se puede generar la partida porque el monto del evento no es valido.",
      validationErrors: ["El monto del evento financiero no es valido."],
    };
  }

  const requirements: MappingRequirement[] = [];
  if (purpose === "sale_revenue") {
    requirements.push(requirement("revenue", "sales_revenue", "Ingresos por ventas"));
    requirements.push(
      paymentMethod && paymentMethod !== "commercial_credit"
        ? requirement("payment_method", paymentMethod, `Metodo de pago: ${paymentMethod}`)
        : requirement("receivable", "accounts_receivable", "Cuenta por cobrar"),
    );
    if (tax > 0) requirements.push(requirement("tax", "tax_payable", "Impuestos por pagar"));
  }

  if (purpose === "commercial_credit") {
    requirements.push(requirement("receivable", "accounts_receivable", "Cuenta por cobrar"));
    requirements.push(requirement("revenue", "sales_revenue", "Ingresos por ventas"));
    if (tax > 0) requirements.push(requirement("tax", "tax_payable", "Impuestos por pagar"));
  }

  if (purpose === "payment_received" || purpose === "receivable_payment") {
    requirements.push(requirement("payment_method", paymentMethod, `Metodo de pago: ${paymentMethod || "no definido"}`));
    requirements.push(requirement("receivable", "accounts_receivable", "Cuenta por cobrar"));
  }

  const resolved = await resolveAccountingMappings(requirements, client);
  if (resolved.missing.length > 0) {
    return {
      ok: false,
      status: "pending",
      message: missingMappingsMessage,
      validationErrors: [missingMappingsMessage, ...resolved.missing.map((item) => `Mapeo faltante o inactivo: ${item}.`)],
    };
  }

  const lines: DraftLine[] = [];
  const receivableAccount = resolved.getAccount("receivable", "accounts_receivable");
  const revenueAccount = resolved.getAccount("revenue", "sales_revenue");
  const taxAccount = resolved.getAccount("tax", "tax_payable");
  const paymentAccount = paymentMethod ? resolved.getAccount("payment_method", paymentMethod) : null;

  if (purpose === "sale_revenue") {
    const debitAccount = paymentMethod && paymentMethod !== "commercial_credit" ? paymentAccount : receivableAccount;
    if (!debitAccount || !revenueAccount || (tax > 0 && !taxAccount)) {
      return {
        ok: false,
        status: "pending",
        message: missingMappingsMessage,
        validationErrors: [missingMappingsMessage],
      };
    }

    lines.push(accountLine(debitAccount, amount, 0, `Venta ${number}`));
    lines.push(accountLine(revenueAccount, 0, revenue, `Ingreso por venta ${number}`));
    if (tax > 0 && taxAccount) {
      lines.push(accountLine(taxAccount, 0, tax, `Impuesto por venta ${number}`));
    }
  }

  if (purpose === "commercial_credit") {
    if (!receivableAccount || !revenueAccount || (tax > 0 && !taxAccount)) {
      return {
        ok: false,
        status: "pending",
        message: missingMappingsMessage,
        validationErrors: [missingMappingsMessage],
      };
    }

    lines.push(accountLine(receivableAccount, amount, 0, `Credito comercial ${number}`));
    lines.push(accountLine(revenueAccount, 0, revenue, `Ingreso por credito comercial ${number}`));
    if (tax > 0 && taxAccount) {
      lines.push(accountLine(taxAccount, 0, tax, `Impuesto por credito comercial ${number}`));
    }
  }

  if (purpose === "payment_received" || purpose === "receivable_payment") {
    if (!paymentAccount || !receivableAccount) {
      return {
        ok: false,
        status: "pending",
        message: missingMappingsMessage,
        validationErrors: [missingMappingsMessage],
      };
    }

    const paymentLabel = purpose === "receivable_payment" ? "Abono a cuenta por cobrar" : "Pago recibido";
    lines.push(accountLine(paymentAccount, amount, 0, `${paymentLabel} ${number}`));
    lines.push(accountLine(receivableAccount, 0, amount, `Aplicacion a cuenta por cobrar ${number}`));
  }

  const lineErrors = validateLines(lines);
  if (lineErrors.length > 0) {
    return {
      ok: false,
      status: "failed",
      message: lineErrors[0],
      validationErrors: lineErrors,
    };
  }

  return {
    ok: true,
    description: `Borrador generado desde evento financiero ${number}`,
    entryDate,
    lines,
    requirements,
  };
}

export async function generateJournalDraftFromFinancialEvent(
  eventId: string,
  createdBy: string | null,
  client?: SupabaseClient,
): Promise<JournalDraftGenerationResult> {
  const supabase = client ?? (await getSupabaseServerClient());
  const { data: event, error } = await supabase
    .from("financial_events")
    .select("id, source_type, source_id, event_purpose, posting_version, status, occurred_at, source_snapshot, validation_errors, journal_entry_id")
    .eq("id", eventId)
    .maybeSingle<FinancialEventForDraft>();

  if (error) {
    return { ok: false, message: error.message };
  }

  if (!event) {
    return { ok: false, message: "El evento financiero no existe." };
  }

  if (!supportedPurposes.has(event.event_purpose as FinancialEventPurpose)) {
    return { ok: false, message: "Este tipo de evento financiero no esta soportado para generar borradores." };
  }

  const existingDraft = await findExistingDraft(event, supabase);
  if (existingDraft) {
    if (!event.journal_entry_id) {
      await updateFinancialEventStatus(event.id, existingDraft.status === "borrador" ? "draft_created" : event.status, [], existingDraft.id, supabase);
    }

    return {
      ok: false,
      message: existingDraft.status === "borrador" ? duplicateDraftMessage : "Este evento ya tiene una partida contable asociada.",
      journalEntryId: existingDraft.id,
      status: existingDraft.status === "borrador" ? "draft_created" : event.status,
    };
  }

  const draft = await buildDraft(event, supabase);
  if (!draft.ok) {
    await updateFinancialEventStatus(event.id, draft.status, draft.validationErrors, undefined, supabase);
    await logAccountingEvent({
      eventType: "financial_event.draft_validation",
      entityType: "financial_events",
      entityId: event.id,
      sourceType: event.source_type,
      sourceId: event.source_id,
      metadata: {
        status: draft.status,
        message: draft.message,
        validation_errors: draft.validationErrors,
      },
      createdBy,
    }, supabase);

    return {
      ok: false,
      message: draft.message,
      status: draft.status,
      validationErrors: draft.validationErrors,
    };
  }

  const { data: entry, error: entryError } = await supabase
    .from("journal_entries")
    .insert({
      entry_number: nextEntryNumber(),
      entry_date: draft.entryDate,
      description: draft.description,
      status: "borrador",
      source_type: "financial_event",
      source_id: event.id,
      created_by: createdBy,
    })
    .select("id")
    .single<{ id: string }>();

  if (entryError) {
    if (entryError.code === "23505") {
      return { ok: false, message: duplicateDraftMessage };
    }

    return { ok: false, message: entryError.message };
  }

  const { error: linesError } = await supabase.from("journal_entry_lines").insert(
    draft.lines.map((line) => ({
      journal_entry_id: entry.id,
      ...line,
    })),
  );

  if (linesError) {
    await supabase.from("journal_entries").delete().eq("id", entry.id).eq("status", "borrador");
    await updateFinancialEventStatus(event.id, "failed", [linesError.message], undefined, supabase);
    return { ok: false, message: linesError.message, status: "failed", validationErrors: [linesError.message] };
  }

  await updateFinancialEventStatus(event.id, "draft_created", [], entry.id, supabase);

  await writeAuditLog({
    tableName: "journal_entries",
    recordId: entry.id,
    action: "accounting.journal_draft.generated_from_financial_event",
    newData: {
      financial_event_id: event.id,
      source_type: event.source_type,
      source_id: event.source_id,
      event_purpose: event.event_purpose,
      lines: draft.lines.length,
      status: "borrador",
    },
  });
  await logAccountingEvent({
    eventType: "journal_draft.generated_from_financial_event",
    entityType: "journal_entries",
    entityId: entry.id,
    sourceType: "financial_event",
    sourceId: event.id,
    metadata: {
      event_purpose: event.event_purpose,
      posting_version: event.posting_version,
      lines: draft.lines.length,
      status: "borrador",
    },
    createdBy,
  }, supabase);

  return {
    ok: true,
    message: "Partida en borrador creada correctamente.",
    journalEntryId: entry.id,
    status: "draft_created",
  };
}
