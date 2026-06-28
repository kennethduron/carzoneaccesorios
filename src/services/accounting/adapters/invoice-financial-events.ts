import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { FinancialEventCandidate } from "@/services/accounting/financial-event-engine";

type InvoiceEventRow = {
  id: string;
  invoice_number: string;
  order_id: string;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  status: string;
  subtotal: unknown;
  tax: unknown;
  total: unknown;
  issued_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  orders: {
    order_number: string | null;
    customer_name: string | null;
    payment_method: string | null;
  } | null;
};

const issuedStatuses = new Set(["emitida", "issued", "paid"]);

function toNumber(value: unknown) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) / 100 : 0;
}

export async function getInvoiceFinancialEventCandidates(): Promise<FinancialEventCandidate[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("invoices")
    .select("id, invoice_number, order_id, customer_id, customer_name, customer_email, status, subtotal, tax, total, issued_at, cancelled_at, created_at, orders(order_number, customer_name, payment_method)")
    .in("status", ["emitida", "issued", "paid"])
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<InvoiceEventRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => {
    const amount = toNumber(row.total);
    const customerName = row.customer_name ?? row.orders?.customer_name ?? null;
    return {
      eventType: "invoice_issued",
      source_type: "invoice",
      source_id: row.id,
      event_purpose: "invoice_issued",
      posting_version: "v1",
      occurred_at: row.issued_at ?? row.created_at,
      amount,
      taxAmount: toNumber(row.tax),
      paymentMethod: row.orders?.payment_method ?? null,
      customerName,
      sourceNumber: row.invoice_number,
      eligible: issuedStatuses.has(row.status),
      source_snapshot: {
        invoice_number: row.invoice_number,
        order_id: row.order_id,
        order_number: row.orders?.order_number ?? null,
        customer_id: row.customer_id,
        customer_name: customerName,
        customer_email: row.customer_email,
        payment_method: row.orders?.payment_method ?? null,
        status: row.status,
        subtotal: toNumber(row.subtotal),
        tax: toNumber(row.tax),
        total: amount,
        issued_at: row.issued_at,
        cancelled_at: row.cancelled_at,
      },
    };
  });
}
