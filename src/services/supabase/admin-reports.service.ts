import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  AdminReportsData,
  ReportCustomer,
  ReportFilters,
  ReportInvoice,
  ReportInvoiceItem,
  ReportOrder,
  ReportOrderItem,
  ReportPayment,
  ReportPaymentMethod,
  ReportProduct,
} from "@/types/reports";
import { normalizeAdditionalFees } from "@/utils/financial-summary";

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
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

function dateStart(value: string) {
  return value ? `${value}T00:00:00-06:00` : "";
}

function dateEnd(value: string) {
  return value ? `${value}T23:59:59.999-06:00` : "";
}

function like(value: string) {
  return `%${value.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
}

function normalizeFilters(input: ReportFilters = {}): AdminReportsData["filters"] {
  return {
    startDate: cleanText(input.startDate),
    endDate: cleanText(input.endDate),
    customer: cleanText(input.customer),
    product: cleanText(input.product),
    sku: cleanText(input.sku),
    invoice: cleanText(input.invoice),
    paymentMethod: input.paymentMethod ?? "all",
    priceMode: input.priceMode ?? "all",
    invoiceStatus: input.invoiceStatus ?? "all",
    orderStatus: input.orderStatus ?? "all",
  };
}

type OrderQueryRow = Omit<
  ReportOrder,
  | "subtotal"
  | "tax"
  | "shipping_total"
  | "shipping_fee"
  | "cash_on_delivery_fee"
  | "small_order_fee"
  | "discount_total"
  | "additional_fees"
  | "total"
  | "order_items"
  | "invoices"
  | "customer_rtn"
  | "customer_business_name"
> & {
  subtotal: unknown;
  tax: unknown;
  shipping_total: unknown;
  shipping_fee: unknown;
  cash_on_delivery_fee: unknown;
  small_order_fee: unknown;
  discount_total: unknown;
  additional_fees: unknown;
  total: unknown;
  order_items: Array<Omit<ReportOrderItem, "quantity" | "unit_price" | "line_total" | "retail_price_snapshot" | "wholesale_price_snapshot"> & {
    quantity: unknown;
    unit_price: unknown;
    line_total: unknown;
    retail_price_snapshot: unknown;
    wholesale_price_snapshot: unknown;
  }> | null;
  invoices: ReportInvoiceSummaryQuery[] | ReportInvoiceSummaryQuery | null;
  customers: {
    tax_id: string | null;
    business_name: string | null;
    email: string | null;
    is_wholesale: boolean | null;
  } | null;
};

type ReportInvoiceSummaryQuery = {
  id: string;
  invoice_number: string;
  issued_at: string | null;
  status: string | null;
  cancelled_at: string | null;
};

type InvoiceQueryRow = Omit<
  ReportInvoice,
  | "subtotal"
  | "tax"
  | "shipping_fee"
  | "cash_on_delivery_fee"
  | "small_order_fee"
  | "discount_total"
  | "additional_fees"
  | "total"
  | "payment_method"
  | "bank_reference_number"
  | "reference"
  | "invoice_items"
  | "order_number"
  | "customer_business_name"
> & {
  subtotal: unknown;
  tax: unknown;
  shipping_fee: unknown;
  cash_on_delivery_fee: unknown;
  small_order_fee: unknown;
  discount_total: unknown;
  additional_fees: unknown;
  total: unknown;
  invoice_items: Array<Omit<ReportInvoiceItem, "quantity" | "unit_price" | "line_total" | "retail_price_snapshot" | "wholesale_price_snapshot"> & {
    quantity: unknown;
    unit_price: unknown;
    line_total: unknown;
    retail_price_snapshot: unknown;
    wholesale_price_snapshot: unknown;
  }> | null;
  orders: {
    order_number: string;
    payment_method: ReportPaymentMethod;
    customers: {
      business_name: string | null;
    } | null;
  } | null;
};

type ProductQueryRow = Omit<
  ReportProduct,
  "stock" | "reserved_stock" | "available_stock" | "min_stock" | "retail_price" | "wholesale_price" | "cost_price"
> & {
  stock: unknown;
  reserved_stock: unknown;
  available_stock: unknown;
  min_stock: unknown;
  retail_price: unknown;
  wholesale_price: unknown;
  cost_price: unknown;
};

type PaymentQueryRow = Omit<ReportPayment, "amount"> & {
  amount: unknown;
};

function normalizeOrder(row: OrderQueryRow): ReportOrder {
  const invoices = Array.isArray(row.invoices) ? row.invoices : row.invoices ? [row.invoices] : [];

  return {
    ...row,
    customer_rtn: row.customers?.tax_id ?? null,
    customer_business_name: row.customers?.business_name ?? null,
    subtotal: toNumber(row.subtotal),
    tax: toNumber(row.tax),
    shipping_total: toNumber(row.shipping_total),
    shipping_fee: toNumber(row.shipping_fee),
    cash_on_delivery_fee: toNumber(row.cash_on_delivery_fee),
    small_order_fee: toNumber(row.small_order_fee),
    discount_total: toNumber(row.discount_total),
    additional_fees: normalizeAdditionalFees(row.additional_fees),
    total: toNumber(row.total),
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

function normalizeInvoice(row: InvoiceQueryRow, paymentByOrder: Map<string, PaymentQueryRow>): ReportInvoice {
  const payment = paymentByOrder.get(row.order_id);

  return {
    ...row,
    order_number: row.orders?.order_number ?? null,
    customer_business_name: row.orders?.customers?.business_name ?? null,
    payment_method: payment?.payment_method ?? row.orders?.payment_method ?? null,
    bank_reference_number: payment?.bank_reference_number ?? null,
    reference: payment?.reference ?? null,
    subtotal: toNumber(row.subtotal),
    tax: toNumber(row.tax),
    shipping_fee: toNumber(row.shipping_fee),
    cash_on_delivery_fee: toNumber(row.cash_on_delivery_fee),
    small_order_fee: toNumber(row.small_order_fee),
    discount_total: toNumber(row.discount_total),
    additional_fees: normalizeAdditionalFees(row.additional_fees),
    total: toNumber(row.total),
    invoice_items: (row.invoice_items ?? []).map((item) => ({
      ...item,
      quantity: toNumber(item.quantity),
      unit_price: toNumber(item.unit_price),
      line_total: toNumber(item.line_total),
      retail_price_snapshot: toNumber(item.retail_price_snapshot),
      wholesale_price_snapshot: toNumber(item.wholesale_price_snapshot),
    })),
  };
}

function normalizeProduct(row: ProductQueryRow): ReportProduct {
  const stock = toNumber(row.stock);
  const reservedStock = toNumber(row.reserved_stock);

  return {
    ...row,
    stock,
    reserved_stock: reservedStock,
    available_stock: toNumber(row.available_stock ?? Math.max(stock - reservedStock, 0)),
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

async function findOrderIdsByItemFilters(filters: AdminReportsData["filters"]) {
  if (!filters.product && !filters.sku) {
    return null;
  }

  const supabase = await getSupabaseServerClient();
  let query = supabase.from("order_items").select("order_id");

  if (filters.product) {
    query = query.ilike("product_name", like(filters.product));
  }

  if (filters.sku) {
    query = query.ilike("sku", like(filters.sku));
  }

  const { data, error } = await query.limit(1000).returns<Array<{ order_id: string }>>();
  if (error) {
    throw new Error(error.message);
  }

  return [...new Set((data ?? []).map((row) => row.order_id))];
}

async function findOrderIdsByInvoiceFilters(filters: AdminReportsData["filters"]) {
  if (!filters.invoice && filters.invoiceStatus === "all") {
    return null;
  }

  const supabase = await getSupabaseServerClient();
  let query = supabase.from("invoices").select("order_id");

  if (filters.invoice) {
    query = query.ilike("invoice_number", like(filters.invoice));
  }

  if (filters.invoiceStatus !== "all") {
    query = query.eq("status", filters.invoiceStatus);
  }

  const { data, error } = await query.limit(1000).returns<Array<{ order_id: string }>>();
  if (error) {
    throw new Error(error.message);
  }

  return [...new Set((data ?? []).map((row) => row.order_id))];
}

function intersectOrderIds(left: string[] | null, right: string[] | null) {
  if (left === null) {
    return right;
  }

  if (right === null) {
    return left;
  }

  const rightSet = new Set(right);
  return left.filter((id) => rightSet.has(id));
}

export async function getAdminReports(input: ReportFilters = {}): Promise<AdminReportsData> {
  const supabase = await getSupabaseServerClient();
  const page = normalizePage(input.page);
  const pageSize = normalizePageSize(input.pageSize);
  const filters = normalizeFilters(input);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const itemOrderIds = await findOrderIdsByItemFilters(filters);
  const invoiceOrderIds = await findOrderIdsByInvoiceFilters(filters);
  const filteredOrderIds = intersectOrderIds(itemOrderIds, invoiceOrderIds);

  if (filteredOrderIds?.length === 0) {
    return {
      orders: [],
      invoices: [],
      products: [],
      customers: [],
      payments: [],
      totalRecords: 0,
      page,
      pageSize,
      filters,
    };
  }

  let ordersQuery = supabase
    .from("orders")
    .select(
      `
      id,
      order_number,
      customer_id,
      customer_name,
      email,
      phone,
      payment_method,
      price_mode,
      subtotal,
      tax,
      shipping_total,
      shipping_fee,
      cash_on_delivery_fee,
      small_order_fee,
      discount_total,
      additional_fees,
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
        applied_price_mode,
        unit_price,
        line_total,
        retail_price_snapshot,
        wholesale_price_snapshot
      ),
      invoices(id, invoice_number, issued_at, status, cancelled_at),
      customers(tax_id, business_name, email, is_wholesale)
      `,
      { count: "exact" },
    );

  if (filters.startDate) {
    ordersQuery = ordersQuery.gte("created_at", dateStart(filters.startDate));
  }

  if (filters.endDate) {
    ordersQuery = ordersQuery.lte("created_at", dateEnd(filters.endDate));
  }

  if (filters.paymentMethod !== "all") {
    ordersQuery = ordersQuery.eq("payment_method", filters.paymentMethod);
  }

  if (filters.priceMode !== "all") {
    ordersQuery = ordersQuery.eq("price_mode", filters.priceMode);
  }

  if (filters.orderStatus !== "all") {
    ordersQuery = ordersQuery.eq("status", filters.orderStatus);
  }

  if (filters.customer) {
    const search = like(filters.customer);
    ordersQuery = ordersQuery.or(`customer_name.ilike.${search},email.ilike.${search},phone.ilike.${search}`);
  }

  if (filteredOrderIds) {
    ordersQuery = ordersQuery.in("id", filteredOrderIds);
  }

  let invoicesQuery = supabase
    .from("invoices")
    .select(
      `
      id,
      invoice_number,
      order_id,
      customer_id,
      customer_name,
      customer_email,
      customer_phone,
      rtn,
      cai,
      customer_rtn,
      status,
      price_mode,
      subtotal,
      tax,
      shipping_fee,
      cash_on_delivery_fee,
      small_order_fee,
      discount_total,
      additional_fees,
      total,
      issued_at,
      cancelled_at,
      created_at,
      invoice_items(
        id,
        invoice_id,
        order_item_id,
        product_id,
        sku,
        product_name,
        quantity,
        unit_price,
        line_total,
        retail_price_snapshot,
        wholesale_price_snapshot
      ),
      orders(order_number, payment_method, customers(business_name))
      `,
      { count: "exact" },
    );

  if (filters.startDate) {
    invoicesQuery = invoicesQuery.gte("created_at", dateStart(filters.startDate));
  }

  if (filters.endDate) {
    invoicesQuery = invoicesQuery.lte("created_at", dateEnd(filters.endDate));
  }

  if (filters.invoice) {
    invoicesQuery = invoicesQuery.ilike("invoice_number", like(filters.invoice));
  }

  if (filters.invoiceStatus !== "all") {
    invoicesQuery = invoicesQuery.eq("status", filters.invoiceStatus);
  }

  if (filters.priceMode !== "all") {
    invoicesQuery = invoicesQuery.eq("price_mode", filters.priceMode);
  }

  if (filters.customer) {
    const search = like(filters.customer);
    invoicesQuery = invoicesQuery.or(`customer_name.ilike.${search},customer_email.ilike.${search},customer_phone.ilike.${search},customer_rtn.ilike.${search}`);
  }

  if (filteredOrderIds) {
    invoicesQuery = invoicesQuery.in("order_id", filteredOrderIds);
  }

  let productsQuery = supabase
    .from("products")
    .select(
      "id, sku, internal_code, name, brand, stock, reserved_stock, available_stock, min_stock, retail_price, wholesale_price, cost_price, status",
      { count: "exact" },
    );

  if (filters.product) {
    productsQuery = productsQuery.ilike("name", like(filters.product));
  }

  if (filters.sku) {
    productsQuery = productsQuery.ilike("sku", like(filters.sku));
  }

  let customersQuery = supabase
    .from("customers")
    .select("id, business_name, contact_name, email, phone, tax_id, is_wholesale, created_at", { count: "exact" });

  if (filters.customer) {
    const search = like(filters.customer);
    customersQuery = customersQuery.or(`contact_name.ilike.${search},business_name.ilike.${search},email.ilike.${search},phone.ilike.${search},tax_id.ilike.${search}`);
  }

  let paymentsQuery = supabase
    .from("payments")
    .select("id, order_id, payment_method, payment_status, status, bank_reference_number, reference, amount, created_at", { count: "exact" });

  if (filters.startDate) {
    paymentsQuery = paymentsQuery.gte("created_at", dateStart(filters.startDate));
  }

  if (filters.endDate) {
    paymentsQuery = paymentsQuery.lte("created_at", dateEnd(filters.endDate));
  }

  if (filters.paymentMethod !== "all") {
    paymentsQuery = paymentsQuery.eq("payment_method", filters.paymentMethod);
  }

  if (filteredOrderIds) {
    paymentsQuery = paymentsQuery.in("order_id", filteredOrderIds);
  }

  const [
    { data: orders, error: ordersError, count: ordersTotal },
    { data: invoices, error: invoicesError, count: invoicesTotal },
    { data: products, error: productsError, count: productsTotal },
    { data: customers, error: customersError, count: customersTotal },
    { data: payments, error: paymentsError, count: paymentsTotal },
  ] = await Promise.all([
    ordersQuery.order("created_at", { ascending: false }).range(from, to).returns<OrderQueryRow[]>(),
    invoicesQuery.order("created_at", { ascending: false }).range(from, to).returns<InvoiceQueryRow[]>(),
    productsQuery.order("name", { ascending: true }).range(from, to).returns<ProductQueryRow[]>(),
    customersQuery.order("created_at", { ascending: false }).range(from, to).returns<ReportCustomer[]>(),
    paymentsQuery.order("created_at", { ascending: false }).range(from, to).returns<PaymentQueryRow[]>(),
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

  const invoiceOrderIdsForPayments = [...new Set((invoices ?? []).map((invoice) => invoice.order_id))];
  let invoicePayments: PaymentQueryRow[] = [];

  if (invoiceOrderIdsForPayments.length > 0) {
    const { data, error } = await supabase
      .from("payments")
      .select("id, order_id, payment_method, payment_status, status, bank_reference_number, reference, amount, created_at")
      .in("order_id", invoiceOrderIdsForPayments)
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
    filters,
  };
}
