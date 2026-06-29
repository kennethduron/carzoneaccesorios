import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { FinancialEventCandidate } from "@/services/accounting/financial-event-engine";

type OrderEventRow = {
  id: string;
  order_number: string;
  customer_id: string | null;
  customer_name: string;
  payment_method: string;
  subtotal: unknown;
  tax: unknown;
  shipping_total: unknown;
  total: unknown;
  status: string;
  created_at: string;
  updated_at: string;
};

const confirmedStatuses = new Set(["confirmado", "confirmed", "paid", "preparacion", "preparing", "empacado", "enviado", "en_ruta", "entregado", "shipped", "delivered"]);
const cancelledStatuses = new Set(["cancelado", "cancelled"]);

function toNumber(value: unknown) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) / 100 : 0;
}

function snapshot(row: OrderEventRow) {
  return {
    order_number: row.order_number,
    customer_id: row.customer_id,
    customer_name: row.customer_name,
    payment_method: row.payment_method,
    subtotal: toNumber(row.subtotal),
    tax: toNumber(row.tax),
    shipping_total: toNumber(row.shipping_total),
    total: toNumber(row.total),
    status: row.status,
  };
}

export async function getOrderFinancialEventCandidates(): Promise<FinancialEventCandidate[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("orders")
    .select("id, order_number, customer_id, customer_name, payment_method, subtotal, tax, shipping_total, total, status, created_at, updated_at")
    .or("status.in.(confirmado,confirmed,paid,preparacion,preparing,empacado,enviado,en_ruta,entregado,shipped,delivered),status.in.(cancelado,cancelled)")
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<OrderEventRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).flatMap<FinancialEventCandidate>((row) => {
    const amount = toNumber(row.total);
    const base = {
      source_type: "order" as const,
      source_id: row.id,
      posting_version: "v1",
      amount,
      taxAmount: toNumber(row.tax),
      paymentMethod: row.payment_method,
      customerName: row.customer_name,
      sourceNumber: row.order_number,
      source_snapshot: snapshot(row),
    };

    if (confirmedStatuses.has(row.status)) {
      return [{
        ...base,
        eventType: "order_confirmed" as const,
        event_purpose: "sale_revenue" as const,
        occurred_at: row.updated_at ?? row.created_at,
        eligible: true,
      }];
    }

    if (cancelledStatuses.has(row.status)) {
      return [{
        ...base,
        eventType: "order_cancelled" as const,
        event_purpose: "order_cancellation" as const,
        occurred_at: row.updated_at ?? row.created_at,
        eligible: true,
      }];
    }

    return [];
  });
}
