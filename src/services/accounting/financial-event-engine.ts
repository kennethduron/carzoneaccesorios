import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getInvoiceFinancialEventCandidates } from "@/services/accounting/adapters/invoice-financial-events";
import { getInventoryFinancialEventCandidates } from "@/services/accounting/adapters/inventory-financial-events";
import { getOrderFinancialEventCandidates } from "@/services/accounting/adapters/order-financial-events";
import { getPaymentFinancialEventCandidates } from "@/services/accounting/adapters/payment-financial-events";
import { getPurchaseFinancialEventCandidates } from "@/services/accounting/adapters/purchase-financial-events";
import { getReceivableFinancialEventCandidates } from "@/services/accounting/adapters/receivable-financial-events";
import type { AccountingMappingType, AutomationMode, FinancialEventStatus } from "@/types/financial-center";

export type FinancialEventPurpose =
  | "sale_revenue"
  | "payment_received"
  | "invoice_issued"
  | "invoice_cancelled"
  | "commercial_credit"
  | "commercial_credit_cancelled"
  | "receivable_payment"
  | "receivable_paid"
  | "order_cancellation"
  | "inventory_cogs"
  | "inventory_return"
  | "inventory_adjustment_gain"
  | "inventory_adjustment_loss"
  | "inventory_writeoff"
  | "purchase_confirmed"
  | "supplier_invoice_received"
  | "accounts_payable_created"
  | "supplier_payment"
  | "supplier_payment_cancelled"
  | "purchase_cancelled";

export type FinancialEventSourceType =
  | "order"
  | "payment"
  | "invoice"
  | "commercial_credit"
  | "accounts_receivable"
  | "receivable_payment"
  | "inventory_movement"
  | "purchase"
  | "supplier_invoice"
  | "accounts_payable"
  | "supplier_payment";

export type FinancialEventCandidate = {
  eventType:
    | "order_confirmed"
    | "payment_received"
    | "invoice_issued"
    | "invoice_cancelled"
    | "commercial_credit_created"
    | "commercial_credit_cancelled"
    | "receivable_payment_received"
    | "receivable_paid"
    | "order_cancelled"
    | "inventory_sale_movement"
    | "inventory_return_movement"
    | "inventory_adjustment_gain"
    | "inventory_adjustment_loss"
    | "inventory_writeoff"
    | "purchase_confirmed"
    | "supplier_invoice_received"
    | "accounts_payable_created"
    | "supplier_payment"
    | "supplier_payment_cancelled"
    | "purchase_cancelled";
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
const inventoryPurposes = new Set<FinancialEventPurpose>([
  "inventory_cogs",
  "inventory_return",
  "inventory_adjustment_gain",
  "inventory_adjustment_loss",
  "inventory_writeoff",
]);

const purchaseApPurposes = new Set<FinancialEventPurpose>([
  "purchase_confirmed",
  "supplier_invoice_received",
  "accounts_payable_created",
  "supplier_payment",
  "supplier_payment_cancelled",
  "purchase_cancelled",
]);

const purchaseApDraftEligiblePurposes = new Set<FinancialEventPurpose>(["accounts_payable_created", "supplier_payment"]);
const purchaseApControlMessages = new Map<FinancialEventPurpose, string>([
  ["purchase_confirmed", "La compra fue confirmada, pero la partida contable se generar\u00e1 desde la cuenta por pagar o factura de proveedor para evitar duplicidad."],
  ["supplier_invoice_received", "La factura de proveedor fue registrada, pero la partida contable se generar\u00e1 desde la cuenta por pagar para evitar duplicidad."],
  ["purchase_cancelled", "La anulaci\u00f3n de compra requiere revisi\u00f3n contable antes de generar reversos."],
  ["supplier_payment_cancelled", "La anulaci\u00f3n de pago a proveedor requiere revisi\u00f3n contable antes de generar reversos."],
]);

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

  if (["sale_revenue", "commercial_credit", "order_cancellation"].includes(candidate.event_purpose)) {
    requirements.push({ mappingType: "revenue", sourceKey: "sales_revenue", label: "Ingresos por ventas" });
  }

  if (["sale_revenue", "commercial_credit", "order_cancellation"].includes(candidate.event_purpose) && taxAmount > 0) {
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

  if (candidate.event_purpose === "inventory_cogs") {
    requirements.push({ mappingType: "inventory", sourceKey: "inventory_asset", label: "Inventario" });
    requirements.push({ mappingType: "inventory", sourceKey: "cost_of_goods_sold", label: "Costo de ventas" });
  }

  if (candidate.event_purpose === "inventory_return") {
    requirements.push({ mappingType: "inventory", sourceKey: "inventory_asset", label: "Inventario" });
    requirements.push({ mappingType: "inventory", sourceKey: "inventory_return", label: "Devoluciones de inventario" });
  }

  if (candidate.event_purpose === "inventory_adjustment_gain") {
    requirements.push({ mappingType: "inventory", sourceKey: "inventory_asset", label: "Inventario" });
    requirements.push({ mappingType: "inventory", sourceKey: "inventory_adjustment_gain", label: "Ganancia por ajuste de inventario" });
  }

  if (candidate.event_purpose === "inventory_adjustment_loss") {
    requirements.push({ mappingType: "inventory", sourceKey: "inventory_asset", label: "Inventario" });
    requirements.push({ mappingType: "inventory", sourceKey: "inventory_adjustment_loss", label: "Pérdida por ajuste de inventario" });
  }

  if (candidate.event_purpose === "inventory_writeoff") {
    requirements.push({ mappingType: "inventory", sourceKey: "inventory_asset", label: "Inventario" });
    requirements.push({ mappingType: "inventory", sourceKey: "inventory_writeoff", label: "Inventario dado de baja" });
  }

  return requirements;
}

function missingCostMessage(candidate: FinancialEventCandidate) {
  if (candidate.event_purpose === "inventory_cogs") return "No se puede generar la partida porque falta el costo histórico del producto.";
  if (candidate.event_purpose === "inventory_return") return "No se puede generar la partida de devolución porque falta el costo histórico original.";
  return "No se puede calcular el valor contable del movimiento porque falta el costo del producto.";
}

function hasAnyPurchaseCostMapping(mappings: MappingLookup) {
  return hasMapping(mappings, "inventory", "purchase_inventory") || hasMapping(mappings, "default_account", "purchase_expense");
}

function purchaseApMappingValidationErrors(candidate: FinancialEventCandidate, mappings: MappingLookup) {
  const errors: string[] = [];
  const taxAmount = Number(candidate.taxAmount ?? 0);
  const paymentMethod = String(candidate.paymentMethod ?? "").trim().toLowerCase();

  if (candidate.event_purpose === "accounts_payable_created") {
    if (!hasMapping(mappings, "default_account", "accounts_payable")) {
      errors.push("Falta la cuenta de proveedores por pagar.");
    }

    if (!hasAnyPurchaseCostMapping(mappings)) {
      errors.push("Faltan mapeos de compras.");
    }

    if (taxAmount > 0 && !hasMapping(mappings, "tax", "purchase_tax")) {
      errors.push("Falta la cuenta de impuesto para compras.");
    }
  }

  if (candidate.event_purpose === "supplier_payment") {
    if (!hasMapping(mappings, "default_account", "accounts_payable")) {
      errors.push("Falta la cuenta de proveedores por pagar.");
    }

    if (!paymentMethod || !hasMapping(mappings, "payment_method", paymentMethod)) {
      errors.push("Falta la cuenta para pagos a proveedores.");
    }
  }

  return errors;
}

function resolveCandidateStatus(candidate: FinancialEventCandidate, mappings: MappingLookup, automationMode: AutomationMode) {
  const validationErrors = [...(candidate.validation_errors ?? [])];
  const amount = Number(candidate.amount ?? 0);
  const isInventoryPurpose = inventoryPurposes.has(candidate.event_purpose);

  if (!candidate.source_id.trim()) {
    validationErrors.push("El origen no tiene identificador válido.");
  }

  if (isInventoryPurpose && candidate.eligible && (!Number.isFinite(amount) || amount <= 0)) {
    validationErrors.push(missingCostMessage(candidate));
  } else if (candidate.amount !== null && (!Number.isFinite(amount) || amount <= 0)) {
    validationErrors.push("El monto del origen no es válido.");
  }

  if (!candidate.eligible) {
    return { status: "skipped" as const, validationErrors: [...new Set(validationErrors)] };
  }

  if (isInventoryPurpose) {
    const missingInventoryMappings = requiredMappingsForCandidate(candidate).some(
      (requirement) => !hasMapping(mappings, requirement.mappingType, requirement.sourceKey),
    );

    if (missingInventoryMappings) {
      validationErrors.push(candidate.event_purpose === "inventory_cogs" ? "Faltan mapeos contables para inventario o costo de ventas." : "Faltan mapeos contables para inventario o ajustes de inventario.");
    }

    return {
      status: validationErrors.length > 0 ? ("pending" as const) : ("ready" as const),
      validationErrors: [...new Set(validationErrors)],
    };
  }

  if (candidate.event_purpose === "invoice_issued" || candidate.event_purpose === "receivable_paid") {
    return { status: "skipped" as const, validationErrors };
  }

  if (candidate.event_purpose === "invoice_cancelled" || candidate.event_purpose === "commercial_credit_cancelled") {
    return { status: "pending" as const, validationErrors };
  }

  if (purchaseApPurposes.has(candidate.event_purpose)) {
    const controlMessage = purchaseApControlMessages.get(candidate.event_purpose);
    if (controlMessage) {
      validationErrors.push(controlMessage);
      return { status: "pending" as const, validationErrors: [...new Set(validationErrors)] };
    }

    if (purchaseApDraftEligiblePurposes.has(candidate.event_purpose)) {
      validationErrors.push(...purchaseApMappingValidationErrors(candidate, mappings));
      if (automationMode === "disabled") {
        validationErrors.push("Modo de automatizaci\u00f3n desactivado; evento registrado solo por escaneo manual.");
        return { status: "pending" as const, validationErrors: [...new Set(validationErrors)] };
      }

      if (automationMode === "auto_post") {
        validationErrors.push("El modo auto_post no est\u00e1 permitido en esta fase.");
        return { status: "pending" as const, validationErrors: [...new Set(validationErrors)] };
      }

      return {
        status: validationErrors.length > 0 ? ("pending" as const) : ("ready" as const),
        validationErrors: [...new Set(validationErrors)],
      };
    }
  }

  if (validationErrors.length > 0) {
    return { status: "failed" as const, validationErrors };
  }

  if (automationMode === "disabled") {
    validationErrors.push("Modo de automatización desactivado; evento registrado solo por escaneo manual.");
    return { status: "pending" as const, validationErrors };
  }

  if (automationMode === "auto_post") {
    validationErrors.push("El modo auto_post no está permitido en esta fase.");
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

function buildRegisteredSnapshot(candidate: FinancialEventCandidate) {
  if (inventoryPurposes.has(candidate.event_purpose) || purchaseApPurposes.has(candidate.event_purpose)) {
    return candidate.source_snapshot;
  }

  return {
    ...candidate.source_snapshot,
    event_type: candidate.eventType,
    amount: candidate.amount,
    customer_name: candidate.customerName ?? null,
    source_number: candidate.sourceNumber ?? null,
  };
}

export async function getAccountingAutomationMode(client?: SupabaseClient): Promise<AutomationMode> {
  const supabase = client ?? (await getSupabaseServerClient());
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

export async function getActiveAccountingMappingLookup(client?: SupabaseClient) {
  const supabase = client ?? (await getSupabaseServerClient());
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
  const [orders, payments, invoices, receivables, inventory, purchases] = await Promise.all([
    getOrderFinancialEventCandidates(),
    getPaymentFinancialEventCandidates(),
    getInvoiceFinancialEventCandidates(),
    getReceivableFinancialEventCandidates(),
    getInventoryFinancialEventCandidates(),
    getPurchaseFinancialEventCandidates(),
  ]);

  return [...orders, ...payments, ...invoices, ...receivables, ...inventory, ...purchases];
}

export async function registerFinancialEventCandidate(candidate: FinancialEventCandidate, mappings: MappingLookup, automationMode: AutomationMode, createdBy: string | null, client?: SupabaseClient) {
  const supabase = client ?? (await getSupabaseServerClient());
  const postingVersion = candidate.posting_version ?? "v1";
  const statusResult = resolveCandidateStatus(candidate, mappings, automationMode);
  const snapshot = buildRegisteredSnapshot(candidate);

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

      return { result: "skipped_duplicate" as const, status: payload.status, updated: true, eventId: existing.id };
    }

    return { result: "skipped_duplicate" as const, status: existing.status, updated: false, eventId: existing.id };
  }

  const { data: inserted, error: insertError } = await supabase.from("financial_events").insert(payload).select("id").single<{ id: string }>();
  if (insertError) {
    if (insertError.code === "23505") {
      return { result: "skipped_duplicate" as const, status: payload.status, updated: false, eventId: null };
    }

    throw new Error(insertError.message);
  }

  return { result: "inserted" as const, status: payload.status, updated: false, eventId: inserted?.id ?? null };
}

export async function scanFinancialEventsDryRun(createdBy: string): Promise<FinancialEventScanSummary> {
  const [automationMode, mappings, candidates] = await Promise.all([
    getAccountingAutomationMode(),
    getActiveAccountingMappingLookup(),
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
    const registered = await registerFinancialEventCandidate(candidate, mappings, automationMode, createdBy);
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
