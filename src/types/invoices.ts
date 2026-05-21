import type { StoreOrder } from "@/types/orders";

export type InvoiceStatus = "emitida" | "anulada" | "pendiente" | "draft" | "issued" | "paid" | "cancelled";

export type StoreInvoice = {
  id: string;
  invoiceNumber: string;
  orderNumber: string;
  rtn: string;
  cai: string;
  customerName: string;
  customerRtn: string | null;
  items: StoreOrder["items"];
  subtotal: number;
  isv: number;
  total: number;
  priceMode: StoreOrder["priceMode"];
  paymentMethod: StoreOrder["paymentMethod"];
  paymentReference: string | null;
  status: InvoiceStatus;
  issuedAt: string;
  cancelledAt: string | null;
};

export type CreateInvoiceInput = {
  order: StoreOrder;
  customerRtn?: string;
};

export type AdminInvoiceItem = {
  id: string;
  sku: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  retail_price_snapshot: number;
  wholesale_price_snapshot: number;
};

export type AdminInvoiceRow = {
  id: string;
  invoice_number: string;
  order_id: string;
  order_number: string;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  customer_address: string | null;
  rtn: string | null;
  cai: string | null;
  customer_rtn: string | null;
  status: InvoiceStatus;
  price_mode: StoreOrder["priceMode"];
  payment_method: string;
  payment_id: string | null;
  bank_reference_number: string | null;
  transfer_receipt_url: string | null;
  transfer_receipt_public_id: string | null;
  subtotal: number;
  tax: number;
  shipping_fee: number;
  cash_on_delivery_fee: number;
  total: number;
  issued_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  items: AdminInvoiceItem[];
};
