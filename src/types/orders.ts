import type { CheckoutData, PriceMode } from "@/types/commerce";

export type OrderStatus =
  | "recibido"
  | "confirmado"
  | "preparacion"
  | "empacado"
  | "enviado"
  | "en_ruta"
  | "entregado"
  | "cancelado";

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
  paymentStatus?: PaymentReviewStatus;
};
