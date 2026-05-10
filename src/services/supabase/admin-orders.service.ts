import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AdminOrderItem, AdminOrderRow } from "@/types/orders";

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

type OrderQueryRow = Omit<
  AdminOrderRow,
  | "subtotal"
  | "tax"
  | "shipping_total"
  | "total"
  | "order_items"
  | "payment_status"
  | "bank_reference_number"
  | "transfer_receipt_url"
  | "invoice_id"
  | "invoice_number"
  | "customer_rtn"
> & {
  subtotal: unknown;
  tax: unknown;
  shipping_total: unknown;
  total: unknown;
  order_items: Array<Omit<AdminOrderItem, "quantity" | "unit_price" | "line_total" | "retail_price_snapshot" | "wholesale_price_snapshot"> & {
    quantity: unknown;
    unit_price: unknown;
    line_total: unknown;
    retail_price_snapshot: unknown;
    wholesale_price_snapshot: unknown;
  }> | null;
  payments: Array<{
    payment_status: AdminOrderRow["payment_status"];
    status: AdminOrderRow["payment_status"];
    bank_reference_number: string | null;
    reference: string | null;
    transfer_receipt_url: string | null;
  }> | null;
  invoices: Array<{
    id: string;
    invoice_number: string;
  }> | {
    id: string;
    invoice_number: string;
  } | null;
  customers: {
    tax_id: string | null;
  } | null;
};

function normalizeOrder(row: OrderQueryRow): AdminOrderRow {
  const payment = row.payments?.[0] ?? null;
  const invoice = Array.isArray(row.invoices) ? row.invoices[0] ?? null : row.invoices;

  return {
    ...row,
    subtotal: toNumber(row.subtotal),
    tax: toNumber(row.tax),
    shipping_total: toNumber(row.shipping_total),
    total: toNumber(row.total),
    customer_rtn: row.customers?.tax_id ?? null,
    payment_status: payment?.payment_status ?? payment?.status ?? null,
    bank_reference_number: payment?.bank_reference_number ?? payment?.reference ?? null,
    transfer_receipt_url: payment?.transfer_receipt_url ?? null,
    invoice_id: invoice?.id ?? null,
    invoice_number: invoice?.invoice_number ?? null,
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

export async function getAdminOrders(): Promise<AdminOrderRow[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("orders")
    .select(
      `
      id,
      order_number,
      customer_id,
      customer_name,
      email,
      phone,
      delivery_address,
      payment_method,
      price_mode,
      subtotal,
      tax,
      shipping_total,
      total,
      status,
      created_at,
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
        wholesale_price_snapshot
      ),
      payments(payment_status, status, bank_reference_number, reference, transfer_receipt_url),
      invoices(id, invoice_number),
      customers(tax_id)
    `,
    )
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<OrderQueryRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(normalizeOrder);
}
