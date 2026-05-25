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

export type CustomerAccountSummary = {
  phone: string | null;
  registeredAt: string | null;
  emailConfirmed: boolean;
  orderCount: number;
  totalPurchased: number;
  issuedInvoiceCount: number;
};

export type CustomerOrdersPage = {
  orders: CustomerOrderRow[];
  total: number;
  page: number;
  pageSize: number;
};

export type CustomerInvoicesPage = {
  invoices: StoreInvoice[];
  total: number;
  page: number;
  pageSize: number;
};

type CustomerAccountSummaryRow = {
  order_count: number | null;
  total_purchased: unknown;
  issued_invoice_count: number | null;
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
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  customer_address: string | null;
  company_legal_name: string | null;
  company_rtn: string | null;
  company_address: string | null;
  company_phone: string | null;
  company_email: string | null;
  company_logo_url: string | null;
  fiscal_range_start: string | null;
  fiscal_range_end: string | null;
  due_at: string | null;
  shipping_fee: unknown;
  cash_on_delivery_fee: unknown;
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

function normalizePage(value: unknown) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizePageSize(value: unknown) {
  const pageSize = Number(value);
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return 20;
  }

  return Math.min(Math.floor(pageSize), 50);
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
    companyLegalName: row.company_legal_name,
    companyRtn: row.company_rtn,
    companyAddress: row.company_address,
    companyPhone: row.company_phone,
    companyEmail: row.company_email,
    companyLogoUrl: row.company_logo_url,
    fiscalRangeStart: row.fiscal_range_start,
    fiscalRangeEnd: row.fiscal_range_end,
    fiscalDeadline: row.due_at,
    customerName: row.customer_name ?? row.orders?.customer_name ?? "Cliente",
    customerRtn: row.customer_rtn,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    customerAddress: row.customer_address,
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
    shippingFee: toNumber(row.shipping_fee),
    cashOnDeliveryFee: toNumber(row.cash_on_delivery_fee),
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

async function getCustomerOrderFilters(userId: string, email: string | null) {
  const customerIds = await getCustomerIdsForAccount(userId, email);
  const filters = [`user_id.eq.${userId}`];

  if (email) {
    filters.push(`email.eq.${email}`);
  }

  if (customerIds.length > 0) {
    filters.push(`customer_id.in.(${customerIds.join(",")})`);
  }

  return filters;
}

async function getCustomerOrderIds(userId: string, email: string | null, limit = 500) {
  const admin = getSupabaseAdminClient();
  const filters = await getCustomerOrderFilters(userId, email);
  const { data, error } = await admin
    .from("orders")
    .select("id")
    .or(filters.join(","))
    .order("created_at", { ascending: false })
    .limit(limit)
    .returns<Array<{ id: string }>>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map((order) => order.id);
}

export async function getCustomerAccountSummary(userId: string, email: string | null): Promise<CustomerAccountSummary> {
  const admin = getSupabaseAdminClient();
  const [{ data: profile }, authResult, summaryResult] = await Promise.all([
    admin
      .from("users")
      .select("phone, created_at")
      .eq("id", userId)
      .maybeSingle<{ phone: string | null; created_at: string | null }>(),
    admin.auth.admin.getUserById(userId),
    admin
      .rpc("get_customer_account_summary", {
        target_user_id: userId,
        target_email: email,
      })
      .single<CustomerAccountSummaryRow>(),
  ]);

  const summary = summaryResult.data ?? null;

  return {
    phone: profile?.phone ?? null,
    registeredAt: profile?.created_at ?? authResult.data.user?.created_at ?? null,
    emailConfirmed: Boolean(authResult.data.user?.email_confirmed_at || authResult.data.user?.confirmed_at),
    orderCount: summary?.order_count ?? 0,
    totalPurchased: toNumber(summary?.total_purchased),
    issuedInvoiceCount: summary?.issued_invoice_count ?? 0,
  };
}

export async function getCustomerOrdersPage(
  userId: string,
  email: string | null,
  { page: rawPage, pageSize: rawPageSize }: { page?: number; pageSize?: number } = {},
): Promise<CustomerOrdersPage> {
  const admin = getSupabaseAdminClient();
  const filters = await getCustomerOrderFilters(userId, email);
  const page = normalizePage(rawPage);
  const pageSize = normalizePageSize(rawPageSize);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await admin
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
      { count: "exact" },
    )
    .or(filters.join(","))
    .order("created_at", { ascending: false })
    .range(from, to)
    .returns<CustomerOrderQueryRow[]>();

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

export async function getCustomerOrders(userId: string, email: string | null, limit = 20) {
  const page = await getCustomerOrdersPage(userId, email, { page: 1, pageSize: limit });
  return page.orders;
}

export async function getCustomerIssuedInvoicesPage(
  userId: string,
  email: string | null,
  { page: rawPage, pageSize: rawPageSize }: { page?: number; pageSize?: number } = {},
): Promise<CustomerInvoicesPage> {
  const admin = getSupabaseAdminClient();
  const page = normalizePage(rawPage);
  const pageSize = normalizePageSize(rawPageSize);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const orderIds = await getCustomerOrderIds(userId, email);

  if (orderIds.length === 0) {
    return {
      invoices: [],
      total: 0,
      page,
      pageSize,
    };
  }

  const { data, error, count } = await admin
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
      customer_name,
      customer_phone,
      customer_email,
      customer_address,
      company_legal_name,
      company_rtn,
      company_address,
      company_phone,
      company_email,
      company_logo_url,
      fiscal_range_start,
      fiscal_range_end,
      due_at,
      status,
      price_mode,
      subtotal,
      tax,
      shipping_fee,
      cash_on_delivery_fee,
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
      { count: "exact" },
    )
    .in("order_id", orderIds)
    .in("status", ["emitida", "issued", "paid", "anulada"])
    .order("created_at", { ascending: false })
    .range(from, to)
    .returns<CustomerInvoiceQueryRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return {
    invoices: (data ?? []).map(normalizeInvoice),
    total: count ?? 0,
    page,
    pageSize,
  };
}

export async function getCustomerIssuedInvoices(userId: string, email: string | null, limit = 20) {
  const page = await getCustomerIssuedInvoicesPage(userId, email, { page: 1, pageSize: limit });
  return page.invoices;
}
