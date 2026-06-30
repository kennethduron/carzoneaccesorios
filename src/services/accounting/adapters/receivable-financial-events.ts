import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { FinancialEventCandidate } from "@/services/accounting/financial-event-engine";

type ReceivableEventRow = {
  id: string;
  customer_id: string;
  order_id: string;
  invoice_id: string | null;
  original_amount: unknown;
  balance_due: unknown;
  due_date: string | null;
  status: string;
  paid_at: string | null;
  payment_received_method: string | null;
  created_at: string;
  updated_at: string | null;
  customers: {
    contact_name: string | null;
    business_name: string | null;
  } | null;
  orders: {
    order_number: string | null;
    payment_method: string | null;
    tax: unknown;
  } | null;
  invoices: {
    invoice_number: string | null;
  } | null;
};

type ReceivablePaymentEventRow = {
  id: string;
  receivable_id: string;
  customer_id: string;
  order_id: string;
  amount: unknown;
  payment_method: string;
  received_at: string;
  voided_at: string | null;
  created_at: string;
  customers: {
    contact_name: string | null;
    business_name: string | null;
  } | null;
  orders: {
    order_number: string | null;
  } | null;
};

function toNumber(value: unknown) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) / 100 : 0;
}

function customerName(customer: { contact_name: string | null; business_name: string | null } | null) {
  return customer?.business_name || customer?.contact_name || null;
}

function receivableSnapshot(row: ReceivableEventRow, amount: number, name: string | null, occurredAt: string) {
  return {
    source_id: row.id,
    receivable_id: row.id,
    customer_id: row.customer_id,
    customer_name: name,
    order_id: row.order_id,
    order_number: row.orders?.order_number ?? null,
    invoice_id: row.invoice_id,
    invoice_number: row.invoices?.invoice_number ?? null,
    payment_method: row.payment_received_method ?? row.orders?.payment_method ?? "commercial_credit",
    original_amount: amount,
    total: amount,
    balance_due: toNumber(row.balance_due),
    tax_amount: toNumber(row.orders?.tax),
    due_date: row.due_date,
    status: row.status,
    occurred_at: occurredAt,
    currency: "HNL",
  };
}

async function getCommercialCreditCandidates(): Promise<FinancialEventCandidate[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("accounts_receivable")
    .select("id, customer_id, order_id, invoice_id, original_amount, balance_due, due_date, status, paid_at, payment_received_method, created_at, updated_at, customers(contact_name, business_name), orders(order_number, payment_method, tax), invoices(invoice_number)")
    .not("status", "eq", "cancelled")
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<ReceivableEventRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => {
    const amount = toNumber(row.original_amount);
    const name = customerName(row.customers);
    const occurredAt = row.created_at;
    return {
      eventType: "commercial_credit_created",
      source_type: "commercial_credit",
      source_id: row.id,
      event_purpose: "commercial_credit",
      posting_version: "v1",
      occurred_at: occurredAt,
      amount,
      taxAmount: toNumber(row.orders?.tax),
      paymentMethod: row.orders?.payment_method ?? "commercial_credit",
      customerName: name,
      sourceNumber: row.orders?.order_number ?? row.id,
      eligible: row.status !== "cancelled",
      source_snapshot: receivableSnapshot(row, amount, name, occurredAt),
    };
  });
}

async function getCommercialCreditCancellationCandidates(): Promise<FinancialEventCandidate[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("accounts_receivable")
    .select("id, customer_id, order_id, invoice_id, original_amount, balance_due, due_date, status, paid_at, payment_received_method, created_at, updated_at, customers(contact_name, business_name), orders(order_number, payment_method, tax), invoices(invoice_number)")
    .eq("status", "cancelled")
    .order("updated_at", { ascending: false })
    .limit(500)
    .returns<ReceivableEventRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => {
    const amount = toNumber(row.original_amount);
    const name = customerName(row.customers);
    const occurredAt = row.updated_at ?? row.created_at;
    return {
      eventType: "commercial_credit_cancelled",
      source_type: "commercial_credit",
      source_id: row.id,
      event_purpose: "commercial_credit_cancelled",
      posting_version: "v1",
      occurred_at: occurredAt,
      amount,
      taxAmount: toNumber(row.orders?.tax),
      paymentMethod: row.orders?.payment_method ?? "commercial_credit",
      customerName: name,
      sourceNumber: row.orders?.order_number ?? row.id,
      eligible: row.status === "cancelled",
      validation_errors: ["La cancelacion del credito comercial requiere revision contable antes de generar reversos."],
      source_snapshot: receivableSnapshot(row, amount, name, occurredAt),
    };
  });
}

async function getReceivablePaidCandidates(): Promise<FinancialEventCandidate[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("accounts_receivable")
    .select("id, customer_id, order_id, invoice_id, original_amount, balance_due, due_date, status, paid_at, payment_received_method, created_at, updated_at, customers(contact_name, business_name), orders(order_number, payment_method, tax), invoices(invoice_number)")
    .eq("status", "paid")
    .order("updated_at", { ascending: false })
    .limit(500)
    .returns<ReceivableEventRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => {
    const amount = toNumber(row.original_amount);
    const name = customerName(row.customers);
    const occurredAt = row.paid_at ?? row.updated_at ?? row.created_at;
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
      eligible: row.status === "paid",
      validation_errors: ["La cuenta por cobrar pagada se registra como control; el cobro se contabiliza por eventos de abono para evitar duplicados."],
      source_snapshot: receivableSnapshot(row, amount, name, occurredAt),
    };
  });
}

async function getReceivablePaymentCandidates(): Promise<FinancialEventCandidate[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("accounts_receivable_payments")
    .select("id, receivable_id, customer_id, order_id, amount, payment_method, received_at, voided_at, created_at, customers(contact_name, business_name), orders(order_number)")
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<ReceivablePaymentEventRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => {
    const amount = toNumber(row.amount);
    const name = customerName(row.customers);
    const occurredAt = row.received_at ?? row.created_at;
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
      validation_errors: row.voided_at ? ["El abono a cuenta por cobrar esta anulado."] : [],
      source_snapshot: {
        source_id: row.id,
        payment_id: row.id,
        receivable_id: row.receivable_id,
        customer_id: row.customer_id,
        customer_name: name,
        order_id: row.order_id,
        order_number: row.orders?.order_number ?? null,
        payment_method: row.payment_method,
        total: amount,
        status: row.voided_at ? "voided" : "received",
        occurred_at: occurredAt,
        currency: "HNL",
      },
    };
  });
}

export async function getReceivableFinancialEventCandidates(): Promise<FinancialEventCandidate[]> {
  const [credits, creditCancellations, payments, paidReceivables] = await Promise.all([
    getCommercialCreditCandidates(),
    getCommercialCreditCancellationCandidates(),
    getReceivablePaymentCandidates(),
    getReceivablePaidCandidates(),
  ]);

  return [...credits, ...creditCancellations, ...payments, ...paidReceivables];
}