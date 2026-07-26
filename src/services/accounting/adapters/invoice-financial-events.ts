import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { FinancialEventCandidate } from "@/services/accounting/financial-event-engine";

type InvoiceEventRow = {
  id: string;
  invoice_number: string;
  order_id: string;
  customer_id: string | null;
  customer_name: string | null;
  status: string;
  subtotal: unknown;
  tax: unknown;
  total: unknown;
  invoice_date: string | null;
  issued_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string | null;
  orders: {
    order_number: string | null;
    customer_name: string | null;
    payment_method: string | null;
  } | null;
};

const issuedStatuses = new Set(["emitida", "issued", "paid"]);
const cancelledStatuses = new Set(["anulada", "cancelled"]);

function toNumber(value: unknown) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) / 100 : 0;
}

export async function getInvoiceFinancialEventCandidates(): Promise<FinancialEventCandidate[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("invoices")
    .select("id, invoice_number, order_id, customer_id, customer_name, status, subtotal, tax, total, invoice_date, issued_at, cancelled_at, created_at, updated_at, orders(order_number, customer_name, payment_method)")
    .in("status", ["emitida", "issued", "paid", "anulada", "cancelled"])
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<InvoiceEventRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => {
    const amount = toNumber(row.total);
    const customerName = row.customer_name ?? row.orders?.customer_name ?? null;
    const isCancelled = cancelledStatuses.has(row.status);
    const occurredAt = isCancelled ? row.cancelled_at ?? row.updated_at ?? row.created_at : row.issued_at ?? row.created_at;
    const reason = isCancelled
      ? "La anulación fiscal requiere revisión contable antes de generar reversos."
      : "La factura fiscal fue registrada como evento, pero no requiere partida adicional para evitar duplicar ingresos.";

    return {
      eventType: isCancelled ? "invoice_cancelled" : "invoice_issued",
      source_type: "invoice",
      source_id: row.id,
      event_purpose: isCancelled ? "invoice_cancelled" : "invoice_issued",
      posting_version: "v1",
      occurred_at: occurredAt,
      accounting_date: row.invoice_date,
      amount,
      taxAmount: toNumber(row.tax),
      paymentMethod: row.orders?.payment_method ?? null,
      customerName,
      sourceNumber: row.invoice_number,
      eligible: isCancelled ? cancelledStatuses.has(row.status) : issuedStatuses.has(row.status),
      validation_errors: [reason],
      source_snapshot: {
        source_id: row.id,
        invoice_id: row.id,
        invoice_number: row.invoice_number,
        order_id: row.order_id,
        order_number: row.orders?.order_number ?? null,
        customer_id: row.customer_id,
        customer_name: customerName,
        payment_method: row.orders?.payment_method ?? null,
        status: row.status,
        subtotal: toNumber(row.subtotal),
        tax_amount: toNumber(row.tax),
        total: amount,
        occurred_at: occurredAt,
        accounting_date: row.invoice_date,
        currency: "HNL",
      },
    };
  });
}