import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AdminOrderItem, AdminOrderRow } from "@/types/orders";

export type AdminOrdersPage = {
  orders: AdminOrderRow[];
  total: number;
  page: number;
  pageSize: number;
};

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
  | "invoice_issued_at"
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
    issued_at: string | null;
  }> | {
    id: string;
    invoice_number: string;
    issued_at: string | null;
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
    invoice_issued_at: invoice?.issued_at ?? null,
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

export async function getAdminOrdersPage({ page: rawPage, pageSize: rawPageSize }: { page?: number; pageSize?: number } = {}): Promise<AdminOrdersPage> {
  const supabase = await getSupabaseServerClient();
  const page = normalizePage(rawPage);
  const pageSize = normalizePageSize(rawPageSize);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const { data, error, count } = await supabase
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
      email,
      phone,
      delivery_address,
      delivery_country,
      delivery_country_code,
      delivery_department,
      delivery_city,
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
      invoices(id, invoice_number, issued_at),
      customers(tax_id)
    `,
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(from, to)
    .returns<OrderQueryRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return {
    orders: (data ?? []).map(normalizeOrder),
    total: count ?? 0,
    page,
    pageSize,
  };
}

export async function getAdminOrders(): Promise<AdminOrderRow[]> {
  const page = await getAdminOrdersPage();
  return page.orders;
}
