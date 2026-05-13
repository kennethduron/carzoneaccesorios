import { getSupabaseAdminClient } from "@/lib/supabase";
import type { AdminInvoiceItem, InvoiceStatus, StoreInvoice } from "@/types/invoices";
import type { AdminOrderItem, AdminOrderRow } from "@/types/orders";

export type CustomerOrderInvoice = {
  id: string;
  invoice_number: string;
  status: InvoiceStatus;
  rtn: string | null;
  cai: string | null;
  customer_rtn: string | null;
  issued_at: string | null;
  cancelled_at: string | null;
};

export type CustomerOrderRow = Omit<
  AdminOrderRow,
  "order_items" | "invoice_id" | "invoice_number" | "invoice_issued_at" | "customer_rtn"
> & {
  order_items: AdminOrderItem[];
  invoices: CustomerOrderInvoice[];
};

type CustomerOrderQueryRow = Omit<
  CustomerOrderRow,
  "subtotal" | "tax" | "shipping_total" | "total" | "order_items" | "payment_status" | "bank_reference_number" | "transfer_receipt_url" | "invoices"
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
  invoices: CustomerOrderInvoice[] | CustomerOrderInvoice | null;
};

type CustomerInvoiceQueryRow = {
  id: string;
  invoice_number: string;
  order_id: string;
  customer_id: string | null;
  rtn: string | null;
  cai: string | null;
  customer_rtn: string | null;
  status: InvoiceStatus;
  price_mode: StoreInvoice["priceMode"];
  subtotal: unknown;
  tax: unknown;
  total: unknown;
  issued_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  orders: {
    order_number: string;
    customer_name: string;
    payment_method: string;
    payments: Array<{
      bank_reference_number: string | null;
      reference: string | null;
    }> | null;
  } | null;
  invoice_items: Array<Omit<AdminInvoiceItem, "quantity" | "unit_price" | "line_total" | "retail_price_snapshot" | "wholesale_price_snapshot"> & {
    quantity: unknown;
    unit_price: unknown;
    line_total: unknown;
    retail_price_snapshot: unknown;
    wholesale_price_snapshot: unknown;
  }> | null;
};

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

function paymentMethodLabel(value: string): StoreInvoice["paymentMethod"] {
  if (value === "bank_transfer") {
    return "Transferencia bancaria";
  }

  if (value === "card") {
    return "Tarjeta";
  }

  return "Efectivo";
}

function normalizePaymentStatus(payments: CustomerOrderQueryRow["payments"]) {
  const payment = payments?.[0] ?? null;
  return payment?.payment_status ?? payment?.status ?? null;
}

function normalizeOrder(row: CustomerOrderQueryRow): CustomerOrderRow {
  const payment = row.payments?.[0] ?? null;
  const invoices = Array.isArray(row.invoices) ? row.invoices : row.invoices ? [row.invoices] : [];

  return {
    ...row,
    subtotal: toNumber(row.subtotal),
    tax: toNumber(row.tax),
    shipping_total: toNumber(row.shipping_total),
    total: toNumber(row.total),
    payment_status: normalizePaymentStatus(row.payments),
    bank_reference_number: payment?.bank_reference_number ?? payment?.reference ?? null,
    transfer_receipt_url: payment?.transfer_receipt_url ?? null,
    invoices,
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

function normalizeInvoice(row: CustomerInvoiceQueryRow): StoreInvoice {
  const payment = row.orders?.payments?.[0] ?? null;

  return {
    id: row.id,
    invoiceNumber: row.invoice_number,
    orderNumber: row.orders?.order_number ?? row.order_id,
    rtn: row.rtn ?? "",
    cai: row.cai ?? "",
    customerName: row.orders?.customer_name ?? "Cliente",
    customerRtn: row.customer_rtn,
    items: (row.invoice_items ?? []).map((item) => ({
      productId: item.id,
      sku: item.sku,
      name: item.product_name,
      quantity: toNumber(item.quantity),
      unitPrice: toNumber(item.unit_price),
      lineTotal: toNumber(item.line_total),
      retailPriceSnapshot: toNumber(item.retail_price_snapshot),
      wholesalePriceSnapshot: toNumber(item.wholesale_price_snapshot),
    })),
    subtotal: toNumber(row.subtotal),
    isv: toNumber(row.tax),
    total: toNumber(row.total),
    priceMode: row.price_mode,
    paymentMethod: paymentMethodLabel(row.orders?.payment_method ?? "cash"),
    paymentReference: payment?.bank_reference_number ?? payment?.reference ?? null,
    status: row.status,
    issuedAt: row.issued_at ?? row.created_at,
    cancelledAt: row.cancelled_at,
  };
}

async function getCustomerIdsForAccount(userId: string, email: string | null) {
  const admin = getSupabaseAdminClient();
  const queries = [
    admin.from("customers").select("id").eq("user_id", userId).returns<Array<{ id: string }>>(),
  ];

  if (email) {
    queries.push(admin.from("customers").select("id").ilike("email", email).returns<Array<{ id: string }>>());
  }

  const results = await Promise.all(queries);
  const ids = new Set<string>();

  for (const result of results) {
    if (result.error) {
      throw new Error(result.error.message);
    }

    for (const row of result.data ?? []) {
      ids.add(row.id);
    }
  }

  return Array.from(ids);
}

export async function getCustomerOrders(userId: string, email: string | null) {
  const admin = getSupabaseAdminClient();
  const customerIds = await getCustomerIdsForAccount(userId, email);
  const filters = [`user_id.eq.${userId}`];

  if (email) {
    filters.push(`email.eq.${email}`);
  }

  if (customerIds.length > 0) {
    filters.push(`customer_id.in.(${customerIds.join(",")})`);
  }

  const { data, error } = await admin
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
      invoices(id, invoice_number, status, rtn, cai, customer_rtn, issued_at, cancelled_at)
    `,
    )
    .or(filters.join(","))
    .order("created_at", { ascending: false })
    .limit(100)
    .returns<CustomerOrderQueryRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(normalizeOrder);
}

export async function getCustomerIssuedInvoices(userId: string, email: string | null) {
  const admin = getSupabaseAdminClient();
  const orders = await getCustomerOrders(userId, email);
  const orderIds = orders.map((order) => order.id);

  if (orderIds.length === 0) {
    return [];
  }

  const { data, error } = await admin
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
      orders(order_number, customer_name, payment_method, payments(bank_reference_number, reference)),
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
    )
    .in("order_id", orderIds)
    .in("status", ["emitida", "issued", "paid", "anulada"])
    .order("created_at", { ascending: false })
    .returns<CustomerInvoiceQueryRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(normalizeInvoice);
}
