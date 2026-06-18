import type { PriceMode } from "@/types/commerce";
import type { AdditionalFee } from "@/types/financial";
import type { InvoiceStatus } from "@/types/invoices";
import type { OrderStatus } from "@/types/orders";

export type ReportPaymentMethod = "bank_transfer" | "card" | "cash" | "commercial_credit";
export type ReportAccessMode = "full" | "limited" | "fiscal";

export type ReportFilters = {
  page?: number;
  pageSize?: number;
  startDate?: string;
  endDate?: string;
  customer?: string;
  product?: string;
  sku?: string;
  invoice?: string;
  paymentMethod?: ReportPaymentMethod | "all";
  priceMode?: PriceMode | "all";
  invoiceStatus?: InvoiceStatus | "all";
  orderStatus?: OrderStatus | "all";
};

export type ReportInvoiceSummary = {
  id: string;
  invoice_number: string;
  issued_at: string | null;
  status: InvoiceStatus | string | null;
  cancelled_at: string | null;
};

export type ReportOrderItem = {
  id: string;
  order_id: string;
  product_id: string | null;
  sku: string;
  product_name: string;
  quantity: number;
  applied_price_mode: PriceMode;
  unit_price: number;
  line_total: number;
  retail_price_snapshot: number;
  wholesale_price_snapshot: number;
};

export type ReportOrder = {
  id: string;
  order_number: string;
  customer_id: string | null;
  customer_name: string;
  customer_rtn: string | null;
  customer_business_name: string | null;
  email: string | null;
  phone: string;
  payment_method: ReportPaymentMethod;
  payment_status: string | null;
  order_reservation_status: string;
  reservation_review_required: boolean;
  price_mode: PriceMode;
  subtotal: number;
  tax: number;
  shipping_total: number;
  shipping_fee: number;
  cash_on_delivery_fee: number;
  small_order_fee: number;
  discount_total: number;
  additional_fees: AdditionalFee[];
  total: number;
  status: OrderStatus;
  created_at: string;
  order_items: ReportOrderItem[];
  invoices: ReportInvoiceSummary[];
};

export type ReportInvoiceItem = {
  id: string;
  invoice_id: string;
  order_item_id: string | null;
  product_id: string | null;
  sku: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  retail_price_snapshot: number;
  wholesale_price_snapshot: number;
};

export type ReportInvoice = {
  id: string;
  invoice_number: string;
  order_id: string;
  order_number: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  customer_business_name: string | null;
  rtn: string | null;
  cai: string | null;
  customer_rtn: string | null;
  status: InvoiceStatus;
  price_mode: PriceMode;
  payment_method: ReportPaymentMethod | null;
  bank_reference_number: string | null;
  reference: string | null;
  subtotal: number;
  tax: number;
  shipping_fee: number;
  cash_on_delivery_fee: number;
  small_order_fee: number;
  discount_total: number;
  additional_fees: AdditionalFee[];
  total: number;
  issued_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  invoice_items: ReportInvoiceItem[];
};

export type ReportProduct = {
  id: string;
  sku: string;
  internal_code: string | null;
  name: string;
  brand: string;
  stock: number;
  reserved_stock: number;
  available_stock: number;
  min_stock: number;
  retail_price: number;
  wholesale_price: number;
  cost_price: number;
  status: string;
};

export type ReportCustomer = {
  id: string;
  business_name: string | null;
  contact_name: string;
  email: string | null;
  phone: string;
  tax_id: string | null;
  is_wholesale: boolean;
  created_at: string;
};

export type ReportPayment = {
  id: string;
  order_id: string;
  payment_method: ReportPaymentMethod;
  payment_status: string | null;
  status: string | null;
  bank_reference_number: string | null;
  reference: string | null;
  amount: number;
  created_at: string;
};

export type AdminReportsData = {
  orders: ReportOrder[];
  invoices: ReportInvoice[];
  products: ReportProduct[];
  customers: ReportCustomer[];
  payments: ReportPayment[];
  totalRecords: number;
  page: number;
  pageSize: number;
  filters: Required<Omit<ReportFilters, "page" | "pageSize">>;
};
