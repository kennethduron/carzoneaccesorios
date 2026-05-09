import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  AdminReportsData,
  ReportCustomer,
  ReportInvoice,
  ReportOrder,
  ReportOrderItem,
  ReportProduct,
} from "@/types/reports";

function toNumber(value: unknown) {
  return Number(value ?? 0);
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

type InvoiceQueryRow = Omit<ReportInvoice, "subtotal" | "tax" | "total"> & {
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

function normalizeInvoice(row: InvoiceQueryRow): ReportInvoice {
  return {
    ...row,
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

export async function getAdminReports(): Promise<AdminReportsData> {
  const supabase = await getSupabaseServerClient();

  const [
    { data: orders, error: ordersError },
    { data: invoices, error: invoicesError },
    { data: products, error: productsError },
    { data: customers, error: customersError },
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
      )
      .order("created_at", { ascending: false })
      .limit(1000)
      .returns<OrderQueryRow[]>(),
    supabase
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
        created_at
      `,
      )
      .order("created_at", { ascending: false })
      .limit(1000)
      .returns<InvoiceQueryRow[]>(),
    supabase
      .from("products")
      .select("id, sku, name, brand, stock, min_stock, retail_price, wholesale_price, cost_price, status")
      .order("name", { ascending: true })
      .limit(5000)
      .returns<ProductQueryRow[]>(),
    supabase
      .from("customers")
      .select("id, business_name, contact_name, email, phone, is_wholesale, created_at")
      .order("created_at", { ascending: false })
      .limit(1000)
      .returns<ReportCustomer[]>(),
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

  return {
    orders: (orders ?? []).map(normalizeOrder),
    invoices: (invoices ?? []).map(normalizeInvoice),
    products: (products ?? []).map(normalizeProduct),
    customers: customers ?? [],
  };
}
