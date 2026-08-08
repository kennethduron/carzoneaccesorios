import type { CheckoutData, PriceMode } from "@/types/commerce";
import type { AccountingTraceabilitySummary } from "@/types/accounting-traceability";
import type { CommercialCreditPaymentReceivedMethod } from "@/types/credit";
import type { AdditionalFee } from "@/types/financial";
import type { FiscalCorrectionHistoryEntry } from "@/types/fiscal-corrections";

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
  unit_cost_snapshot?: number | null;
  total_cost_snapshot?: number | null;
  cost_source?: string | null;
  cost_captured_at?: string | null;
};

export type DeliveryMode = "car_zone" | "external_company" | "store_pickup" | "customer_arranged" | "other";

export type SaleLinePriceOverride = {
  orderItemId: string;
  finalUnitPrice: number;
};

export type AdjustSaleTermsInput = {
  orderId: string;
  requestedInvoiceDate: string;
  linePriceOverrides: SaleLinePriceOverride[];
  requestedShippingFee: number;
  deliveryMode?: DeliveryMode | null;
  externalDeliveryProvider?: string | null;
  priceReason?: string | null;
  deliveryReason?: string | null;
  expectedVersion: number;
  idempotencyKey: string;
};

export type SaleFinancialSnapshot = {
  merchandise_gross_subtotal: number;
  merchandise_final: number;
  fiscal_subtotal: number;
  included_tax_total: number;
  suggested_delivery_charge: number;
  delivery_charge: number;
  cash_on_delivery_charge: number;
  minimum_order_charge: number;
  additional_charges_total: number;
  discount_total: number;
  total_final: number;
};

export type OrderPriceReviewStatus =
  | "none"
  | "authorized_manual_override"
  | "action_required"
  | "legacy_information";

export type AuthorizedPriceAdjustment = {
  auditId: string;
  orderItemId: string;
  actorName: string | null;
  actorRole: string;
  adjustedAt: string;
  versionAfter: number | null;
  automaticUnitPrice: number;
  previousUnitPrice: number;
  finalUnitPrice: number;
  note: string | null;
};

export type OrderPriceReview = {
  status: OrderPriceReviewStatus;
  reasons: string[];
  invoiceConsistent: boolean | null;
  legitimateModeFallbackItemIds: string[];
  adjustments: AuthorizedPriceAdjustment[];
};

export type OrderPriceFeatureFlags = {
  orderPriceReviewV2: boolean;
  orderPriceConfirmationModalV1: boolean;
};

export type OrderPriceAdjustmentLinePreview = {
  orderItemId: string;
  productName: string;
  sku: string;
  quantity: number;
  automaticUnitPrice: number;
  previousUnitPrice: number;
  finalUnitPrice: number;
  unitDifference: number;
  totalDifference: number;
  unitCost: number;
  resultingUnitMargin: number;
  aboveAutomaticPrice: boolean;
};

export type OrderPriceAdjustmentPreview = {
  orderId: string;
  expectedVersion: number;
  requestKey: string;
  lines: OrderPriceAdjustmentLinePreview[];
  previousFinancials: SaleFinancialSnapshot;
  nextFinancials: SaleFinancialSnapshot;
  orderTotalDifference: number;
};

export type AdminOrderRow = {
  id: string;
  order_number: string;
  source: 'web' | 'pos' | 'manual';
  channel: string;
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
  payment_method: "bank_transfer" | "card" | "cash" | "commercial_credit";
  payment_timing: "before_delivery" | "on_delivery";
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
  reservation_review_required: boolean;
  reservation_review_detected_at: string | null;
  created_at: string;
  requested_invoice_date: string | null;
  shipping_fee_suggested: number | null;
  commercial_terms_version: number;
  delivery_mode: DeliveryMode | null;
  external_delivery_provider: string | null;
  order_items: AdminOrderItem[];
  payment_id: string | null;
  payment_status: "pending" | "approved" | "confirmed" | "paid" | "rejected" | "refunded" | null;
  bank_reference_number: string | null;
  transfer_receipt_url: string | null;
  transfer_receipt_public_id: string | null;
  order_internal_notes: Array<{
    id: string;
    note: string;
    actor_role: string | null;
    created_at: string;
  }>;
  invoice_id: string | null;
  invoice_number: string | null;
  invoice_issued_at: string | null;
  invoice_date: string | null;
  invoice_status: string | null;
  invoice_cancelled_at: string | null;
  invoice_cancellation_reason: string | null;
  fiscal_correction_history: FiscalCorrectionHistoryEntry[];
  receivable_id: string | null;
  receivable_status: "open" | "partial" | "paid" | "overdue" | "cancelled" | null;
  receivable_due_date: string | null;
  receivable_balance_due: number | null;
  receivable_paid_at: string | null;
  receivable_payment_received_method: CommercialCreditPaymentReceivedMethod | null;
  receivable_payment_received_reference: string | null;
  receivable_payment_recorded_by: string | null;
  accounting_traceability: AccountingTraceabilitySummary | null;
  price_review: OrderPriceReview;
};
