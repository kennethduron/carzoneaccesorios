import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import {
  type MappingRequirement,
  resolveAccountingMappings,
  type ResolvedAccountingAccount,
} from "@/services/accounting/accounting-mapping-resolver";
import type { AccountingMappingType, FinancialEventStatus } from "@/types/financial-center";
import { buildPurchasePayableJournalLines } from "@/services/accounting/purchase-payable-journal-lines";

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
  | "inventory_writeoff"
  | "purchase_confirmed"
  | "supplier_invoice_received"
  | "accounts_payable_created"
  | "supplier_payment"
  | "supplier_payment_cancelled"
  | "purchase_cancelled"
  | "purchase_return"
  | "supplier_credit";

type FinancialEventForDraft = {
  id: string;
  source_type: string;
  source_id: string;
  event_purpose: string;
  posting_version: string;
  status: FinancialEventStatus;
  occurred_at: string;
  accounting_date: string | null;
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
  "purchase_confirmed",
  "supplier_invoice_received",
  "accounts_payable_created",
  "supplier_payment",
  "supplier_payment_cancelled",
  "purchase_cancelled",
  "purchase_return",
  "supplier_credit",
]);

const invoiceSkippedMessage = "La factura fue registrada como evento financiero, pero no requiere partida adicional para evitar duplicar ingresos.";
const receivablePaidSkippedMessage = "La cuenta por cobrar pagada se registra como control; el cobro se contabiliza por eventos de abono para evitar duplicados.";
const invoiceCancellationPendingMessage = "La anulación fiscal requiere revisión contable antes de generar reversos.";
const creditCancellationPendingMessage = "La cancelación del crédito comercial requiere revisión contable antes de generar reversos.";
const cancellationPendingMessage = "La cancelación requiere revisión contable antes de generar reversos.";
const missingMappingsMessage = "No se puede generar la partida porque faltan mapeos contables.";
const cogsMissingMappingsMessage = "Faltan mapeos contables para inventario o costo de ventas.";
const inventoryAdjustmentMissingMappingsMessage = "Faltan mapeos contables para inventario o ajustes de inventario.";
const cogsInactiveAccountMessage = "La cuenta contable configurada para inventario o costo de ventas está inactiva.";
const inventoryInactiveAccountMessage = "La cuenta contable configurada para inventario o ajustes de inventario está inactiva.";
const cogsMissingHistoricalCostMessage = "No se puede generar la partida porque falta el costo histórico del producto.";
const returnMissingHistoricalCostMessage = "No se puede generar la partida de devolución porque falta el costo histórico original.";
const movementMissingCostMessage = "No se puede calcular el valor contable del movimiento porque falta el costo del producto.";
const duplicateDraftMessage = "Este evento ya tiene una partida en borrador asociada.";
const invalidEventAmountMessage = "No se puede generar la partida porque el monto del evento no es v\u00e1lido.";
const missingPayableAccountMessage = "Falta la cuenta de proveedores por pagar.";
const missingPurchaseMappingsMessage = "Faltan mapeos de compras.";
const missingPurchaseTaxAccountMessage = "Falta la cuenta de impuesto para compras.";
const missingPurchaseDiscountAccountMessage = "Falta la cuenta de descuentos de compras.";
const missingPurchaseShippingAccountMessage = "Falta la cuenta de flete de compras.";
const missingPayableFiscalBreakdownMessage = "La cuenta por pagar no tiene un desglose fiscal verificable. Revisa el documento origen antes de contabilizar.";
const unsupportedPayableCurrencyMessage = "La moneda de la cuenta por pagar no coincide con la moneda contable HNL.";
const missingSupplierPaymentAccountMessage = "Falta la cuenta para pagos a proveedores.";
const inactiveConfiguredAccountMessage = "La cuenta contable configurada est\u00e1 inactiva.";
const purchaseConfirmedControlMessage = "La compra fue confirmada, pero la partida contable se generar\u00e1 desde la cuenta por pagar o factura de proveedor para evitar duplicidad.";
const supplierInvoiceControlMessage = "La factura de proveedor fue registrada, pero la partida contable se generar\u00e1 desde la cuenta por pagar para evitar duplicidad.";
const purchaseCancelledControlMessage = "La anulaci\u00f3n de compra requiere revisi\u00f3n contable antes de generar reversos.";
const supplierPaymentCancelledControlMessage = "La anulaci\u00f3n de pago a proveedor requiere revisi\u00f3n contable antes de generar reversos.";
const closedPeriodMutationMessage = "No se puede registrar o modificar una partida dentro de un período contable cerrado.";

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

async function isDateInClosedAccountingPeriod(entryDate: string, client?: SupabaseClient) {
  const supabase = client ?? (await getSupabaseServerClient());
  const { data, error } = await supabase
    .from("accounting_periods")
    .select("id")
    .eq("status", "closed")
    .lte("start_date", entryDate)
    .gte("end_date", entryDate)
    .limit(1);

  if (error) {
    throw new Error(error.message);
  }

  return (data?.length ?? 0) > 0;
}

function eventDate(value: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa" }).format(new Date());
  }

  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa" }).format(date);
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

function snapshotPayableAmount(snapshot: Record<string, unknown>) {
  return toAmount(snapshot.total_amount ?? snapshot.total);
}

function snapshotSupplierPaymentAmount(snapshot: Record<string, unknown>) {
  return toAmount(snapshot.amount);
}

function snapshotTotalCostAmount(snapshot: Record<string, unknown>) {
  return toAmount(snapshot.total_cost_snapshot);
}

function snapshotTax(snapshot: Record<string, unknown>) {
  return toAmount(snapshot.tax ?? snapshot.tax_amount);
}

function snapshotSubtotal(snapshot: Record<string, unknown>) {
  return toAmount(snapshot.subtotal);
}

function snapshotDiscount(snapshot: Record<string, unknown>) {
  return toAmount(snapshot.discount_amount ?? snapshot.discount);
}

function snapshotShipping(snapshot: Record<string, unknown>) {
  return toAmount(snapshot.shipping_amount ?? snapshot.shipping);
}

function sourceNumber(snapshot: Record<string, unknown>, event: FinancialEventForDraft) {
  return (
    cleanText(snapshot.source_number) ||
    cleanText(snapshot.order_number) ||
    cleanText(snapshot.purchase_number) ||
    cleanText(snapshot.invoice_number) ||
    cleanText(snapshot.accounts_payable_id) ||
    cleanText(snapshot.supplier_payment_id) ||
    cleanText(snapshot.inventory_movement_id) ||
    event.source_id
  );
}

function supplierPaymentMappingKey(value: unknown) {
  const normalized = cleanText(value).toLowerCase();
  if (!normalized) return "";
  if (normalized.startsWith("supplier_payment_")) return normalized;
  if (["cash", "efectivo", "caja"].includes(normalized)) return "supplier_payment_cash";
  if (["card", "tarjeta", "tarjeta de credito", "tarjeta de debito", "card_link"].includes(normalized)) return "supplier_payment_card";
  if (["bank", "bank_transfer", "transferencia", "transferencia_bancaria", "transferencia bancaria", "deposito", "cheque"].includes(normalized)) return "supplier_payment_bank";

  const slug = normalized
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return slug ? `supplier_payment_${slug}` : "";
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

type PurchaseApMappingRow = {
  id: string;
  mapping_type: AccountingMappingType;
  source_key: string;
  priority: number;
  is_active: boolean;
  effective_from: string | null;
  effective_to: string | null;
  accounting_accounts: ResolvedAccountingAccount | null;
};

type PurchaseApResolvedAccount = {
  account: ResolvedAccountingAccount | null;
  inactive: boolean;
};

async function resolvePurchaseApAccount(requirement: MappingRequirement, client?: SupabaseClient): Promise<PurchaseApResolvedAccount> {
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
    .eq("mapping_type", requirement.mappingType)
    .eq("source_key", requirement.sourceKey.trim().toLowerCase())
    .order("priority", { ascending: true })
    .returns<PurchaseApMappingRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const row = (data ?? []).find((candidate) => isEffectiveMapping(candidate, today));

  if (!row) return { account: null, inactive: false };
  if (!row.is_active || !row.accounting_accounts) return { account: null, inactive: false };
  if (!row.accounting_accounts.is_active) return { account: null, inactive: true };

  return { account: row.accounting_accounts, inactive: false };
}

async function requirePurchaseApAccount(requirement: MappingRequirement, missingMessage: string, client?: SupabaseClient) {
  const resolved = await resolvePurchaseApAccount(requirement, client);
  if (resolved.inactive) {
    return { ok: false as const, message: inactiveConfiguredAccountMessage, validationErrors: [inactiveConfiguredAccountMessage] };
  }

  if (!resolved.account) {
    return { ok: false as const, message: missingMessage, validationErrors: [missingMessage] };
  }

  return { ok: true as const, account: resolved.account, requirement };
}

async function optionalPurchaseApAccount(requirement: MappingRequirement, client?: SupabaseClient) {
  const resolved = await resolvePurchaseApAccount(requirement, client);
  if (resolved.inactive) {
    return { ok: false as const, message: inactiveConfiguredAccountMessage, validationErrors: [inactiveConfiguredAccountMessage] };
  }

  return { ok: true as const, account: resolved.account, requirement };
}

async function resolvePurchaseCostAccount(client?: SupabaseClient) {
  const inventoryRequirement = requirement("inventory", "purchase_inventory", "Inventario para compras");
  const expenseRequirement = requirement("default_account", "purchase_expense", "Gasto de compras");
  const inventory = await resolvePurchaseApAccount(inventoryRequirement, client);
  if (inventory.inactive) {
    return { ok: false as const, message: inactiveConfiguredAccountMessage, validationErrors: [inactiveConfiguredAccountMessage] };
  }

  if (inventory.account) {
    return { ok: true as const, account: inventory.account, requirement: inventoryRequirement };
  }

  const expense = await resolvePurchaseApAccount(expenseRequirement, client);
  if (expense.inactive) {
    return { ok: false as const, message: inactiveConfiguredAccountMessage, validationErrors: [inactiveConfiguredAccountMessage] };
  }

  if (expense.account) {
    return { ok: true as const, account: expense.account, requirement: expenseRequirement };
  }

  return { ok: false as const, message: missingPurchaseMappingsMessage, validationErrors: [missingPurchaseMappingsMessage] };
}
function validateLines(lines: DraftLine[]) {
  const errors: string[] = [];
  const signatures = new Set<string>();
  if (lines.length < 2) {
    errors.push("La partida debe tener al menos dos líneas contables.");
  }

  for (const line of lines) {
    if (!line.account_id) errors.push("Cada línea debe tener una cuenta contable activa.");
    if (line.debit > 0 && line.credit > 0) errors.push("Una línea no puede tener débito y crédito al mismo tiempo.");
    if (line.debit <= 0 && line.credit <= 0) errors.push("Cada línea debe tener débito o crédito mayor que cero.");
  }

  for (const line of lines) {
    const signature = [line.account_id, toAmount(line.debit), toAmount(line.credit), cleanText(line.description)].join("|");
    if (signatures.has(signature)) errors.push("La partida no puede contener lineas contables duplicadas.");
    signatures.add(signature);
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

async function buildAccountsPayableCreatedDraft(snapshot: Record<string, unknown>, number: string, entryDate: string, client?: SupabaseClient): Promise<DraftBuildResult> {
  const total = snapshotPayableAmount(snapshot);
  if (!Number.isFinite(total) || total <= 0) {
    return { ok: false, status: "failed", message: invalidEventAmountMessage, validationErrors: [invalidEventAmountMessage] };
  }

  if (cleanText(snapshot.fiscal_breakdown_status) !== "complete") {
    return { ok: false, status: "pending", message: missingPayableFiscalBreakdownMessage, validationErrors: [missingPayableFiscalBreakdownMessage] };
  }

  if (cleanText(snapshot.currency).toUpperCase() !== "HNL") {
    return { ok: false, status: "pending", message: unsupportedPayableCurrencyMessage, validationErrors: [unsupportedPayableCurrencyMessage] };
  }

  const [payable, purchaseCost, purchaseTax, purchaseDiscount, purchaseShipping] = await Promise.all([
    requirePurchaseApAccount(requirement("default_account", "accounts_payable", "Proveedores por pagar"), missingPayableAccountMessage, client),
    resolvePurchaseCostAccount(client),
    optionalPurchaseApAccount(requirement("tax", "purchase_tax", "Impuesto de compras"), client),
    optionalPurchaseApAccount(requirement("discount", "purchase_discount", "Descuento de compras"), client),
    optionalPurchaseApAccount(requirement("shipping", "purchase_shipping", "Flete de compras"), client),
  ]);
  const failed = [payable, purchaseCost, purchaseTax, purchaseDiscount, purchaseShipping].find((result) => !result.ok);
  if (failed && !failed.ok) {
    return { ok: false, status: "pending", message: failed.message, validationErrors: failed.validationErrors };
  }
  if (!payable.ok || !purchaseCost.ok || !purchaseTax.ok || !purchaseDiscount.ok || !purchaseShipping.ok) {
    return { ok: false, status: "pending", message: missingPurchaseMappingsMessage, validationErrors: [missingPurchaseMappingsMessage] };
  }

  const purchaseBase = snapshotSubtotal(snapshot);
  const tax = snapshotTax(snapshot);
  const discount = snapshotDiscount(snapshot);
  const shipping = snapshotShipping(snapshot);
  const taxAccount = tax > 0 ? purchaseTax.account : null;
  const discountAccount = discount > 0 ? purchaseDiscount.account : null;
  const shippingAccount = shipping > 0 ? purchaseShipping.account : null;
  const lineBuild = buildPurchasePayableJournalLines({
    subtotal: purchaseBase,
    taxAmount: tax,
    discountAmount: discount,
    shippingAmount: shipping,
    totalAmount: total,
    costAccountId: purchaseCost.account.id,
    taxAccountId: taxAccount?.id ?? null,
    discountAccountId: discountAccount?.id ?? null,
    shippingAccountId: shippingAccount?.id ?? null,
    payableAccountId: payable.account.id,
  });
  if (!lineBuild.ok) {
    const message = lineBuild.error === "missing_tax_account"
      ? missingPurchaseTaxAccountMessage
      : lineBuild.error === "missing_discount_account"
        ? missingPurchaseDiscountAccountMessage
        : lineBuild.error === "missing_shipping_account"
          ? missingPurchaseShippingAccountMessage
          : lineBuild.error === "missing_cost_account"
            ? missingPurchaseMappingsMessage
            : missingPayableFiscalBreakdownMessage;
    return { ok: false, status: "pending", message, validationErrors: [message] };
  }
  const lines: DraftLine[] = lineBuild.lines;

  const lineErrors = validateLines(lines);
  if (lineErrors.length > 0) {
    return { ok: false, status: "failed", message: lineErrors[0], validationErrors: lineErrors };
  }

  return {
    ok: true,
    description: `Registro de cuenta por pagar a proveedor ${number}`,
    entryDate,
    lines,
    requirements: [payable.requirement, purchaseCost.requirement, taxAccount ? purchaseTax.requirement : null, discountAccount ? purchaseDiscount.requirement : null, shippingAccount ? purchaseShipping.requirement : null].filter((item): item is MappingRequirement => Boolean(item)),
  };
}

async function buildSupplierPaymentDraft(snapshot: Record<string, unknown>, number: string, entryDate: string, client?: SupabaseClient): Promise<DraftBuildResult> {
  const amount = snapshotSupplierPaymentAmount(snapshot);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, status: "failed", message: invalidEventAmountMessage, validationErrors: [invalidEventAmountMessage] };
  }

  const paymentSourceKey = supplierPaymentMappingKey(snapshot.payment_method);
  if (!paymentSourceKey) {
    return { ok: false, status: "pending", message: missingSupplierPaymentAccountMessage, validationErrors: [missingSupplierPaymentAccountMessage] };
  }

  const [payable, payment] = await Promise.all([
    requirePurchaseApAccount(requirement("default_account", "accounts_payable", "Proveedores por pagar"), missingPayableAccountMessage, client),
    requirePurchaseApAccount(requirement("payment_method", paymentSourceKey, `Pago a proveedores: ${paymentSourceKey}`), missingSupplierPaymentAccountMessage, client),
  ]);
  if (!payable.ok) {
    return { ok: false, status: "pending", message: payable.message, validationErrors: payable.validationErrors };
  }
  if (!payment.ok) {
    return { ok: false, status: "pending", message: payment.message, validationErrors: payment.validationErrors };
  }

  const lines = [
    accountLine(payable.account, amount, 0, "Disminuci\u00f3n de cuenta por pagar"),
    accountLine(payment.account, 0, amount, "Salida de efectivo o banco por pago a proveedor"),
  ];
  const lineErrors = validateLines(lines);
  if (lineErrors.length > 0) {
    return { ok: false, status: "failed", message: lineErrors[0], validationErrors: lineErrors };
  }

  return {
    ok: true,
    description: `Pago a proveedor ${number}`,
    entryDate,
    lines,
    requirements: [payable.requirement, payment.requirement],
  };
}


async function buildSupplierPaymentCancellationDraft(event: FinancialEventForDraft, number: string, entryDate: string, client?: SupabaseClient): Promise<DraftBuildResult> {
  const supabase = client ?? (await getSupabaseServerClient());
  const { data: originalEvent, error: eventError } = await supabase
    .from("financial_events")
    .select("id, journal_entry_id")
    .eq("source_type", "supplier_payment")
    .eq("source_id", event.source_id)
    .eq("event_purpose", "supplier_payment")
    .eq("posting_version", event.posting_version)
    .maybeSingle<{ id: string; journal_entry_id: string | null }>();

  if (eventError) throw new Error(eventError.message);
  if (!originalEvent?.journal_entry_id) {
    return { ok: false, status: "pending", message: supplierPaymentCancelledControlMessage, validationErrors: [supplierPaymentCancelledControlMessage] };
  }

  const { data: originalEntry, error: entryError } = await supabase
    .from("journal_entries")
    .select("id, status")
    .eq("id", originalEvent.journal_entry_id)
    .maybeSingle<{ id: string; status: string }>();

  if (entryError) throw new Error(entryError.message);
  if (originalEntry?.status !== "borrador") {
    return { ok: false, status: "pending", message: supplierPaymentCancelledControlMessage, validationErrors: [supplierPaymentCancelledControlMessage] };
  }

  const { data: originalLines, error: linesError } = await supabase
    .from("journal_entry_lines")
    .select("account_id, debit, credit, description")
    .eq("journal_entry_id", originalEntry.id)
    .returns<Array<{ account_id: string; debit: unknown; credit: unknown; description: string | null }>>();

  if (linesError) throw new Error(linesError.message);

  const lines = (originalLines ?? []).map((line) => ({
    account_id: line.account_id,
    debit: toAmount(line.credit),
    credit: toAmount(line.debit),
    description: `Reverso: ${line.description ?? "Pago a proveedor"}`,
  }));
  const lineErrors = validateLines(lines);
  if (lineErrors.length > 0) {
    return { ok: false, status: "failed", message: lineErrors[0], validationErrors: lineErrors };
  }

  return {
    ok: true,
    description: `Reverso de pago a proveedor ${number}`,
    entryDate,
    lines,
    requirements: [],
  };
}
async function firstPurchaseApAccount(requirements: MappingRequirement[], missingMessage: string, client?: SupabaseClient) {
  for (const item of requirements) {
    const resolved = await resolvePurchaseApAccount(item, client);
    if (resolved.inactive) {
      return { ok: false as const, message: inactiveConfiguredAccountMessage, validationErrors: [inactiveConfiguredAccountMessage] };
    }

    if (resolved.account) {
      return { ok: true as const, account: resolved.account, requirement: item };
    }
  }

  return { ok: false as const, message: missingMessage, validationErrors: [missingMessage] };
}

async function buildPurchaseReturnDraft(snapshot: Record<string, unknown>, number: string, entryDate: string, client?: SupabaseClient): Promise<DraftBuildResult> {
  const amount = snapshotAmount(snapshot);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, status: "failed", message: invalidEventAmountMessage, validationErrors: [invalidEventAmountMessage] };
  }

  const linkedPayable = Boolean(cleanText(snapshot.accounts_payable_id));
  const debitRequirements = linkedPayable
    ? [requirement("default_account", "accounts_payable", "Proveedores por pagar"), requirement("default_account", "supplier_credit", "Credito de proveedor")]
    : [requirement("default_account", "supplier_credit", "Credito de proveedor"), requirement("default_account", "accounts_payable", "Proveedores por pagar")];
  const creditRequirements = [
    requirement("default_account", "purchase_return", "Devoluciones de compras"),
    requirement("inventory", "purchase_inventory", "Inventario para compras"),
  ];

  const [debit, credit] = await Promise.all([
    firstPurchaseApAccount(debitRequirements, "Falta la cuenta de proveedores por pagar o credito de proveedor.", client),
    firstPurchaseApAccount(creditRequirements, "Falta la cuenta de devoluciones de compras o inventario para compras.", client),
  ]);

  if (!debit.ok) return { ok: false, status: "pending", message: debit.message, validationErrors: debit.validationErrors };
  if (!credit.ok) return { ok: false, status: "pending", message: credit.message, validationErrors: credit.validationErrors };

  const lines = [
    accountLine(debit.account, amount, 0, linkedPayable ? "Disminucion de cuenta por pagar por devolucion" : "Credito de proveedor por devolucion"),
    accountLine(credit.account, 0, amount, "Devolucion a proveedor"),
  ];
  const lineErrors = validateLines(lines);
  if (lineErrors.length > 0) {
    return { ok: false, status: "failed", message: lineErrors[0], validationErrors: lineErrors };
  }

  return {
    ok: true,
    description: `Devolucion a proveedor ${number}`,
    entryDate,
    lines,
    requirements: [debit.requirement, credit.requirement],
  };
}

async function buildSupplierCreditDraft(snapshot: Record<string, unknown>, number: string, entryDate: string, client?: SupabaseClient): Promise<DraftBuildResult> {
  const amount = snapshotAmount(snapshot);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, status: "failed", message: invalidEventAmountMessage, validationErrors: [invalidEventAmountMessage] };
  }

  const [payable, credit] = await Promise.all([
    requirePurchaseApAccount(requirement("default_account", "accounts_payable", "Proveedores por pagar"), missingPayableAccountMessage, client),
    firstPurchaseApAccount(
      [requirement("default_account", "supplier_credit", "Credito de proveedor"), requirement("default_account", "purchase_return", "Devoluciones de compras")],
      "Falta la cuenta de credito de proveedor o devoluciones de compras.",
      client,
    ),
  ]);

  if (!payable.ok) return { ok: false, status: "pending", message: payable.message, validationErrors: payable.validationErrors };
  if (!credit.ok) return { ok: false, status: "pending", message: credit.message, validationErrors: credit.validationErrors };

  const lines = [
    accountLine(payable.account, amount, 0, "Disminucion de cuenta por pagar por nota de credito"),
    accountLine(credit.account, 0, amount, "Nota de credito de proveedor"),
  ];
  const lineErrors = validateLines(lines);
  if (lineErrors.length > 0) {
    return { ok: false, status: "failed", message: lineErrors[0], validationErrors: lineErrors };
  }

  return {
    ok: true,
    description: `Nota de credito de proveedor ${number}`,
    entryDate,
    lines,
    requirements: [payable.requirement, credit.requirement],
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
  const entryDate = eventDate(event.accounting_date ?? event.occurred_at);

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

  if (purpose === "purchase_confirmed") {
    return { ok: false, status: "pending", message: purchaseConfirmedControlMessage, validationErrors: [purchaseConfirmedControlMessage] };
  }

  if (purpose === "supplier_invoice_received") {
    return { ok: false, status: "pending", message: supplierInvoiceControlMessage, validationErrors: [supplierInvoiceControlMessage] };
  }

  if (purpose === "purchase_cancelled") {
    return { ok: false, status: "pending", message: purchaseCancelledControlMessage, validationErrors: [purchaseCancelledControlMessage] };
  }

  if (purpose === "supplier_payment_cancelled") {
    return buildSupplierPaymentCancellationDraft(event, number, entryDate, client);
  }

  if (purpose === "accounts_payable_created") {
    return buildAccountsPayableCreatedDraft(snapshot, number, entryDate, client);
  }

  if (purpose === "supplier_payment") {
    return buildSupplierPaymentDraft(snapshot, number, entryDate, client);
  }

  if (purpose === "purchase_return") {
    return buildPurchaseReturnDraft(snapshot, number, entryDate, client);
  }

  if (purpose === "supplier_credit") {
    return buildSupplierCreditDraft(snapshot, number, entryDate, client);
  }

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      ok: false,
      status: "failed",
      message: invalidEventAmountMessage,
      validationErrors: [invalidEventAmountMessage],
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

  const resolved = await resolveAccountingMappings(requirements, client, entryDate);
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
  const rpcClient = client ?? (await getSupabaseServerClient());
  const dataClient = getSupabaseAdminClient();
  const { data: event, error } = await dataClient
    .from("financial_events")
    .select("id, source_type, source_id, event_purpose, posting_version, status, occurred_at, accounting_date, source_snapshot, validation_errors, journal_entry_id")
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

  if (
    event.posting_version === "v1"
    && event.source_type === "accounts_payable"
    && event.event_purpose === "accounts_payable_created"
    && Array.isArray(event.validation_errors)
    && event.validation_errors.some((issue: unknown) => String(issue) === "SUPERSEDED_BY_V2")
  ) {
    return {
      ok: false,
      message: "Este reconocimiento de compra pertenece al flujo contable V2 y no admite un segundo borrador V1.",
      status: "skipped",
      validationErrors: ["SUPERSEDED_BY_V2"],
    };
  }

  const existingDraft = await findExistingDraft(event, dataClient);
  if (existingDraft) {
    if (!event.journal_entry_id) {
      await updateFinancialEventStatus(event.id, existingDraft.status === "borrador" ? "draft_created" : event.status, [], existingDraft.id, dataClient);
    }

    return {
      ok: false,
      message: existingDraft.status === "borrador" ? duplicateDraftMessage : "Este evento ya tiene una partida contable asociada.",
      journalEntryId: existingDraft.id,
      status: existingDraft.status === "borrador" ? "draft_created" : event.status,
    };
  }

  const draft = await buildDraft(event, dataClient);
  if (!draft.ok) {
    await updateFinancialEventStatus(event.id, draft.status, draft.validationErrors, undefined, dataClient);
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
    }, dataClient);

    return {
      ok: false,
      message: draft.message,
      status: draft.status,
      validationErrors: draft.validationErrors,
    };
  }

  if (await isDateInClosedAccountingPeriod(draft.entryDate, dataClient)) {
    await updateFinancialEventStatus(event.id, "pending", [closedPeriodMutationMessage], undefined, dataClient);
    await logAccountingEvent({
      eventType: "financial_event.draft_closed_period",
      entityType: "financial_events",
      entityId: event.id,
      sourceType: event.source_type,
      sourceId: event.source_id,
      metadata: {
        entry_date: draft.entryDate,
        message: closedPeriodMutationMessage,
      },
      createdBy,
    }, dataClient);

    return { ok: false, message: closedPeriodMutationMessage, status: "pending", validationErrors: [closedPeriodMutationMessage] };
  }

  const { data: created, error: createError } = await rpcClient.rpc("create_journal_draft_from_financial_event", {
    financial_event_id: event.id,
    entry_date_value: draft.entryDate,
    description_value: draft.description,
    lines_data: draft.lines,
    actor_ip: null,
    actor_user_agent: null,
  });

  if (createError) {
    if (createError.message.includes("SUPERSEDED_BY_V2")) {
      return {
        ok: false,
        message: "Este reconocimiento de compra pertenece al flujo contable V2 y no admite un segundo borrador V1.",
        status: "skipped",
        validationErrors: ["SUPERSEDED_BY_V2"],
      };
    }
    if (createError.code === "23505" || createError.message.includes("ya tiene una partida")) {
      return { ok: false, message: duplicateDraftMessage };
    }
    return { ok: false, message: createError.message };
  }

  const result = created as { journal_entry_id?: string } | null;
  return {
    ok: true,
    message: "Partida en borrador creada correctamente.",
    journalEntryId: result?.journal_entry_id,
    status: "draft_created",
  };
}
