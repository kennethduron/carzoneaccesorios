import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getInvoiceAccountingTraceability } from "@/services/supabase/accounting-traceability.service";
import { getFiscalCorrectionHistory } from "@/services/supabase/fiscal-corrections.service";
import type { AdminInvoiceDetail, AdminInvoiceItem, AdminInvoiceRow } from "@/types/invoices";
import { normalizeAdditionalFees } from "@/utils/financial-summary";

export type AdminInvoicesPage = {
  invoices: AdminInvoiceRow[];
  total: number;
  page: number;
  pageSize: number;
};

export type AdminInvoiceTask = "pending_invoices";

export const adminInvoiceTaskLabels: Record<AdminInvoiceTask, string> = {
  pending_invoices: "Facturas pendientes de emisión",
};

export function normalizeAdminInvoiceTask(value: string | null | undefined): AdminInvoiceTask | null {
  return value === "pending_invoices" ? value : null;
}

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

type InvoiceQueryRow = Omit<AdminInvoiceRow, "order_number" | "customer_name" | "customer_phone" | "customer_address" | "customer_city" | "customer_business_name" | "payment_method" | "payment_id" | "bank_reference_number" | "transfer_receipt_url" | "transfer_receipt_public_id" | "payment_status" | "subtotal" | "tax" | "shipping_fee" | "cash_on_delivery_fee" | "small_order_fee" | "discount_total" | "additional_fees" | "total"> & {
  subtotal: unknown;
  tax: unknown;
  shipping_fee: unknown;
  cash_on_delivery_fee: unknown;
  small_order_fee: unknown;
  discount_total: unknown;
  additional_fees: unknown;
  total: unknown;
  orders: {
    order_number: string;
    customer_name: string;
    phone: string;
    delivery_address: string;
    fiscal_customer_city: string | null;
    fiscal_customer_business_name: string | null;
    payment_method: string;
  } | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  customer_city: string | null;
  customer_business_name: string | null;
};

type PaymentQueryRow = {
  id: string;
  order_id: string;
  payment_method: string | null;
  bank_reference_number: string | null;
  reference: string | null;
  transfer_receipt_url: string | null;
  transfer_receipt_public_id: string | null;
  payment_status: string | null;
  status: string | null;
};

type InvoiceItemQueryRow = Omit<AdminInvoiceItem, "quantity" | "unit_price" | "line_total" | "retail_price_snapshot" | "wholesale_price_snapshot" | "taxable_base_snapshot" | "tax_amount_snapshot" | "exempt_amount_snapshot"> & {
  quantity: unknown;
  unit_price: unknown;
  line_total: unknown;
  retail_price_snapshot: unknown;
  wholesale_price_snapshot: unknown;
  taxable_base_snapshot: unknown;
  tax_amount_snapshot: unknown;
  exempt_amount_snapshot: unknown;
};

type InvoiceDetailQueryRow = InvoiceQueryRow & {
  customer_email: string | null;
  company_legal_name: string | null;
  company_rtn: string | null;
  company_address: string | null;
  company_phone: string | null;
  company_email: string | null;
  company_logo_url: string | null;
  fiscal_range_start: string | null;
  fiscal_range_end: string | null;
  cai_authorization_date: string | null;
  due_at: string | null;
  invoice_items: InvoiceItemQueryRow[] | null;
};

function normalizeInvoice(row: InvoiceQueryRow, paymentByOrder: Map<string, PaymentQueryRow>): AdminInvoiceRow {
  const payment = paymentByOrder.get(row.order_id);

  return {
    id: row.id,
    invoice_number: row.invoice_number,
    order_id: row.order_id,
    order_number: row.orders?.order_number ?? "-",
    customer_id: row.customer_id,
    customer_name: row.customer_name ?? row.orders?.customer_name ?? "Cliente no registrado",
    customer_phone: row.customer_phone ?? row.orders?.phone ?? null,
    customer_address: row.customer_address ?? row.orders?.delivery_address ?? null,
    customer_city: row.customer_city ?? row.orders?.fiscal_customer_city ?? null,
    customer_business_name: row.customer_business_name ?? row.orders?.fiscal_customer_business_name ?? null,
    rtn: row.rtn,
    cai: row.cai,
    customer_rtn: row.customer_rtn,
    status: row.status,
    price_mode: row.price_mode,
    payment_method: payment?.payment_method ?? row.orders?.payment_method ?? "-",
    payment_id: payment?.id ?? null,
    bank_reference_number: payment?.bank_reference_number ?? payment?.reference ?? null,
    transfer_receipt_url: payment?.transfer_receipt_public_id || payment?.transfer_receipt_url
      ? `/api/admin/transfer-receipts/${payment.id}`
      : null,
    transfer_receipt_public_id: payment?.transfer_receipt_public_id ?? null,
    payment_status: payment?.payment_status ?? payment?.status ?? null,
    subtotal: toNumber(row.subtotal),
    tax: toNumber(row.tax),
    shipping_fee: toNumber(row.shipping_fee),
    cash_on_delivery_fee: toNumber(row.cash_on_delivery_fee),
    small_order_fee: toNumber(row.small_order_fee),
    discount_total: toNumber(row.discount_total),
    additional_fees: normalizeAdditionalFees(row.additional_fees),
    total: toNumber(row.total),
    issued_at: row.issued_at,
    invoice_date: row.invoice_date,
    cancelled_at: row.cancelled_at,
    cancelled_by: row.cancelled_by,
    cancellation_reason: row.cancellation_reason,
    created_at: row.created_at,
  };
}

function normalizeItems(items: InvoiceItemQueryRow[] | null): AdminInvoiceItem[] {
  return (items ?? []).map((item) => ({
    ...item,
    quantity: toNumber(item.quantity),
    unit_price: toNumber(item.unit_price),
    line_total: toNumber(item.line_total),
    retail_price_snapshot: toNumber(item.retail_price_snapshot),
    wholesale_price_snapshot: toNumber(item.wholesale_price_snapshot),
    taxable_base_snapshot: item.taxable_base_snapshot === null ? null : toNumber(item.taxable_base_snapshot),
    tax_amount_snapshot: item.tax_amount_snapshot === null ? null : toNumber(item.tax_amount_snapshot),
    exempt_amount_snapshot: item.exempt_amount_snapshot === null ? null : toNumber(item.exempt_amount_snapshot),
  }));
}

function normalizeDetail(row: InvoiceDetailQueryRow, paymentByOrder: Map<string, PaymentQueryRow>): AdminInvoiceDetail {
  return {
    ...normalizeInvoice(row, paymentByOrder),
    customer_email: row.customer_email,
    company_legal_name: row.company_legal_name,
    company_rtn: row.company_rtn,
    company_address: row.company_address,
    company_phone: row.company_phone,
    company_email: row.company_email,
    company_logo_url: row.company_logo_url,
    fiscal_range_start: row.fiscal_range_start,
    fiscal_range_end: row.fiscal_range_end,
    cai_authorization_date: row.cai_authorization_date,
    due_at: row.due_at,
    items: normalizeItems(row.invoice_items),
    fiscal_correction_history: [],
    accounting_traceability: null,
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

export async function getAdminInvoicesPage({
  page: rawPage,
  pageSize: rawPageSize,
  task,
  focusInvoiceId,
}: {
  page?: number;
  pageSize?: number;
  task?: AdminInvoiceTask | null;
  focusInvoiceId?: string | null;
} = {}): Promise<AdminInvoicesPage> {
  const supabase = await getSupabaseServerClient();
  const page = normalizePage(rawPage);
  const pageSize = normalizePageSize(rawPageSize);
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let invoicesQuery = supabase
    .from("invoices")
    .select(
      `
      id,
      invoice_number,
      order_id,
      customer_id,
      customer_name,
      customer_phone,
      customer_address,
      customer_city,
      customer_business_name,
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
      invoice_date,
      cancelled_at,
      cancelled_by,
      cancellation_reason,
      created_at,
      orders(order_number, customer_name, phone, delivery_address, fiscal_customer_city, fiscal_customer_business_name, payment_method)
      `,
      { count: "exact" },
    );

  if (task === "pending_invoices") {
    invoicesQuery = invoicesQuery.in("status", ["draft"]);
  }

  if (focusInvoiceId) {
    invoicesQuery = invoicesQuery.eq('id', focusInvoiceId);
  }

  const { data: invoices, error: invoicesError, count } = await invoicesQuery
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
      .select("id, order_id, payment_method, payment_status, status, bank_reference_number, reference, transfer_receipt_url, transfer_receipt_public_id")
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

export async function getAdminInvoiceDetail(
  invoiceId: string,
  options: { includeAccountingTraceability?: boolean } = {},
): Promise<AdminInvoiceDetail | null> {
  const supabase = await getSupabaseServerClient();
  const { data: invoice, error } = await supabase
    .from("invoices")
    .select(
      `
      id,
      invoice_number,
      order_id,
      customer_id,
      customer_name,
      customer_phone,
      customer_email,
      customer_address,
      customer_city,
      customer_business_name,
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
      invoice_date,
      cancelled_at,
      cancelled_by,
      cancellation_reason,
      due_at,
      company_legal_name,
      company_rtn,
      company_address,
      company_phone,
      company_email,
      company_logo_url,
      fiscal_range_start,
      fiscal_range_end,
      cai_authorization_date,
      created_at,
      orders(order_number, customer_name, phone, delivery_address, fiscal_customer_city, fiscal_customer_business_name, payment_method),
      invoice_items(
        id,
        sku,
        product_name,
        quantity,
        unit_price,
        line_total,
        retail_price_snapshot,
        wholesale_price_snapshot,
        tax_category_snapshot,
        taxable_base_snapshot,
        tax_amount_snapshot,
        exempt_amount_snapshot
      )
    `,
    )
    .eq("id", invoiceId)
    .maybeSingle<InvoiceDetailQueryRow>();

  if (error) {
    throw new Error(error.message);
  }

  if (!invoice) {
    return null;
  }

  const { data: payments, error: paymentError } = await supabase
    .from("payments")
    .select("id, order_id, payment_method, payment_status, status, bank_reference_number, reference, transfer_receipt_url, transfer_receipt_public_id")
    .eq("order_id", invoice.order_id)
    .order("created_at", { ascending: false })
    .returns<PaymentQueryRow[]>();

  if (paymentError) {
    throw new Error(paymentError.message);
  }

  const paymentByOrder = new Map<string, PaymentQueryRow>();
  const payment = payments?.[0] ?? null;
  if (payment) {
    paymentByOrder.set(invoice.order_id, payment);
  }

  const detail = normalizeDetail(invoice, paymentByOrder);
  detail.fiscal_correction_history = await getFiscalCorrectionHistory({
    orderId: invoice.order_id,
    invoiceId,
  });
  detail.accounting_traceability = options.includeAccountingTraceability
    ? await getInvoiceAccountingTraceability({
        invoiceId,
        orderId: invoice.order_id,
        paymentId: payment?.id,
      })
    : null;

  return detail;
}
