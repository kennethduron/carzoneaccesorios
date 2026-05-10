import type { InvoiceStatus } from "@/types/invoices";
import type { OrderStatus } from "@/types/orders";
import type { PriceMode } from "@/types/commerce";

export type ReportPaymentMethod = "bank_transfer" | "card" | "cash";

export type ReportOrderItem = {
  id: string;
  order_id: string;
  product_id: string | null;
  sku: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
};

export type ReportOrder = {
  id: string;
  order_number: string;
  customer_id: string | null;
  customer_name: string;
  phone: string;
  payment_method: ReportPaymentMethod;
  price_mode: PriceMode;
  subtotal: number;
  tax: number;
  shipping_total: number;
  total: number;
  status: OrderStatus;
  created_at: string;
  order_items: ReportOrderItem[];
};

export type ReportInvoice = {
  id: string;
  invoice_number: string;
  order_id: string;
  customer_id: string | null;
  rtn: string | null;
  cai: string | null;
  customer_rtn: string | null;
  status: InvoiceStatus;
  price_mode: PriceMode;
  subtotal: number;
  tax: number;
  total: number;
  issued_at: string | null;
  created_at: string;
};

export type ReportProduct = {
  id: string;
  sku: string;
  internal_code: string | null;
  name: string;
  brand: string;
  stock: number;
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
  is_wholesale: boolean;
  created_at: string;
};

export type ReportPayment = {
  id: string;
  order_id: string;
  payment_method: ReportPaymentMethod;
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
};
