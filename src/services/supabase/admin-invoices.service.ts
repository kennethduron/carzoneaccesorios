import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AdminInvoiceItem, AdminInvoiceRow } from "@/types/invoices";

export type AdminInvoicesPage = {
  invoices: AdminInvoiceRow[];
  total: number;
  page: number;
  pageSize: number;
};

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

type InvoiceQueryRow = Omit<AdminInvoiceRow, "order_number" | "customer_name" | "payment_method" | "bank_reference_number" | "items" | "subtotal" | "tax" | "total"> & {
  subtotal: unknown;
  tax: unknown;
  total: unknown;
  orders: {
    order_number: string;
    customer_name: string;
    payment_method: string;
  } | null;
  invoice_items: Array<Omit<AdminInvoiceItem, "quantity" | "unit_price" | "line_total" | "retail_price_snapshot" | "wholesale_price_snapshot"> & {
    quantity: unknown;
    unit_price: unknown;
    line_total: unknown;
    retail_price_snapshot: unknown;
    wholesale_price_snapshot: unknown;
  }> | null;
};

type PaymentQueryRow = {
  order_id: string;
  payment_method: string | null;
  bank_reference_number: string | null;
  reference: string | null;
};

function normalizeInvoice(row: InvoiceQueryRow, paymentByOrder: Map<string, PaymentQueryRow>): AdminInvoiceRow {
  const payment = paymentByOrder.get(row.order_id);

  return {
    id: row.id,
    invoice_number: row.invoice_number,
    order_id: row.order_id,
    order_number: row.orders?.order_number ?? "-",
    customer_id: row.customer_id,
    customer_name: row.orders?.customer_name ?? "Cliente no registrado",
    rtn: row.rtn,
    cai: row.cai,
    customer_rtn: row.customer_rtn,
    status: row.status,
    price_mode: row.price_mode,
    payment_method: payment?.payment_method ?? row.orders?.payment_method ?? "-",
    bank_reference_number: payment?.bank_reference_number ?? payment?.reference ?? null,
    subtotal: toNumber(row.subtotal),
    tax: toNumber(row.tax),
    total: toNumber(row.total),
    issued_at: row.issued_at,
    cancelled_at: row.cancelled_at,
    created_at: row.created_at,
    items: (row.invoice_items ?? []).map((item) => ({
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

export async function getAdminInvoicesPage({ page: rawPage, pageSize: rawPageSize }: { page?: number; pageSize?: number } = {}): Promise<AdminInvoicesPage> {
  const supabase = await getSupabaseServerClient();
  const page = normalizePage(rawPage);
  const pageSize = normalizePageSize(rawPageSize);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data: invoices, error: invoicesError, count } = await supabase
    .from("invoices")
    .select(
      `
      id,
      invoice_number,
      order_id,
      customer_id,
      rtn,
      cai,
      customer_rtn,
      status,
      price_mode,
      subtotal,
      tax,
      total,
      issued_at,
      cancelled_at,
      created_at,
      orders(order_number, customer_name, payment_method),
      invoice_items(
        id,
        sku,
        product_name,
        quantity,
        unit_price,
        line_total,
        retail_price_snapshot,
        wholesale_price_snapshot
      )
    `,
      { count: "exact" },
    )
    .order("created_at", { ascending: false })
    .range(from, to)
    .returns<InvoiceQueryRow[]>();

  if (invoicesError) {
    throw new Error(invoicesError.message);
  }

  const orderIds = [...new Set((invoices ?? []).map((invoice) => invoice.order_id))];
  let payments: PaymentQueryRow[] = [];

  if (orderIds.length > 0) {
    const { data, error } = await supabase
      .from("payments")
      .select("order_id, payment_method, bank_reference_number, reference")
      .in("order_id", orderIds)
      .order("created_at", { ascending: false })
      .returns<PaymentQueryRow[]>();

    if (error) {
      throw new Error(error.message);
    }

    payments = data ?? [];
  }

  const paymentByOrder = new Map<string, PaymentQueryRow>();
  payments.forEach((payment) => {
    if (!paymentByOrder.has(payment.order_id)) {
      paymentByOrder.set(payment.order_id, payment);
    }
  });

  return {
    invoices: (invoices ?? []).map((invoice) => normalizeInvoice(invoice, paymentByOrder)),
    total: count ?? 0,
    page,
    pageSize,
  };
}

export async function getAdminInvoices(): Promise<AdminInvoiceRow[]> {
  const page = await getAdminInvoicesPage();
  return page.invoices;
}
