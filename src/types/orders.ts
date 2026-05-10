import type { CheckoutData, PriceMode } from "@/types/commerce";

export type OrderStatus =
  | "recibido"
  | "confirmado"
  | "preparacion"
  | "empacado"
  | "enviado"
  | "en_ruta"
  | "entregado"
  | "cancelado"
  | "pending"
  | "confirmed"
  | "paid"
  | "preparing"
  | "shipped"
  | "delivered"
  | "cancelled";

export type PaymentReviewStatus = "pending_review" | "confirmed" | "rejected";

export type OrderItemSnapshot = {
  productId: string;
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  retailPriceSnapshot: number;
  wholesalePriceSnapshot: number;
};

export type StoreOrder = {
  id: string;
  orderNumber: string;
  customer: CheckoutData;
  items: OrderItemSnapshot[];
  priceMode: PriceMode;
  wholesaleCode: string | null;
  subtotal: number;
  tax: number;
  total: number;
  paymentMethod: CheckoutData["paymentMethod"];
  paymentReference: string | null;
  paymentProofFileName: string | null;
  paymentStatus: PaymentReviewStatus;
  status: OrderStatus;
  address: string;
  phone: string;
  customerPhone: string;
  createdAt: string;
};

export type CreateOrderInput = Omit<StoreOrder, "id" | "orderNumber" | "status" | "createdAt" | "paymentStatus"> & {
  orderNumber?: string;
  paymentStatus?: PaymentReviewStatus;
};

export type AdminOrderItem = {
  id: string;
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

export type AdminOrderRow = {
  id: string;
  order_number: string;
  customer_id: string | null;
  customer_name: string;
  customer_rtn: string | null;
  email: string | null;
  phone: string;
  delivery_address: string;
  payment_method: "bank_transfer" | "card" | "cash";
  price_mode: PriceMode;
  subtotal: number;
  tax: number;
  shipping_total: number;
  total: number;
  status: OrderStatus;
  created_at: string;
  order_items: AdminOrderItem[];
  payment_status: "pending" | "approved" | "rejected" | "refunded" | null;
  bank_reference_number: string | null;
  transfer_receipt_url: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
};
