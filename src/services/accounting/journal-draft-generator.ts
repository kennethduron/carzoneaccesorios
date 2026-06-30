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
  | "commercial_credit_cancelled"
  | "receivable_payment"
  | "invoice_issued"
  | "invoice_cancelled"
  | "receivable_paid"
  | "order_cancellation"
  | "inventory_cogs"
  | "inventory_return"
  | "inventory_adjustment_gain"
  | "inventory_adjustment_loss"
  | "inventory_writeoff";

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

type InventoryMappingRow = {
  id: string;
  mapping_type: AccountingMappingType;
  source_key: string;
  priority: number;
  is_active: boolean;
  effective_from: string | null;
  effective_to: string | null;
  accounting_accounts: ResolvedAccountingAccount | null;
};

type InventoryDraftDefinition = {
  amount: number;
  debitKey: string;
  creditKey: string;
  debitLabel: string;
  creditLabel: string;
  description: string;
  missingCostMessage: string;
  missingMappingMessage: string;
};

type ResolvedInventoryAccounts = {
  ok: true;
  requirements: MappingRequirement[];
  accounts: Map<string, ResolvedAccountingAccount>;
} | {
  ok: false;
  message: string;
  validationErrors: string[];
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
  "commercial_credit_cancelled",
  "receivable_payment",
  "invoice_issued",
  "invoice_cancelled",
  "receivable_paid",
  "order_cancellation",
  "inventory_cogs",
  "inventory_return",
  "inventory_adjustment_gain",
  "inventory_adjustment_loss",
  "inventory_writeoff",
]);

const invoiceSkippedMessage = "La factura fue registrada como evento financiero, pero no requiere partida adicional en esta fase.";
const receivablePaidSkippedMessage = "La cuenta por cobrar pagada se registra como control; el cobro se contabiliza por eventos de abono para evitar duplicados.";
const invoiceCancellationPendingMessage = "La anulación fiscal requiere revisión contable antes de generar reversos.";
const creditCancellationPendingMessage = "La cancelación del crédito comercial requiere revisión contable antes de generar reversos.";
const cancellationPendingMessage = "La cancelación requiere reglas de reverso en una fase posterior.";
const missingMappingsMessage = "No se puede generar la partida porque faltan mapeos contables.";
const cogsMissingMappingsMessage = "Faltan mapeos contables para inventario o costo de ventas.";
const inventoryAdjustmentMissingMappingsMessage = "Faltan mapeos contables para inventario o ajustes de inventario.";
const cogsInactiveAccountMessage = "La cuenta contable configurada para inventario o costo de ventas está inactiva.";
const inventoryInactiveAccountMessage = "La cuenta contable configurada para inventario o ajustes de inventario está inactiva.";
const cogsMissingHistoricalCostMessage = "No se puede generar la partida porque falta el costo histórico del producto.";
const returnMissingHistoricalCostMessage = "No se puede generar la partida de devolución porque falta el costo histórico original.";
const movementMissingCostMessage = "No se puede calcular el valor contable del movimiento porque falta el costo del producto.";
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

function snapshotTotalCostAmount(snapshot: Record<string, unknown>) {
  return toAmount(snapshot.total_cost_snapshot);
}

function snapshotTax(snapshot: Record<string, unknown>) {
  return toAmount(snapshot.tax ?? snapshot.tax_amount);
}

function sourceNumber(snapshot: Record<string, unknown>, event: FinancialEventForDraft) {
  return (
    cleanText(snapshot.source_number) ||
    cleanText(snapshot.order_number) ||
    cleanText(snapshot.invoice_number) ||
    cleanText(snapshot.inventory_movement_id) ||
    event.source_id
  );
}

function requirement(mappingType: AccountingMappingType, sourceKey: string, label: string): MappingRequirement {
  return { mappingType, sourceKey, label };
}

function mappingKey(mappingType: AccountingMappingType, sourceKey: string) {
  return `${mappingType}:${sourceKey.trim().toLowerCase()}`;
}

function inventoryAccountLabel(sourceKey: string) {
  const labels: Record<string, string> = {
    inventory_asset: "Inventario",
    cost_of_goods_sold: "Costo de ventas",
    inventory_return: "Devoluciones de inventario",
    inventory_adjustment_gain: "Ganancia por ajuste de inventario",
    inventory_adjustment_loss: "Pérdida por ajuste de inventario",
    inventory_writeoff: "Inventario dado de baja",
  };

  return labels[sourceKey] ?? sourceKey;
}

function isEffectiveMapping(row: InventoryMappingRow, today: string) {
  if (row.effective_from && row.effective_from > today) return false;
  if (row.effective_to && row.effective_to < today) return false;
  return true;
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
    errors.push("La partida debe tener al menos dos líneas contables.");
  }

  for (const line of lines) {
    if (!line.account_id) errors.push("Cada línea debe tener una cuenta contable activa.");
    if (line.debit > 0 && line.credit > 0) errors.push("Una línea no puede tener débito y crédito al mismo tiempo.");
    if (line.debit <= 0 && line.credit <= 0) errors.push("Cada línea debe tener débito o crédito mayor que cero.");
  }

  const totalDebit = toAmount(lines.reduce((sum, line) => sum + line.debit, 0));
  const totalCredit = toAmount(lines.reduce((sum, line) => sum + line.credit, 0));
  if (totalDebit <= 0 || totalCredit <= 0 || totalDebit !== totalCredit) {
    errors.push("La partida debe estar cuadrada: total débito igual a total crédito.");
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

async function resolveInventoryAccounts(sourceKeys: string[], missingMessage: string, inactiveMessage: string, client?: SupabaseClient): Promise<ResolvedInventoryAccounts> {
  const uniqueSourceKeys = [...new Set(sourceKeys)];
  const requirements = uniqueSourceKeys.map((sourceKey) => requirement("inventory", sourceKey, inventoryAccountLabel(sourceKey)));
  const supabase = client ?? (await getSupabaseServerClient());
  const { data, error } = await supabase
    .from("accounting_mappings")
    .select(
      `
      id,
      mapping_type,
      source_key,
      priority,
      is_active,
      effective_from,
      effective_to,
      accounting_accounts(id, code, name, type, is_active)
    `,
    )
    .eq("mapping_type", "inventory")
    .in("source_key", uniqueSourceKeys)
    .eq("is_active", true)
    .order("priority", { ascending: true })
    .returns<InventoryMappingRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const rows = data ?? [];
  const accounts = new Map<string, ResolvedAccountingAccount>();

  for (const required of requirements) {
    const row = rows.find(
      (candidate) =>
        mappingKey(candidate.mapping_type, candidate.source_key) === mappingKey(required.mappingType, required.sourceKey) &&
        isEffectiveMapping(candidate, today),
    );

    if (!row?.accounting_accounts) {
      return { ok: false, message: missingMessage, validationErrors: [missingMessage] };
    }

    if (!row.accounting_accounts.is_active) {
      return { ok: false, message: inactiveMessage, validationErrors: [inactiveMessage] };
    }

    accounts.set(mappingKey(required.mappingType, required.sourceKey), row.accounting_accounts);
  }

  return {
    ok: true,
    requirements,
    accounts,
  };
}

function inventoryDraftDefinition(purpose: FinancialEventPurpose, totalCost: number, number: string): InventoryDraftDefinition | null {
  if (purpose === "inventory_cogs") {
    return {
      amount: totalCost,
      debitKey: "cost_of_goods_sold",
      creditKey: "inventory_asset",
      debitLabel: "Costo de ventas por salida de inventario",
      creditLabel: "Salida contable de inventario",
      description: `Costo de ventas por movimiento de inventario ${number}`,
      missingCostMessage: cogsMissingHistoricalCostMessage,
      missingMappingMessage: cogsMissingMappingsMessage,
    };
  }

  if (purpose === "inventory_return") {
    return {
      amount: totalCost,
      debitKey: "inventory_asset",
      creditKey: "inventory_return",
      debitLabel: "Devolución de inventario",
      creditLabel: "Reverso de costo de ventas por devolución",
      description: `Devolución de inventario ${number}`,
      missingCostMessage: returnMissingHistoricalCostMessage,
      missingMappingMessage: inventoryAdjustmentMissingMappingsMessage,
    };
  }

  if (purpose === "inventory_adjustment_gain") {
    return {
      amount: totalCost,
      debitKey: "inventory_asset",
      creditKey: "inventory_adjustment_gain",
      debitLabel: "Ajuste positivo de inventario",
      creditLabel: "Ganancia por ajuste de inventario",
      description: `Ajuste positivo de inventario ${number}`,
      missingCostMessage: movementMissingCostMessage,
      missingMappingMessage: inventoryAdjustmentMissingMappingsMessage,
    };
  }

  if (purpose === "inventory_adjustment_loss") {
    return {
      amount: totalCost,
      debitKey: "inventory_adjustment_loss",
      creditKey: "inventory_asset",
      debitLabel: "Ajuste negativo de inventario",
      creditLabel: "Salida por ajuste negativo de inventario",
      description: `Ajuste negativo de inventario ${number}`,
      missingCostMessage: movementMissingCostMessage,
      missingMappingMessage: inventoryAdjustmentMissingMappingsMessage,
    };
  }

  if (purpose === "inventory_writeoff") {
    return {
      amount: totalCost,
      debitKey: "inventory_writeoff",
      creditKey: "inventory_asset",
      debitLabel: "Inventario dado de baja",
      creditLabel: "Merma de inventario",
      description: `Inventario dado de baja ${number}`,
      missingCostMessage: movementMissingCostMessage,
      missingMappingMessage: inventoryAdjustmentMissingMappingsMessage,
    };
  }

  return null;
}

async function buildInventoryMovementDraft(event: FinancialEventForDraft, purpose: FinancialEventPurpose, snapshot: Record<string, unknown>, number: string, entryDate: string, client?: SupabaseClient): Promise<DraftBuildResult> {
  const definition = inventoryDraftDefinition(purpose, snapshotTotalCostAmount(snapshot), number);
  if (!definition) {
    return {
      ok: false,
      status: "failed",
      message: "Este tipo de evento financiero no está soportado para generar borradores.",
      validationErrors: ["Este tipo de evento financiero no está soportado para generar borradores."],
    };
  }

  if (!Number.isFinite(definition.amount) || definition.amount <= 0) {
    return {
      ok: false,
      status: purpose === "inventory_cogs" ? "failed" : "pending",
      message: definition.missingCostMessage,
      validationErrors: [definition.missingCostMessage],
    };
  }

  const resolved = await resolveInventoryAccounts(
    [definition.debitKey, definition.creditKey],
    definition.missingMappingMessage,
    purpose === "inventory_cogs" ? cogsInactiveAccountMessage : inventoryInactiveAccountMessage,
    client,
  );
  if (!resolved.ok) {
    return {
      ok: false,
      status: "pending",
      message: resolved.message,
      validationErrors: resolved.validationErrors,
    };
  }

  const debitAccount = resolved.accounts.get(mappingKey("inventory", definition.debitKey));
  const creditAccount = resolved.accounts.get(mappingKey("inventory", definition.creditKey));
  if (!debitAccount || !creditAccount) {
    return {
      ok: false,
      status: "pending",
      message: definition.missingMappingMessage,
      validationErrors: [definition.missingMappingMessage],
    };
  }

  const lines = [
    accountLine(debitAccount, definition.amount, 0, definition.debitLabel),
    accountLine(creditAccount, 0, definition.amount, definition.creditLabel),
  ];
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
    description: definition.description,
    entryDate,
    lines,
    requirements: resolved.requirements,
  };
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

  if (
    purpose === "inventory_cogs" ||
    purpose === "inventory_return" ||
    purpose === "inventory_adjustment_gain" ||
    purpose === "inventory_adjustment_loss" ||
    purpose === "inventory_writeoff"
  ) {
    return buildInventoryMovementDraft(event, purpose, snapshot, number, entryDate, client);
  }

  if (purpose === "invoice_issued") {
    return {
      ok: false,
      status: "skipped",
      message: invoiceSkippedMessage,
      validationErrors: [invoiceSkippedMessage],
    };
  }

  if (purpose === "receivable_paid") {
    return {
      ok: false,
      status: "skipped",
      message: receivablePaidSkippedMessage,
      validationErrors: [receivablePaidSkippedMessage],
    };
  }

  if (purpose === "invoice_cancelled") {
    return {
      ok: false,
      status: "pending",
      message: invoiceCancellationPendingMessage,
      validationErrors: [invoiceCancellationPendingMessage],
    };
  }

  if (purpose === "commercial_credit_cancelled") {
    return {
      ok: false,
      status: "pending",
      message: creditCancellationPendingMessage,
      validationErrors: [creditCancellationPendingMessage],
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
      message: "No se puede generar la partida porque el monto del evento no es válido.",
      validationErrors: ["El monto del evento financiero no es válido."],
    };
  }

  const requirements: MappingRequirement[] = [];
  if (purpose === "sale_revenue") {
    requirements.push(requirement("revenue", "sales_revenue", "Ingresos por ventas"));
    requirements.push(
      paymentMethod && paymentMethod !== "commercial_credit"
        ? requirement("payment_method", paymentMethod, `Método de pago: ${paymentMethod}`)
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
    requirements.push(requirement("payment_method", paymentMethod, `Método de pago: ${paymentMethod || "no definido"}`));
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

    lines.push(accountLine(receivableAccount, amount, 0, `Crédito comercial ${number}`));
    lines.push(accountLine(revenueAccount, 0, revenue, `Ingreso por crédito comercial ${number}`));
    if (tax > 0 && taxAccount) {
      lines.push(accountLine(taxAccount, 0, tax, `Impuesto por crédito comercial ${number}`));
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
    lines.push(accountLine(receivableAccount, 0, amount, `Aplicación a cuenta por cobrar ${number}`));
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
    return { ok: false, message: "Este tipo de evento financiero no está soportado para generar borradores." };
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
  }, supabase);
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
