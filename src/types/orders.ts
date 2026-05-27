import type { CheckoutData, PriceMode } from "@/types/commerce";
import type { AdditionalFee } from "@/types/financial";

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
  trackingCode: string | null;
  customer: CheckoutData;
  items: OrderItemSnapshot[];
  priceMode: PriceMode;
  wholesaleCode: string | null;
  subtotal: number;
  tax: number;
  shippingFee: number;
  cashOnDeliveryFee: number;
  smallOrderFee: number;
  discountTotal: number;
  additionalFees: AdditionalFee[];
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

export type CreateOrderInput = Omit<StoreOrder, "id" | "orderNumber" | "trackingCode" | "status" | "createdAt" | "paymentStatus"> & {
  orderNumber?: string;
  trackingCode?: string | null;
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
  tracking_code: string | null;
  tracking_status: string | null;
  public_tracking_enabled: boolean;
  customer_id: string | null;
  customer_name: string;
  customer_phone: string | null;
  customer_rtn: string | null;
  fiscal_customer_name: string;
  fiscal_customer_rtn: string | null;
  fiscal_customer_phone: string | null;
  fiscal_customer_email: string | null;
  fiscal_customer_address: string | null;
  email: string | null;
  phone: string;
  delivery_address: string;
  delivery_country: string;
  delivery_country_code: string;
  delivery_department: string | null;
  delivery_city: string | null;
  payment_method: "bank_transfer" | "card" | "cash";
  price_mode: PriceMode;
  subtotal: number;
  tax: number;
  shipping_fee: number;
  shipping_total: number;
  cash_on_delivery_fee: number;
  small_order_fee: number;
  discount_total: number;
  additional_fees: AdditionalFee[];
  total: number;
  status: OrderStatus;
  order_reservation_status: "not_required" | "reserved" | "confirmed" | "released" | "expired" | "canceled";
  reservation_expires_at: string | null;
  created_at: string;
  order_items: AdminOrderItem[];
  payment_id: string | null;
  payment_status: "pending" | "approved" | "confirmed" | "paid" | "rejected" | "refunded" | null;
  bank_reference_number: string | null;
  transfer_receipt_url: string | null;
  transfer_receipt_public_id: string | null;
  invoice_id: string | null;
  invoice_number: string | null;
  invoice_issued_at: string | null;
  invoice_status: string | null;
  invoice_cancelled_at: string | null;
  invoice_cancellation_reason: string | null;
};
