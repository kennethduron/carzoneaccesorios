import "server-only";

import { writeErrorLog } from "@/lib/error-logging";
import { getSupabaseAdminClient } from "@/lib/supabase";
import {
  getAccountingAutomationMode,
  getActiveAccountingMappingLookup,
  registerFinancialEventCandidate,
  type FinancialEventCandidate,
  type FinancialEventPurpose,
  type FinancialEventSourceType,
} from "@/services/accounting/financial-event-engine";
import { getPurchaseFinancialEventCandidates } from "@/services/accounting/adapters/purchase-financial-events";
import { generateJournalDraftFromFinancialEvent } from "@/services/accounting/journal-draft-generator";

export type DispatchAccountingEventInput = {
  sourceType: FinancialEventSourceType;
  sourceId: string;
  eventPurpose: FinancialEventPurpose;
  occurredAt?: string | Date | null;
  triggeredBy?: string | null;
  route?: string | null;
};

export type DispatchAccountingEventResult = {
  ok: boolean;
  skipped: boolean;
  message: string;
  eventId?: string | null;
  draftCreated?: boolean;
};

type OrderEventRow = {
  id: string;
  order_number: string | null;
  customer_id: string | null;
  customer_name: string | null;
  payment_method: string | null;
  subtotal: unknown;
  tax: unknown;
  shipping_fee: unknown;
  shipping_total: unknown;
  cash_on_delivery_fee: unknown;
  small_order_fee: unknown;
  discount_total: unknown;
  total: unknown;
  status: string | null;
  created_at: string;
  updated_at: string | null;
  invoices?: Array<{ invoice_number: string | null; status: string | null }> | null;
};


type InvoiceEventRow = {
  id: string;
  invoice_number: string | null;
  order_id: string | null;
  customer_id: string | null;
  customer_name: string | null;
  status: string | null;
  subtotal: unknown;
  tax: unknown;
  total: unknown;
  issued_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string | null;
  orders: { order_number: string | null; customer_name: string | null; payment_method: string | null } | null;
};
type PaymentEventRow = {
  id: string;
  order_id: string;
  customer_id: string | null;
  payment_method: string | null;
  payment_status: string | null;
  amount: unknown;
  paid_at: string | null;
  created_at: string;
  orders: { order_number: string | null; customer_name: string | null } | null;
};

type ReceivableEventRow = {
  id: string;
  customer_id: string;
  order_id: string;
  invoice_id: string | null;
  original_amount: unknown;
  balance_due: unknown;
  due_date: string | null;
  status: string | null;
  created_at: string;
  updated_at: string | null;
  paid_at?: string | null;
  payment_received_method?: string | null;
  customers: { contact_name: string | null; business_name: string | null } | null;
  orders: { order_number: string | null; payment_method: string | null; tax: unknown } | null;
  invoices: { invoice_number: string | null } | null;
};

type ReceivablePaymentEventRow = {
  id: string;
  receivable_id: string;
  customer_id: string;
  order_id: string;
  amount: unknown;
  payment_method: string | null;
  received_at: string | null;
  voided_at: string | null;
  created_at: string;
  customers: { contact_name: string | null; business_name: string | null } | null;
  orders: { order_number: string | null } | null;
};

const confirmedOrderStatuses = new Set(["confirmado", "confirmed", "paid", "preparacion", "preparing", "empacado", "enviado", "en_ruta", "entregado", "shipped", "delivered"]);
const cancelledOrderStatuses = new Set(["cancelado", "cancelled"]);
const receivedPaymentStatuses = new Set(["approved", "confirmed", "paid"]);
const issuedInvoiceStatuses = new Set(["emitida", "issued", "paid"]);
const cancelledInvoiceStatuses = new Set(["anulada", "cancelled"]);
const draftEligiblePurposes = new Set<FinancialEventPurpose>(["sale_revenue", "payment_received", "commercial_credit", "receivable_payment", "inventory_cogs", "accounts_payable_created", "supplier_payment", "purchase_return", "supplier_credit"]);

function toNumber(value: unknown) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) / 100 : 0;
}

function toIso(value: string | Date | null | undefined, fallback: string | null | undefined) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === "string" && value.trim()) return value;
  return fallback || new Date().toISOString();
}

function customerName(customer: { contact_name: string | null; business_name: string | null } | null) {
  return customer?.business_name || customer?.contact_name || null;
}

function activeInvoiceNumber(invoices: OrderEventRow["invoices"]) {
  const rows = Array.isArray(invoices) ? invoices : [];
  return rows.find((invoice) => invoice.invoice_number && !["anulada", "cancelled"].includes(String(invoice.status ?? "")))?.invoice_number ?? null;
}

async function logAccountingDispatchFailure(input: DispatchAccountingEventInput, error: unknown) {
  const message = error instanceof Error ? error.message : "Accounting event dispatch failed.";
  const stack = error instanceof Error ? error.stack : null;

  await writeErrorLog({
    route: input.route ?? "/admin/contabilidad",
    action: "accounting.auto_event_dispatch_failed",
    errorMessage: message,
    errorStack: stack,
    metadata: {
      source_type: input.sourceType,
      source_id: input.sourceId,
      event_purpose: input.eventPurpose,
    },
  });

  try {
    const admin = getSupabaseAdminClient();
    await admin.from("accounting_event_log").insert({
      event_type: "financial_event.dispatch_failed",
      entity_type: "financial_events",
      entity_id: null,
      source_type: input.sourceType,
      source_id: input.sourceId,
      metadata: {
        event_purpose: input.eventPurpose,
        message,
      },
      created_by: input.triggeredBy ?? null,
    });
  } catch (logError) {
    console.error("Accounting dispatch failure log failed", logError);
  }
}

async function buildOrderCandidate(input: DispatchAccountingEventInput): Promise<FinancialEventCandidate | null> {
  const admin = getSupabaseAdminClient();
  const { data: row, error } = await admin
    .from("orders")
    .select("id, order_number, customer_id, customer_name, payment_method, subtotal, tax, shipping_fee, shipping_total, cash_on_delivery_fee, small_order_fee, discount_total, total, status, created_at, updated_at, invoices(invoice_number, status)")
    .eq("id", input.sourceId)
    .maybeSingle<OrderEventRow>();

  if (error) throw new Error(error.message);
  if (!row) return null;

  const status = String(row.status ?? "");
  const amount = toNumber(row.total);
  const eventType = input.eventPurpose === "order_cancellation" ? "order_cancelled" : "order_confirmed";
  const eligible = input.eventPurpose === "order_cancellation" ? cancelledOrderStatuses.has(status) : confirmedOrderStatuses.has(status);

  return {
    eventType,
    source_type: "order",
    source_id: row.id,
    event_purpose: input.eventPurpose,
    posting_version: "v1",
    occurred_at: toIso(input.occurredAt, row.updated_at ?? row.created_at),
    amount,
    taxAmount: toNumber(row.tax),
    paymentMethod: row.payment_method,
    customerName: row.customer_name,
    sourceNumber: row.order_number,
    eligible,
    validation_errors: eligible ? [] : ["El pedido no esta en un estado elegible para este evento contable."],
    source_snapshot: {
      source_id: row.id,
      order_number: row.order_number,
      invoice_number: activeInvoiceNumber(row.invoices),
      payment_method: row.payment_method,
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      subtotal: toNumber(row.subtotal),
      tax_amount: toNumber(row.tax),
      shipping: toNumber(row.shipping_fee ?? row.shipping_total),
      cash_on_delivery_fee: toNumber(row.cash_on_delivery_fee),
      small_order_fee: toNumber(row.small_order_fee),
      discount: toNumber(row.discount_total),
      total: amount,
      status,
      occurred_at: toIso(input.occurredAt, row.updated_at ?? row.created_at),
      currency: "HNL",
    },
  };
}

async function buildInvoiceCandidate(input: DispatchAccountingEventInput): Promise<FinancialEventCandidate | null> {
  const admin = getSupabaseAdminClient();
  const { data: row, error } = await admin
    .from("invoices")
    .select("id, invoice_number, order_id, customer_id, customer_name, status, subtotal, tax, total, issued_at, cancelled_at, created_at, updated_at, orders(order_number, customer_name, payment_method)")
    .eq("id", input.sourceId)
    .maybeSingle<InvoiceEventRow>();

  if (error) throw new Error(error.message);
  if (!row) return null;

  const status = String(row.status ?? "");
  const amount = toNumber(row.total);
  const isCancelled = input.eventPurpose === "invoice_cancelled";
  const name = row.customer_name ?? row.orders?.customer_name ?? null;
  const occurredAt = isCancelled ? toIso(input.occurredAt, row.cancelled_at ?? row.updated_at ?? row.created_at) : toIso(input.occurredAt, row.issued_at ?? row.created_at);

  return {
    eventType: isCancelled ? "invoice_cancelled" : "invoice_issued",
    source_type: "invoice",
    source_id: row.id,
    event_purpose: isCancelled ? "invoice_cancelled" : "invoice_issued",
    posting_version: "v1",
    occurred_at: occurredAt,
    amount,
    taxAmount: toNumber(row.tax),
    paymentMethod: row.orders?.payment_method ?? null,
    customerName: name,
    sourceNumber: row.invoice_number ?? row.id,
    eligible: isCancelled ? cancelledInvoiceStatuses.has(status) : issuedInvoiceStatuses.has(status),
    validation_errors: isCancelled
      ? ["La anulación fiscal requiere revisión contable antes de generar reversos."]
      : ["La factura fiscal fue registrada como evento, pero no requiere partida adicional en esta fase para evitar duplicar ingresos."],
    source_snapshot: {
      source_id: row.id,
      invoice_id: row.id,
      invoice_number: row.invoice_number,
      order_id: row.order_id,
      order_number: row.orders?.order_number ?? null,
      payment_method: row.orders?.payment_method ?? null,
      customer_id: row.customer_id,
      customer_name: name,
      subtotal: toNumber(row.subtotal),
      tax_amount: toNumber(row.tax),
      total: amount,
      status,
      occurred_at: occurredAt,
      currency: "HNL",
    },
  };
}
async function buildPaymentCandidate(input: DispatchAccountingEventInput): Promise<FinancialEventCandidate | null> {
  const admin = getSupabaseAdminClient();
  const { data: row, error } = await admin
    .from("payments")
    .select("id, order_id, customer_id, payment_method, payment_status, amount, paid_at, created_at, orders(order_number, customer_name)")
    .eq("id", input.sourceId)
    .maybeSingle<PaymentEventRow>();

  if (error) throw new Error(error.message);
  if (!row) return null;

  const status = String(row.payment_status ?? "");
  const amount = toNumber(row.amount);

  return {
    eventType: "payment_received",
    source_type: "payment",
    source_id: row.id,
    event_purpose: "payment_received",
    posting_version: "v1",
    occurred_at: toIso(input.occurredAt, row.paid_at ?? row.created_at),
    amount,
    paymentMethod: row.payment_method,
    customerName: row.orders?.customer_name ?? null,
    sourceNumber: row.orders?.order_number ?? row.id,
    eligible: receivedPaymentStatuses.has(status),
    validation_errors: receivedPaymentStatuses.has(status) ? [] : ["El pago no esta aprobado o recibido."],
    source_snapshot: {
      source_id: row.id,
      order_id: row.order_id,
      order_number: row.orders?.order_number ?? null,
      payment_method: row.payment_method,
      customer_id: row.customer_id,
      customer_name: row.orders?.customer_name ?? null,
      total: amount,
      status,
      occurred_at: toIso(input.occurredAt, row.paid_at ?? row.created_at),
      currency: "HNL",
    },
  };
}

async function buildCommercialCreditCandidate(input: DispatchAccountingEventInput): Promise<FinancialEventCandidate | null> {
  const admin = getSupabaseAdminClient();
  const { data: row, error } = await admin
    .from("accounts_receivable")
    .select("id, customer_id, order_id, invoice_id, original_amount, balance_due, due_date, status, paid_at, payment_received_method, created_at, updated_at, customers(contact_name, business_name), orders(order_number, payment_method, tax), invoices(invoice_number)")
    .eq("id", input.sourceId)
    .maybeSingle<ReceivableEventRow>();

  if (error) throw new Error(error.message);
  if (!row) return null;

  const name = customerName(row.customers);
  const amount = toNumber(row.original_amount);
  const status = String(row.status ?? "");
  const isCancelled = input.eventPurpose === "commercial_credit_cancelled";
  const occurredAt = toIso(input.occurredAt, isCancelled ? row.updated_at ?? row.created_at : row.created_at);

  return {
    eventType: isCancelled ? "commercial_credit_cancelled" : "commercial_credit_created",
    source_type: "commercial_credit",
    source_id: row.id,
    event_purpose: isCancelled ? "commercial_credit_cancelled" : "commercial_credit",
    posting_version: "v1",
    occurred_at: occurredAt,
    amount,
    taxAmount: toNumber(row.orders?.tax),
    paymentMethod: row.orders?.payment_method ?? "commercial_credit",
    customerName: name,
    sourceNumber: row.orders?.order_number ?? row.id,
    eligible: isCancelled ? status === "cancelled" : status !== "cancelled",
    validation_errors: isCancelled
      ? ["La cancelación del crédito comercial requiere revisión contable antes de generar reversos."]
      : status === "cancelled"
        ? ["El crédito comercial está cancelado."]
        : [],
    source_snapshot: {
      source_id: row.id,
      receivable_id: row.id,
      order_id: row.order_id,
      order_number: row.orders?.order_number ?? null,
      invoice_id: row.invoice_id,
      invoice_number: row.invoices?.invoice_number ?? null,
      payment_method: row.orders?.payment_method ?? "commercial_credit",
      customer_id: row.customer_id,
      customer_name: name,
      original_amount: amount,
      total: amount,
      balance_due: toNumber(row.balance_due),
      tax_amount: toNumber(row.orders?.tax),
      due_date: row.due_date,
      status,
      occurred_at: occurredAt,
      currency: "HNL",
    },
  };
}
async function buildReceivablePaidCandidate(input: DispatchAccountingEventInput): Promise<FinancialEventCandidate | null> {
  const admin = getSupabaseAdminClient();
  const { data: row, error } = await admin
    .from("accounts_receivable")
    .select("id, customer_id, order_id, invoice_id, original_amount, balance_due, due_date, status, paid_at, payment_received_method, created_at, updated_at, customers(contact_name, business_name), orders(order_number, payment_method, tax), invoices(invoice_number)")
    .eq("id", input.sourceId)
    .maybeSingle<ReceivableEventRow>();

  if (error) throw new Error(error.message);
  if (!row) return null;

  const name = customerName(row.customers);
  const amount = toNumber(row.original_amount);
  const status = String(row.status ?? "");
  const occurredAt = toIso(input.occurredAt, row.paid_at ?? row.updated_at ?? row.created_at);

  return {
    eventType: "receivable_paid",
    source_type: "accounts_receivable",
    source_id: row.id,
    event_purpose: "receivable_paid",
    posting_version: "v1",
    occurred_at: occurredAt,
    amount,
    taxAmount: toNumber(row.orders?.tax),
    paymentMethod: row.payment_received_method ?? row.orders?.payment_method ?? "commercial_credit",
    customerName: name,
    sourceNumber: row.orders?.order_number ?? row.id,
    eligible: status === "paid",
    validation_errors: ["La cuenta por cobrar pagada se registra como control; el cobro se contabiliza por eventos de abono para evitar duplicados."],
    source_snapshot: {
      source_id: row.id,
      receivable_id: row.id,
      order_id: row.order_id,
      order_number: row.orders?.order_number ?? null,
      invoice_id: row.invoice_id,
      invoice_number: row.invoices?.invoice_number ?? null,
      payment_method: row.payment_received_method ?? row.orders?.payment_method ?? "commercial_credit",
      customer_id: row.customer_id,
      customer_name: name,
      original_amount: amount,
      total: amount,
      balance_due: toNumber(row.balance_due),
      tax_amount: toNumber(row.orders?.tax),
      status,
      occurred_at: occurredAt,
      currency: "HNL",
    },
  };
}
async function buildReceivablePaymentCandidate(input: DispatchAccountingEventInput): Promise<FinancialEventCandidate | null> {
  const admin = getSupabaseAdminClient();
  const { data: row, error } = await admin
    .from("accounts_receivable_payments")
    .select("id, receivable_id, customer_id, order_id, amount, payment_method, received_at, voided_at, created_at, customers(contact_name, business_name), orders(order_number)")
    .eq("id", input.sourceId)
    .maybeSingle<ReceivablePaymentEventRow>();

  if (error) throw new Error(error.message);
  if (!row) return null;

  const name = customerName(row.customers);
  const amount = toNumber(row.amount);
  const occurredAt = toIso(input.occurredAt, row.received_at ?? row.created_at);

  return {
    eventType: "receivable_payment_received",
    source_type: "receivable_payment",
    source_id: row.id,
    event_purpose: "receivable_payment",
    posting_version: "v1",
    occurred_at: occurredAt,
    amount,
    paymentMethod: row.payment_method,
    customerName: name,
    sourceNumber: row.orders?.order_number ?? row.id,
    eligible: !row.voided_at,
    validation_errors: row.voided_at ? ["El abono a cuenta por cobrar está anulado."] : [],
    source_snapshot: {
      source_id: row.id,
      payment_id: row.id,
      receivable_id: row.receivable_id,
      order_id: row.order_id,
      order_number: row.orders?.order_number ?? null,
      payment_method: row.payment_method,
      customer_id: row.customer_id,
      customer_name: name,
      total: amount,
      status: row.voided_at ? "voided" : "received",
      occurred_at: occurredAt,
      currency: "HNL",
    },
  };
}

async function buildCandidate(input: DispatchAccountingEventInput) {
  if (input.sourceType === "order" && (input.eventPurpose === "sale_revenue" || input.eventPurpose === "order_cancellation")) {
    return buildOrderCandidate(input);
  }

  if (input.sourceType === "invoice" && (input.eventPurpose === "invoice_issued" || input.eventPurpose === "invoice_cancelled")) {
    return buildInvoiceCandidate(input);
  }

  if (input.sourceType === "payment" && input.eventPurpose === "payment_received") {
    return buildPaymentCandidate(input);
  }

  if (input.sourceType === "commercial_credit" && (input.eventPurpose === "commercial_credit" || input.eventPurpose === "commercial_credit_cancelled")) {
    return buildCommercialCreditCandidate(input);
  }

  if (input.sourceType === "accounts_receivable" && input.eventPurpose === "receivable_paid") {
    return buildReceivablePaidCandidate(input);
  }

  if (input.sourceType === "receivable_payment" && input.eventPurpose === "receivable_payment") {
    return buildReceivablePaymentCandidate(input);
  }

  if (["purchase", "supplier_invoice", "accounts_payable", "supplier_payment", "purchase_return", "supplier_credit"].includes(input.sourceType)) {
    const candidates = await getPurchaseFinancialEventCandidates(getSupabaseAdminClient());
    return candidates.find(
      (candidate) =>
        candidate.source_type === input.sourceType &&
        candidate.source_id === input.sourceId &&
        candidate.event_purpose === input.eventPurpose,
    ) ?? null;
  }

  return null;
}

async function findRegisteredEventId(input: DispatchAccountingEventInput) {
  const admin = getSupabaseAdminClient();
  const { data } = await admin
    .from("financial_events")
    .select("id")
    .eq("source_type", input.sourceType)
    .eq("source_id", input.sourceId)
    .eq("event_purpose", input.eventPurpose)
    .eq("posting_version", "v1")
    .maybeSingle<{ id: string }>();

  return data?.id ?? null;
}

export async function dispatchAccountingEvent(input: DispatchAccountingEventInput): Promise<DispatchAccountingEventResult> {
  try {
    if (!input.sourceId.trim()) {
      return { ok: true, skipped: true, message: "Origen contable vacio." };
    }

    const admin = getSupabaseAdminClient();
    const automationMode = await getAccountingAutomationMode(admin);
    if (automationMode === "disabled") {
      return { ok: true, skipped: true, message: "Automatización contable desactivada." };
    }

    const [candidate, mappings] = await Promise.all([buildCandidate(input), getActiveAccountingMappingLookup(admin)]);
    if (!candidate) {
      return { ok: true, skipped: true, message: "No hay candidato contable para este origen." };
    }

    const registered = await registerFinancialEventCandidate(candidate, mappings, automationMode, input.triggeredBy ?? null, admin);
    const eventId = registered.eventId ?? (await findRegisteredEventId(input));

    if (automationMode === "draft_only" && eventId && registered.status === "ready" && draftEligiblePurposes.has(input.eventPurpose)) {
      const draft = await generateJournalDraftFromFinancialEvent(eventId, input.triggeredBy ?? null, admin);
      return {
        ok: true,
        skipped: false,
        message: draft.ok ? "Evento financiero y borrador registrados." : "Evento financiero registrado; borrador pendiente de validación.",
        eventId,
        draftCreated: draft.ok,
      };
    }

    return {
      ok: true,
      skipped: false,
      message: "Evento financiero registrado.",
      eventId,
      draftCreated: false,
    };
  } catch (error) {
    await logAccountingDispatchFailure(input, error).catch((logError) => {
      console.error("Accounting dispatch error logging failed", logError);
    });

    return {
      ok: false,
      skipped: true,
      message: "La operacion continuo, pero no se pudo registrar el evento contable.",
    };
  }
}

export async function dispatchPaymentReceivedAccountingEventForOrder(input: {
  orderId: string;
  triggeredBy?: string | null;
  route?: string | null;
}) {
  try {
    const admin = getSupabaseAdminClient();
    const { data: payment, error } = await admin
      .from("payments")
      .select("id")
      .eq("order_id", input.orderId)
      .in("payment_status", ["approved", "confirmed", "paid"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();

    if (error) throw new Error(error.message);
    if (!payment) return { ok: true, skipped: true, message: "No hay pago aprobado para el pedido." };

    return dispatchAccountingEvent({
      sourceType: "payment",
      sourceId: payment.id,
      eventPurpose: "payment_received",
      triggeredBy: input.triggeredBy ?? null,
      route: input.route ?? null,
    });
  } catch (error) {
    await logAccountingDispatchFailure(
      { sourceType: "payment", sourceId: input.orderId, eventPurpose: "payment_received", triggeredBy: input.triggeredBy ?? null, route: input.route ?? null },
      error,
    ).catch((logError) => console.error("Accounting payment dispatch log failed", logError));
    return { ok: false, skipped: true, message: "La operacion continuo, pero no se pudo registrar el evento contable." };
  }
}

export async function dispatchCommercialCreditAccountingEventForOrder(input: {
  orderId: string;
  triggeredBy?: string | null;
  route?: string | null;
}) {
  try {
    const admin = getSupabaseAdminClient();
    const { data: receivable, error } = await admin
      .from("accounts_receivable")
      .select("id")
      .eq("order_id", input.orderId)
      .not("status", "eq", "cancelled")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();

    if (error) throw new Error(error.message);
    if (!receivable) return { ok: true, skipped: true, message: "No hay crédito comercial para el pedido." };

    return dispatchAccountingEvent({
      sourceType: "commercial_credit",
      sourceId: receivable.id,
      eventPurpose: "commercial_credit",
      triggeredBy: input.triggeredBy ?? null,
      route: input.route ?? null,
    });
  } catch (error) {
    await logAccountingDispatchFailure(
      { sourceType: "commercial_credit", sourceId: input.orderId, eventPurpose: "commercial_credit", triggeredBy: input.triggeredBy ?? null, route: input.route ?? null },
      error,
    ).catch((logError) => console.error("Accounting credit dispatch log failed", logError));
    return { ok: false, skipped: true, message: "La operacion continuo, pero no se pudo registrar el evento contable." };
  }
}


export async function dispatchCommercialCreditCancellationAccountingEventForOrder(input: {
  orderId: string;
  triggeredBy?: string | null;
  route?: string | null;
}) {
  try {
    const admin = getSupabaseAdminClient();
    const { data: receivable, error } = await admin
      .from("accounts_receivable")
      .select("id")
      .eq("order_id", input.orderId)
      .eq("status", "cancelled")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();

    if (error) throw new Error(error.message);
    if (!receivable) return { ok: true, skipped: true, message: "No hay crédito comercial cancelado para el pedido." };

    return dispatchAccountingEvent({
      sourceType: "commercial_credit",
      sourceId: receivable.id,
      eventPurpose: "commercial_credit_cancelled",
      triggeredBy: input.triggeredBy ?? null,
      route: input.route ?? null,
    });
  } catch (error) {
    await logAccountingDispatchFailure(
      { sourceType: "commercial_credit", sourceId: input.orderId, eventPurpose: "commercial_credit_cancelled", triggeredBy: input.triggeredBy ?? null, route: input.route ?? null },
      error,
    ).catch((logError) => console.error("Accounting credit cancellation dispatch log failed", logError));
    return { ok: false, skipped: true, message: "La operacion continuo, pero no se pudo registrar el evento contable." };
  }
}
export async function dispatchLatestReceivablePaymentAccountingEvent(input: {
  receivableId: string;
  triggeredBy?: string | null;
  route?: string | null;
}) {
  try {
    const admin = getSupabaseAdminClient();
    const { data: payment, error } = await admin
      .from("accounts_receivable_payments")
      .select("id")
      .eq("receivable_id", input.receivableId)
      .is("voided_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle<{ id: string }>();

    if (error) throw new Error(error.message);
    if (!payment) return { ok: true, skipped: true, message: "No hay abono activo para la cuenta por cobrar." };

    return dispatchAccountingEvent({
      sourceType: "receivable_payment",
      sourceId: payment.id,
      eventPurpose: "receivable_payment",
      triggeredBy: input.triggeredBy ?? null,
      route: input.route ?? null,
    });
  } catch (error) {
    await logAccountingDispatchFailure(
      { sourceType: "receivable_payment", sourceId: input.receivableId, eventPurpose: "receivable_payment", triggeredBy: input.triggeredBy ?? null, route: input.route ?? null },
      error,
    ).catch((logError) => console.error("Accounting receivable payment dispatch log failed", logError));
    return { ok: false, skipped: true, message: "La operacion continuo, pero no se pudo registrar el evento contable." };
  }
}
