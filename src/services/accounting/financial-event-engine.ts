import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getInvoiceFinancialEventCandidates } from "@/services/accounting/adapters/invoice-financial-events";
import { getOrderFinancialEventCandidates } from "@/services/accounting/adapters/order-financial-events";
import { getPaymentFinancialEventCandidates } from "@/services/accounting/adapters/payment-financial-events";
import { getReceivableFinancialEventCandidates } from "@/services/accounting/adapters/receivable-financial-events";
import type { AccountingMappingType, AutomationMode, FinancialEventStatus } from "@/types/financial-center";

export type FinancialEventPurpose =
  | "sale_revenue"
  | "payment_received"
  | "invoice_issued"
  | "commercial_credit"
  | "receivable_payment"
  | "order_cancellation";

export type FinancialEventSourceType =
  | "order"
  | "payment"
  | "invoice"
  | "commercial_credit"
  | "receivable_payment";

export type FinancialEventCandidate = {
  eventType:
    | "order_confirmed"
    | "payment_received"
    | "invoice_issued"
    | "commercial_credit_created"
    | "receivable_payment_received"
    | "order_cancelled";
  source_type: FinancialEventSourceType;
  source_id: string;
  event_purpose: FinancialEventPurpose;
  posting_version?: string;
  occurred_at: string;
  amount: number | null;
  taxAmount?: number | null;
  paymentMethod?: string | null;
  customerName?: string | null;
  sourceNumber?: string | null;
  eligible: boolean;
  source_snapshot: Record<string, unknown>;
  validation_errors?: string[];
};

export type FinancialEventScanSummary = {
  ok: boolean;
  message: string;
  automationMode: AutomationMode;
  candidates: number;
  inserted: number;
  updated: number;
  skippedDuplicate: number;
  failed: number;
  ready: number;
  pending: number;
  skipped: number;
};

type MappingLookup = Map<string, boolean>;

type FinancialEventRow = {
  id: string;
  status: FinancialEventStatus;
  journal_entry_id: string | null;
};

const automationModes = new Set<AutomationMode>(["disabled", "dry_run", "draft_only", "auto_post"]);
const dryRunStatuses = new Set<FinancialEventStatus>(["pending", "ready", "failed", "skipped"]);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normalizeAutomationMode(value: unknown): AutomationMode {
  const mode = asRecord(value).mode;
  return typeof mode === "string" && automationModes.has(mode as AutomationMode) ? (mode as AutomationMode) : "disabled";
}

function mappingKey(mappingType: AccountingMappingType, sourceKey: string) {
  return `${mappingType}:${sourceKey}`;
}

function hasMapping(lookup: MappingLookup, mappingType: AccountingMappingType, sourceKey: string) {
  return lookup.get(mappingKey(mappingType, sourceKey)) === true;
}

function buildMappingLookup(rows: Array<{ mapping_type: AccountingMappingType; source_key: string; accounting_accounts: { is_active: boolean } | null }>) {
  const lookup: MappingLookup = new Map();
  for (const row of rows) {
    lookup.set(mappingKey(row.mapping_type, row.source_key), Boolean(row.accounting_accounts?.is_active));
  }
  return lookup;
}

function requiredMappingsForCandidate(candidate: FinancialEventCandidate) {
  const requirements: Array<{ mappingType: AccountingMappingType; sourceKey: string; label: string }> = [];
  const taxAmount = Number(candidate.taxAmount ?? 0);
  const paymentMethod = String(candidate.paymentMethod ?? "").trim().toLowerCase();
  const usesReceivable = candidate.event_purpose === "commercial_credit" || paymentMethod === "commercial_credit";

  if (["sale_revenue", "invoice_issued", "commercial_credit", "order_cancellation"].includes(candidate.event_purpose)) {
    requirements.push({ mappingType: "revenue", sourceKey: "sales_revenue", label: "Ingresos por ventas" });
  }

  if (["sale_revenue", "invoice_issued", "commercial_credit", "order_cancellation"].includes(candidate.event_purpose) && taxAmount > 0) {
    requirements.push({ mappingType: "tax", sourceKey: "tax_payable", label: "Impuestos por pagar" });
  }

  if (usesReceivable || candidate.event_purpose === "receivable_payment") {
    requirements.push({ mappingType: "receivable", sourceKey: "accounts_receivable", label: "Cuenta por cobrar" });
  }

  if (["payment_received", "receivable_payment"].includes(candidate.event_purpose) && paymentMethod) {
    requirements.push({ mappingType: "payment_method", sourceKey: paymentMethod, label: `Método de pago: ${paymentMethod}` });
  }

  if (candidate.event_purpose === "sale_revenue" && paymentMethod && !usesReceivable) {
    requirements.push({ mappingType: "payment_method", sourceKey: paymentMethod, label: `Método de pago: ${paymentMethod}` });
  }

  return requirements;
}

function resolveCandidateStatus(candidate: FinancialEventCandidate, mappings: MappingLookup, automationMode: AutomationMode) {
  const validationErrors = [...(candidate.validation_errors ?? [])];
  const amount = Number(candidate.amount ?? 0);

  if (!candidate.source_id.trim()) {
    validationErrors.push("El origen no tiene identificador válido.");
  }

  if (candidate.amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
    validationErrors.push("El monto del origen no es válido.");
  }

  if (!candidate.eligible) {
    return { status: "skipped" as const, validationErrors };
  }

  if (validationErrors.length > 0) {
    return { status: "failed" as const, validationErrors };
  }

  if (automationMode === "disabled") {
    validationErrors.push("Modo de automatización desactivado; evento registrado solo por escaneo manual.");
    return { status: "pending" as const, validationErrors };
  }

  if (automationMode === "auto_post") {
    validationErrors.push("El modo auto_post no está permitido en Fase 2B.");
    return { status: "pending" as const, validationErrors };
  }

  for (const requirement of requiredMappingsForCandidate(candidate)) {
    if (!hasMapping(mappings, requirement.mappingType, requirement.sourceKey)) {
      validationErrors.push(`Mapeo faltante o inactivo: ${requirement.label}.`);
    }
  }

  return {
    status: validationErrors.length > 0 ? ("pending" as const) : ("ready" as const),
    validationErrors,
  };
}

async function getAutomationMode(): Promise<AutomationMode> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("accounting_automation_settings")
    .select("value")
    .eq("key", "automation_mode")
    .maybeSingle<{ value: unknown }>();

  if (error) {
    throw new Error(error.message);
  }

  return normalizeAutomationMode(data?.value);
}

async function getActiveMappingLookup() {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("accounting_mappings")
    .select("mapping_type, source_key, accounting_accounts!inner(is_active)")
    .eq("is_active", true)
    .returns<Array<{ mapping_type: AccountingMappingType; source_key: string; accounting_accounts: { is_active: boolean } | null }>>();

  if (error) {
    throw new Error(error.message);
  }

  return buildMappingLookup(data ?? []);
}

async function collectCandidates() {
  const [orders, payments, invoices, receivables] = await Promise.all([
    getOrderFinancialEventCandidates(),
    getPaymentFinancialEventCandidates(),
    getInvoiceFinancialEventCandidates(),
    getReceivableFinancialEventCandidates(),
  ]);

  return [...orders, ...payments, ...invoices, ...receivables];
}

async function registerCandidate(candidate: FinancialEventCandidate, mappings: MappingLookup, automationMode: AutomationMode, createdBy: string) {
  const supabase = await getSupabaseServerClient();
  const postingVersion = candidate.posting_version ?? "v1";
  const statusResult = resolveCandidateStatus(candidate, mappings, automationMode);
  const snapshot = {
    ...candidate.source_snapshot,
    event_type: candidate.eventType,
    amount: candidate.amount,
    customer_name: candidate.customerName ?? null,
    source_number: candidate.sourceNumber ?? null,
  };

  const { data: existing, error: existingError } = await supabase
    .from("financial_events")
    .select("id, status, journal_entry_id")
    .eq("source_type", candidate.source_type)
    .eq("source_id", candidate.source_id)
    .eq("event_purpose", candidate.event_purpose)
    .eq("posting_version", postingVersion)
    .maybeSingle<FinancialEventRow>();

  if (existingError) {
    throw new Error(existingError.message);
  }

  const payload = {
    source_type: candidate.source_type,
    source_id: candidate.source_id,
    event_purpose: candidate.event_purpose,
    posting_version: postingVersion,
    status: statusResult.status,
    occurred_at: candidate.occurred_at,
    source_snapshot: snapshot,
    validation_errors: statusResult.validationErrors,
    journal_entry_id: null,
    created_by: createdBy,
  };

  if (existing) {
    if (dryRunStatuses.has(existing.status) && !existing.journal_entry_id) {
      const { error: updateError } = await supabase
        .from("financial_events")
        .update({
          status: payload.status,
          occurred_at: payload.occurred_at,
          source_snapshot: payload.source_snapshot,
          validation_errors: payload.validation_errors,
        })
        .eq("id", existing.id);

      if (updateError) {
        throw new Error(updateError.message);
      }

      return { result: "skipped_duplicate" as const, status: payload.status, updated: true };
    }

    return { result: "skipped_duplicate" as const, status: existing.status, updated: false };
  }

  const { error: insertError } = await supabase.from("financial_events").insert(payload);
  if (insertError) {
    if (insertError.code === "23505") {
      return { result: "skipped_duplicate" as const, status: payload.status, updated: false };
    }

    throw new Error(insertError.message);
  }

  return { result: "inserted" as const, status: payload.status, updated: false };
}

export async function scanFinancialEventsDryRun(createdBy: string): Promise<FinancialEventScanSummary> {
  const [automationMode, mappings, candidates] = await Promise.all([
    getAutomationMode(),
    getActiveMappingLookup(),
    collectCandidates(),
  ]);

  const summary: FinancialEventScanSummary = {
    ok: true,
    message: "Escaneo de eventos financieros completado.",
    automationMode,
    candidates: candidates.length,
    inserted: 0,
    updated: 0,
    skippedDuplicate: 0,
    failed: 0,
    ready: 0,
    pending: 0,
    skipped: 0,
  };

  for (const candidate of candidates) {
    const registered = await registerCandidate(candidate, mappings, automationMode, createdBy);
    if (registered.result === "inserted") {
      summary.inserted += 1;
    } else {
      summary.skippedDuplicate += 1;
      if (registered.updated) {
        summary.updated += 1;
      }
    }

    if (registered.status === "ready") summary.ready += 1;
    if (registered.status === "pending") summary.pending += 1;
    if (registered.status === "failed") summary.failed += 1;
    if (registered.status === "skipped") summary.skipped += 1;
  }

  if (candidates.length === 0) {
    summary.message = "Escaneo completado: no se encontraron eventos financieros elegibles.";
  }

  return summary;
}
