export type PosPriceRequestStatus =
  | "pending" | "approved" | "rejected" | "cancelled"
  | "consumed" | "revoked" | "expired";

export type PosPriceRequestEvent = {
  id: number;
  type: string;
  fromStatus: string | null;
  toStatus: PosPriceRequestStatus;
  reason: string | null;
  createdAt: string;
};

export type PosPriceRequest = {
  requestId: string;
  requestKey: string;
  sellerId: string;
  sellerName: string;
  draftId: string;
  draftVersion: number;
  itemId: string;
  customerId: string;
  customerName: string;
  customerCommercialVersion: number;
  productId: string;
  productSalesVersion: number;
  productName: string;
  sku: string;
  quantity: number;
  baseUnitPrice: number;
  requestedUnitPrice: number;
  difference: number;
  variationPercent: number;
  reason: string;
  status: PosPriceRequestStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionReason: string | null;
  expiresAt: string | null;
  consumedAt: string | null;
  consumedOrderId: string | null;
  events: PosPriceRequestEvent[];
  idempotentReplay?: boolean;
};

export type PosPriceRequestPage = {
  results: PosPriceRequest[];
  total: number;
  sellers: Array<{ id: string; name: string }>;
  counts: { pending: number; approvedToday: number; rejectedToday: number };
};

export type MyPosSale = {
  orderId: string;
  orderNumber: string;
  createdAt: string;
  customerName: string;
  total: number;
  paymentMethod: string;
  status: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  collectedAmount: number;
  balanceDue: number;
  receivableStatus: string | null;
  sellerName: string;
  commission: null | {
    entryId: string;
    status: "ACCRUED" | "PARTIALLY_EARNED" | "EARNED" | "VOIDED" | "REVERSED";
    potential: number;
    earned: number;
    remaining: number;
    reversed: number;
  };
};

export type MyPosSalesPage = {
  results: MyPosSale[];
  total: number;
  summary: {
    salesCount: number; soldAmount: number; collectedAmount: number; pendingAmount: number;
    deliveredCount: number; pendingCount: number; cancelledCount: number;
  };
  from: string;
  to: string;
};

export type MyPosSaleDetail = MyPosSale & {
  subtotal: number;
  tax: number;
  invoice: null | { invoiceId: string; invoiceNumber: string; status: string; issuedAt: string | null; total: number };
  collection: { collectedAmount: number; balanceDue: number; status: string };
  items: Array<{ itemId: string; productId: string | null; sku: string; productName: string; quantity: number; unitPrice: number; lineTotal: number; priceAuthorized: boolean }>;
};
