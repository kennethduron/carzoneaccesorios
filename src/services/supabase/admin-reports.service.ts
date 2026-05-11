import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  AdminReportsData,
  ReportCustomer,
  ReportInvoice,
  ReportOrder,
  ReportOrderItem,
  ReportPayment,
  ReportProduct,
} from "@/types/reports";

function toNumber(value: unknown) {
  return Number(value ?? 0);
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

type OrderQueryRow = Omit<
  ReportOrder,
  "subtotal" | "tax" | "shipping_total" | "total" | "order_items"
> & {
  subtotal: unknown;
  tax: unknown;
  shipping_total: unknown;
  total: unknown;
  order_items: Array<Omit<ReportOrderItem, "quantity" | "unit_price" | "line_total"> & {
    quantity: unknown;
    unit_price: unknown;
    line_total: unknown;
  }> | null;
};

type InvoiceQueryRow = Omit<ReportInvoice, "subtotal" | "tax" | "total" | "payment_method" | "bank_reference_number" | "reference"> & {
  subtotal: unknown;
  tax: unknown;
  total: unknown;
};

type ProductQueryRow = Omit<
  ReportProduct,
  "stock" | "min_stock" | "retail_price" | "wholesale_price" | "cost_price"
> & {
  stock: unknown;
  min_stock: unknown;
  retail_price: unknown;
  wholesale_price: unknown;
  cost_price: unknown;
};

type PaymentQueryRow = Omit<ReportPayment, "amount"> & {
  amount: unknown;
};

function normalizeOrder(row: OrderQueryRow): ReportOrder {
  return {
    ...row,
    subtotal: toNumber(row.subtotal),
    tax: toNumber(row.tax),
    shipping_total: toNumber(row.shipping_total),
    total: toNumber(row.total),
    order_items: (row.order_items ?? []).map((item) => ({
      ...item,
      quantity: toNumber(item.quantity),
      unit_price: toNumber(item.unit_price),
      line_total: toNumber(item.line_total),
    })),
  };
}

function normalizeInvoice(row: InvoiceQueryRow, paymentByOrder: Map<string, PaymentQueryRow>): ReportInvoice {
  const payment = paymentByOrder.get(row.order_id);

  return {
    ...row,
    payment_method: payment?.payment_method ?? null,
    bank_reference_number: payment?.bank_reference_number ?? null,
    reference: payment?.reference ?? null,
    subtotal: toNumber(row.subtotal),
    tax: toNumber(row.tax),
    total: toNumber(row.total),
  };
}

function normalizeProduct(row: ProductQueryRow): ReportProduct {
  return {
    ...row,
    stock: toNumber(row.stock),
    min_stock: toNumber(row.min_stock),
    retail_price: toNumber(row.retail_price),
    wholesale_price: toNumber(row.wholesale_price),
    cost_price: toNumber(row.cost_price),
  };
}

function normalizePayment(row: PaymentQueryRow): ReportPayment {
  return {
    ...row,
    amount: toNumber(row.amount),
  };
}

export async function getAdminReports({ page: rawPage, pageSize: rawPageSize }: { page?: number; pageSize?: number } = {}): Promise<AdminReportsData> {
  const supabase = await getSupabaseServerClient();
  const page = normalizePage(rawPage);
  const pageSize = normalizePageSize(rawPageSize);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const [
    { data: orders, error: ordersError, count: ordersTotal },
    { data: invoices, error: invoicesError, count: invoicesTotal },
    { data: products, error: productsError, count: productsTotal },
    { data: customers, error: customersError, count: customersTotal },
    { data: payments, error: paymentsError, count: paymentsTotal },
  ] = await Promise.all([
    supabase
      .from("orders")
      .select(
        `
        id,
        order_number,
        customer_id,
        customer_name,
        phone,
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
          order_id,
          product_id,
          sku,
          product_name,
          quantity,
          unit_price,
          line_total
        )
      `,
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(from, to)
      .returns<OrderQueryRow[]>(),
    supabase
      .from("invoices")
      .select(
        `
        id,
        invoice_number,
        order_id,
        customer_id,
        customer_name,
        rtn,
        cai,
        customer_rtn,
        status,
        price_mode,
        subtotal,
        tax,
        total,
        issued_at,
        created_at
      `,
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(from, to)
      .returns<InvoiceQueryRow[]>(),
    supabase
      .from("products")
      .select("id, sku, internal_code, name, brand, stock, min_stock, retail_price, wholesale_price, cost_price, status", { count: "exact" })
      .order("name", { ascending: true })
      .range(from, to)
      .returns<ProductQueryRow[]>(),
    supabase
      .from("customers")
      .select("id, business_name, contact_name, email, phone, is_wholesale, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to)
      .returns<ReportCustomer[]>(),
    supabase
      .from("payments")
      .select("id, order_id, payment_method, bank_reference_number, reference, amount, created_at", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(from, to)
      .returns<PaymentQueryRow[]>(),
  ]);

  if (ordersError) {
    throw new Error(ordersError.message);
  }

  if (invoicesError) {
    throw new Error(invoicesError.message);
  }

  if (productsError) {
    throw new Error(productsError.message);
  }

  if (customersError) {
    throw new Error(customersError.message);
  }

  if (paymentsError) {
    throw new Error(paymentsError.message);
  }

  const invoiceOrderIds = [...new Set((invoices ?? []).map((invoice) => invoice.order_id))];
  let invoicePayments: PaymentQueryRow[] = [];

  if (invoiceOrderIds.length > 0) {
    const { data, error } = await supabase
      .from("payments")
      .select("id, order_id, payment_method, bank_reference_number, reference, amount, created_at")
      .in("order_id", invoiceOrderIds)
      .order("created_at", { ascending: false })
      .returns<PaymentQueryRow[]>();

    if (error) {
      throw new Error(error.message);
    }

    invoicePayments = data ?? [];
  }

  const paymentByInvoiceOrder = new Map<string, PaymentQueryRow>();
  invoicePayments.forEach((payment) => {
    if (!paymentByInvoiceOrder.has(payment.order_id)) {
      paymentByInvoiceOrder.set(payment.order_id, payment);
    }
  });

  return {
    orders: (orders ?? []).map(normalizeOrder),
    invoices: (invoices ?? []).map((invoice) => normalizeInvoice(invoice, paymentByInvoiceOrder)),
    products: (products ?? []).map(normalizeProduct),
    customers: customers ?? [],
    payments: (payments ?? []).map(normalizePayment),
    totalRecords: Math.max(ordersTotal ?? 0, invoicesTotal ?? 0, productsTotal ?? 0, customersTotal ?? 0, paymentsTotal ?? 0),
    page,
    pageSize,
  };
}
