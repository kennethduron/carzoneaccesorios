import type { StoreOrder } from "@/types/orders";

export type InvoiceStatus = "emitida" | "anulada";

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
