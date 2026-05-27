import type { StoreOrder } from "@/types/orders";
import type { AdditionalFee } from "@/types/financial";
import type { FiscalCorrectionHistoryEntry } from "@/types/fiscal-corrections";

export type InvoiceStatus = "emitida" | "anulada" | "pendiente" | "draft" | "issued" | "paid" | "cancelled";

export type StoreInvoice = {
  id: string;
  invoiceNumber: string;
  orderNumber: string;
  rtn: string;
  cai: string;
  companyLegalName: string | null;
  companyRtn: string | null;
  companyAddress: string | null;
  companyPhone: string | null;
  companyEmail: string | null;
  companyLogoUrl: string | null;
  fiscalRangeStart: string | null;
  fiscalRangeEnd: string | null;
  fiscalDeadline: string | null;
  customerName: string;
  customerRtn: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  customerAddress: string | null;
  items: StoreOrder["items"];
  subtotal: number;
  isv: number;
  shippingFee: number;
  cashOnDeliveryFee: number;
  smallOrderFee: number;
  discountTotal: number;
  additionalFees: AdditionalFee[];
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
  payment_status: string | null;
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
  cancelled_by: string | null;
  cancellation_reason: string | null;
  created_at: string;
};

export type AdminInvoiceDetail = AdminInvoiceRow & {
  customer_email: string | null;
  company_legal_name: string | null;
  company_rtn: string | null;
  company_address: string | null;
  company_phone: string | null;
  company_email: string | null;
  company_logo_url: string | null;
  fiscal_range_start: string | null;
  fiscal_range_end: string | null;
  due_at: string | null;
  items: AdminInvoiceItem[];
  fiscal_correction_history: FiscalCorrectionHistoryEntry[];
};
