import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getOrderAccountingTraceabilityBatch } from "@/services/supabase/accounting-traceability.service";
import { getFiscalCorrectionHistory } from "@/services/supabase/fiscal-corrections.service";
import type { AdminOrderItem, AdminOrderRow } from "@/types/orders";
import { normalizeAdditionalFees } from "@/utils/financial-summary";

export type AdminOrdersPage = {
  orders: AdminOrderRow[];
  total: number;
  page: number;
  pageSize: number;
};

export type AdminOrderTask = "new_orders" | "pending_payments" | "to_prepare" | "expired_reservations";

export const adminOrderTaskLabels: Record<AdminOrderTask, string> = {
  new_orders: "Pedidos nuevos por revisar",
  pending_payments: "Pagos pendientes de confirmar",
  to_prepare: "Pedidos listos para preparar",
  expired_reservations: "Reservas vencidas por revisar",
};

const adminOrderTasks = new Set<AdminOrderTask>(["new_orders", "pending_payments", "to_prepare", "expired_reservations"]);

export function normalizeAdminOrderTask(value: string | null | undefined): AdminOrderTask | null {
  return adminOrderTasks.has(value as AdminOrderTask) ? (value as AdminOrderTask) : null;
}

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

type OrderQueryRow = Omit<
  AdminOrderRow,
  | "subtotal"
  | "tax"
  | "shipping_fee"
  | "shipping_total"
  | "cash_on_delivery_fee"
  | "small_order_fee"
  | "discount_total"
  | "additional_fees"
  | "total"
  | "order_items"
  | "payment_id"
  | "payment_status"
  | "bank_reference_number"
  | "transfer_receipt_url"
  | "transfer_receipt_public_id"
  | "invoice_id"
  | "invoice_number"
  | "invoice_issued_at"
  | "invoice_date"
  | "invoice_status"
  | "invoice_cancelled_at"
  | "invoice_cancellation_reason"
  | "customer_rtn"
  | "fiscal_customer_name"
  | "fiscal_customer_rtn"
  | "fiscal_customer_phone"
  | "fiscal_customer_email"
  | "fiscal_customer_address"
> & {
  subtotal: unknown;
  tax: unknown;
  shipping_fee: unknown;
  shipping_total: unknown;
  cash_on_delivery_fee: unknown;
  small_order_fee: unknown;
  discount_total: unknown;
  additional_fees: unknown;
  total: unknown;
  fiscal_customer_name: string | null;
  fiscal_customer_rtn: string | null;
  fiscal_customer_phone: string | null;
  fiscal_customer_email: string | null;
  fiscal_customer_address: string | null;
  order_items: Array<Omit<AdminOrderItem, "quantity" | "unit_price" | "line_total" | "retail_price_snapshot" | "wholesale_price_snapshot"> & {
    quantity: unknown;
    unit_price: unknown;
    line_total: unknown;
    retail_price_snapshot: unknown;
    wholesale_price_snapshot: unknown;
  }> | null;
  payments: Array<{
    id: string;
    payment_status: AdminOrderRow["payment_status"];
    status: AdminOrderRow["payment_status"];
    bank_reference_number: string | null;
    reference: string | null;
    transfer_receipt_url: string | null;
    transfer_receipt_public_id: string | null;
  }> | null;
  invoices: Array<{
    id: string;
    invoice_number: string;
    issued_at: string | null;
    invoice_date: string | null;
    status: string | null;
    cancelled_at: string | null;
    cancellation_reason: string | null;
    customer_name: string | null;
    customer_rtn: string | null;
    customer_phone: string | null;
    customer_email: string | null;
    customer_address: string | null;
  }> | {
    id: string;
    invoice_number: string;
    issued_at: string | null;
    invoice_date: string | null;
    status: string | null;
    cancelled_at: string | null;
    cancellation_reason: string | null;
    customer_name: string | null;
    customer_rtn: string | null;
    customer_phone: string | null;
    customer_email: string | null;
    customer_address: string | null;
  } | null;
  accounts_receivable: {
    id: string;
    status: "open" | "partial" | "paid" | "overdue" | "cancelled" | null;
    due_date: string | null;
    balance_due: unknown;
    paid_at: string | null;
    payment_received_method: AdminOrderRow["receivable_payment_received_method"];
    payment_received_reference: string | null;
    payment_recorded_by: string | null;
  } | Array<{
    id: string;
    status: "open" | "partial" | "paid" | "overdue" | "cancelled" | null;
    due_date: string | null;
    balance_due: unknown;
    paid_at: string | null;
    payment_received_method: AdminOrderRow["receivable_payment_received_method"];
    payment_received_reference: string | null;
    payment_recorded_by: string | null;
  }> | null;
  customers: {
    tax_id: string | null;
  } | null;
};

function normalizeOrder(row: OrderQueryRow): AdminOrderRow {
  const payment = row.payments?.[0] ?? null;
  const invoice = Array.isArray(row.invoices) ? row.invoices[0] ?? null : row.invoices;
  const receivable = Array.isArray(row.accounts_receivable)
    ? row.accounts_receivable[0] ?? null
    : row.accounts_receivable;

  return {
    ...row,
    subtotal: toNumber(row.subtotal),
    tax: toNumber(row.tax),
    shipping_fee: toNumber(row.shipping_fee),
    shipping_total: toNumber(row.shipping_total),
    cash_on_delivery_fee: toNumber(row.cash_on_delivery_fee),
    small_order_fee: toNumber(row.small_order_fee),
    discount_total: toNumber(row.discount_total),
    additional_fees: normalizeAdditionalFees(row.additional_fees),
    total: toNumber(row.total),
    customer_rtn: invoice?.customer_rtn ?? row.fiscal_customer_rtn ?? row.customers?.tax_id ?? null,
    fiscal_customer_name: invoice?.customer_name ?? row.fiscal_customer_name ?? row.customer_name,
    fiscal_customer_rtn: invoice?.customer_rtn ?? row.fiscal_customer_rtn ?? row.customers?.tax_id ?? null,
    fiscal_customer_phone: invoice?.customer_phone ?? row.fiscal_customer_phone ?? row.customer_phone ?? row.phone,
    fiscal_customer_email: invoice?.customer_email ?? row.fiscal_customer_email ?? row.email ?? null,
    fiscal_customer_address: invoice?.customer_address ?? row.fiscal_customer_address ?? row.delivery_address,
    payment_id: payment?.id ?? null,
    payment_status: payment?.payment_status ?? payment?.status ?? null,
    bank_reference_number: payment?.bank_reference_number ?? payment?.reference ?? null,
    transfer_receipt_url: payment?.transfer_receipt_public_id || payment?.transfer_receipt_url
      ? `/api/admin/transfer-receipts/${payment.id}`
      : null,
    transfer_receipt_public_id: payment?.transfer_receipt_public_id ?? null,
    invoice_id: invoice?.id ?? null,
    invoice_number: invoice?.invoice_number ?? null,
    invoice_issued_at: invoice?.issued_at ?? null,
    invoice_date: invoice?.invoice_date ?? null,
    invoice_status: invoice?.status ?? null,
    invoice_cancelled_at: invoice?.cancelled_at ?? null,
    invoice_cancellation_reason: invoice?.cancellation_reason ?? null,
    fiscal_correction_history: [],
    receivable_id: receivable?.id ?? null,
    receivable_status: receivable?.status ?? null,
    receivable_due_date: receivable?.due_date ?? null,
    receivable_balance_due: receivable ? toNumber(receivable.balance_due) : null,
    receivable_paid_at: receivable?.paid_at ?? null,
    receivable_payment_received_method: receivable?.payment_received_method ?? null,
    receivable_payment_received_reference: receivable?.payment_received_reference ?? null,
    receivable_payment_recorded_by: receivable?.payment_recorded_by ?? null,
    accounting_traceability: null,
    order_items: (row.order_items ?? []).map((item) => ({
      ...item,
      quantity: toNumber(item.quantity),
      unit_price: toNumber(item.unit_price),
      line_total: toNumber(item.line_total),
      retail_price_snapshot: toNumber(item.retail_price_snapshot),
      wholesale_price_snapshot: toNumber(item.wholesale_price_snapshot),
    })),
  };
}

function normalizePage(value: unknown) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizePageSize(value: unknown) {
  const pageSize = Number(value);
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return 50;
  }

  return Math.min(Math.floor(pageSize), 100);
}

export async function getAdminOrdersPage({
  page: rawPage,
  pageSize: rawPageSize,
  task,
  includeAccountingTraceability = false,
}: {
  page?: number;
  pageSize?: number;
  task?: AdminOrderTask | null;
  includeAccountingTraceability?: boolean;
} = {}): Promise<AdminOrdersPage> {
  const supabase = await getSupabaseServerClient();
  const page = normalizePage(rawPage);
  const pageSize = normalizePageSize(rawPageSize);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const paymentRelation = task === "pending_payments" || task === "to_prepare" ? "payments!inner" : "payments";

  let ordersQuery = supabase
    .from("orders")
    .select(
      `
      id,
      order_number,
      tracking_code,
      tracking_status,
      public_tracking_enabled,
      customer_id,
      customer_name,
      customer_phone,
      fiscal_customer_name,
      fiscal_customer_rtn,
      fiscal_customer_phone,
      fiscal_customer_email,
      fiscal_customer_address,
      email,
      phone,
      delivery_address,
      delivery_country,
      delivery_country_code,
      delivery_department,
      delivery_city,
      payment_method,
      payment_timing,
      price_mode,
      subtotal,
      tax,
      shipping_fee,
      shipping_total,
      cash_on_delivery_fee,
      small_order_fee,
      discount_total,
      additional_fees,
      total,
      status,
      order_reservation_status,
      reservation_expires_at,
      reservation_review_required,
      reservation_review_detected_at,
      created_at,
      requested_invoice_date,
      shipping_fee_suggested,
      commercial_terms_version,
      delivery_mode,
      external_delivery_provider,
      order_items(
        id,
        product_id,
        sku,
        product_name,
        quantity,
        applied_price_mode,
        unit_price,
        line_total,
        retail_price_snapshot,
        wholesale_price_snapshot,
        unit_cost_snapshot,
        total_cost_snapshot,
        cost_source,
        cost_captured_at
      ),
      ${paymentRelation}(id, payment_status, status, bank_reference_number, reference, transfer_receipt_url, transfer_receipt_public_id),
      order_internal_notes(id, note, actor_role, created_at),
      invoices(id, invoice_number, invoice_date, issued_at, status, cancelled_at, cancellation_reason, customer_name, customer_rtn, customer_phone, customer_email, customer_address),
      accounts_receivable(id, status, due_date, balance_due, paid_at, payment_received_method, payment_received_reference, payment_recorded_by),
      customers(tax_id)
    `,
      { count: "exact" },
    );

  if (task === "new_orders") {
    ordersQuery = ordersQuery.in("status", ["pending", "recibido"]);
  }

  if (task === "pending_payments") {
    ordersQuery = ordersQuery
      .in("payment_method", ["bank_transfer", "card", "cash"])
      .eq("payments.payment_status", "pending")
      .not("status", "in", "(cancelado,cancelled)");
  }

  if (task === "to_prepare") {
    ordersQuery = ordersQuery
      .in("status", ["confirmado", "confirmed", "paid", "preparacion", "preparing"])
      .eq("payments.payment_status", "approved");
  }

  if (task === "expired_reservations") {
    ordersQuery = ordersQuery.eq("reservation_review_required", true);
  }

  const { data, error, count } = await ordersQuery
    .order("created_at", { ascending: false })
    .range(from, to)
    .returns<OrderQueryRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  const orders = (data ?? []).map(normalizeOrder);
  const correctionHistories = await Promise.all(
    orders.map((order) =>
      getFiscalCorrectionHistory({
        orderId: order.id,
        invoiceId: order.invoice_id,
      }).catch(() => []),
    ),
  );

  const traceabilityByOrderId = includeAccountingTraceability
    ? await getOrderAccountingTraceabilityBatch(
        orders.map((order) => ({
          orderId: order.id,
          paymentId: order.payment_id,
          invoiceId: order.invoice_id,
          receivableId: order.receivable_id,
        })),
      )
    : new Map();

  return {
    orders: orders.map((order, index) => ({
      ...order,
      fiscal_correction_history: correctionHistories[index],
      accounting_traceability: traceabilityByOrderId.get(order.id) ?? null,
    })),
    total: count ?? 0,
    page,
    pageSize,
  };
}

export async function getAdminOrders(): Promise<AdminOrderRow[]> {
  const page = await getAdminOrdersPage();
  return page.orders;
}
