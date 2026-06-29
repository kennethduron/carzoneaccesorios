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
  due_date: string;
  status: string;
  created_at: string;
  updated_at: string;
  customers: {
    contact_name: string | null;
    business_name: string | null;
  } | null;
  orders: {
    order_number: string | null;
    payment_method: string | null;
    tax: unknown;
  } | null;
};

type ReceivablePaymentEventRow = {
  id: string;
  receivable_id: string;
  customer_id: string;
  order_id: string;
  amount: unknown;
  payment_method: string;
  reference: string | null;
  received_at: string;
  voided_at: string | null;
  void_reason: string | null;
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

async function getCommercialCreditCandidates(): Promise<FinancialEventCandidate[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("accounts_receivable")
    .select("id, customer_id, order_id, invoice_id, original_amount, balance_due, due_date, status, created_at, updated_at, customers(contact_name, business_name), orders(order_number, payment_method, tax)")
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
    return {
      eventType: "commercial_credit_created",
      source_type: "commercial_credit",
      source_id: row.id,
      event_purpose: "commercial_credit",
      posting_version: "v1",
      occurred_at: row.created_at,
      amount,
      taxAmount: toNumber(row.orders?.tax),
      paymentMethod: row.orders?.payment_method ?? "commercial_credit",
      customerName: name,
      sourceNumber: row.orders?.order_number ?? row.id,
      eligible: row.status !== "cancelled",
      source_snapshot: {
        receivable_id: row.id,
        customer_id: row.customer_id,
        customer_name: name,
        order_id: row.order_id,
        order_number: row.orders?.order_number ?? null,
        invoice_id: row.invoice_id,
        original_amount: amount,
        balance_due: toNumber(row.balance_due),
        due_date: row.due_date,
        status: row.status,
      },
    };
  });
}

async function getReceivablePaymentCandidates(): Promise<FinancialEventCandidate[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("accounts_receivable_payments")
    .select("id, receivable_id, customer_id, order_id, amount, payment_method, reference, received_at, voided_at, void_reason, created_at, customers(contact_name, business_name), orders(order_number)")
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<ReceivablePaymentEventRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => {
    const amount = toNumber(row.amount);
    const name = customerName(row.customers);
    return {
      eventType: "receivable_payment_received",
      source_type: "receivable_payment",
      source_id: row.id,
      event_purpose: "receivable_payment",
      posting_version: "v1",
      occurred_at: row.received_at ?? row.created_at,
      amount,
      paymentMethod: row.payment_method,
      customerName: name,
      sourceNumber: row.orders?.order_number ?? row.id,
      eligible: !row.voided_at,
      validation_errors: row.voided_at ? ["El abono a cuenta por cobrar está anulado."] : [],
      source_snapshot: {
        payment_id: row.id,
        receivable_id: row.receivable_id,
        customer_id: row.customer_id,
        customer_name: name,
        order_id: row.order_id,
        order_number: row.orders?.order_number ?? null,
        payment_method: row.payment_method,
        reference: row.reference,
        amount,
        received_at: row.received_at,
        voided_at: row.voided_at,
        void_reason: row.void_reason,
      },
    };
  });
}

export async function getReceivableFinancialEventCandidates(): Promise<FinancialEventCandidate[]> {
  const [credits, payments] = await Promise.all([
    getCommercialCreditCandidates(),
    getReceivablePaymentCandidates(),
  ]);

  return [...credits, ...payments];
}
