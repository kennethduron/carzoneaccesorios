import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { FinancialEventCandidate } from "@/services/accounting/financial-event-engine";

type PaymentEventRow = {
  id: string;
  order_id: string;
  customer_id: string | null;
  payment_method: string;
  payment_status: string;
  amount: unknown;
  provider: string | null;
  paid_at: string | null;
  created_at: string;
  orders: {
    order_number: string | null;
    customer_name: string | null;
  } | null;
};

const receivedStatuses = new Set(["approved", "confirmed", "paid"]);

function toNumber(value: unknown) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) / 100 : 0;
}

export async function getPaymentFinancialEventCandidates(): Promise<FinancialEventCandidate[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("payments")
    .select("id, order_id, customer_id, payment_method, payment_status, amount, provider, paid_at, created_at, orders(order_number, customer_name)")
    .eq("payment_status", "approved")
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<PaymentEventRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((row) => {
    const amount = toNumber(row.amount);
    return {
      eventType: "payment_received",
      source_type: "payment",
      source_id: row.id,
      event_purpose: "payment_received",
      posting_version: "v1",
      occurred_at: row.paid_at ?? row.created_at,
      amount,
      paymentMethod: row.payment_method,
      customerName: row.orders?.customer_name ?? null,
      sourceNumber: row.orders?.order_number ?? row.id,
      eligible: receivedStatuses.has(row.payment_status),
      source_snapshot: {
        source_id: row.id,
        order_id: row.order_id,
        order_number: row.orders?.order_number ?? null,
        customer_id: row.customer_id,
        customer_name: row.orders?.customer_name ?? null,
        payment_method: row.payment_method,
        status: row.payment_status,
        total: amount,
        provider: row.provider,
        occurred_at: row.paid_at ?? row.created_at,
        currency: "HNL",
      },
    };
  });
}
