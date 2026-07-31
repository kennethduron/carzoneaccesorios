import type { PriceMode } from '@/types/commerce';

export type CheckoutRequestStatus =
  | 'started'
  | 'processing'
  | 'committed'
  | 'failed_retryable'
  | 'failed_final'
  | 'conflict'
  | 'expired';

export type CheckoutV4Code =
  | 'CHECKOUT_SESSION_REQUIRED'
  | 'CHECKOUT_CUSTOMER_LINK_REQUIRED'
  | 'CHECKOUT_COMMERCIAL_CONTEXT_UNAVAILABLE'
  | 'CHECKOUT_COMMERCIAL_CONTEXT_CHANGED'
  | 'CHECKOUT_PRICE_CHANGED'
  | 'CHECKOUT_STOCK_CHANGED'
  | 'CHECKOUT_WHOLESALE_PRICE_UNAVAILABLE'
  | 'CHECKOUT_WHOLESALE_MINIMUM_QUANTITY'
  | 'CHECKOUT_WHOLESALE_FIRST_MINIMUM'
  | 'CHECKOUT_REQUEST_CONFLICT'
  | 'CHECKOUT_REQUEST_EXPIRED'
  | 'CHECKOUT_REQUEST_NOT_FOUND'
  | 'CHECKOUT_CREDIT_LIMIT_EXCEEDED'
  | 'CHECKOUT_PAYMENT_METHOD_UNAVAILABLE'
  | 'CHECKOUT_BANK_REFERENCE_REQUIRED'
  | 'CHECKOUT_PRODUCT_UNAVAILABLE'
  | 'CHECKOUT_TEMPORARILY_UNAVAILABLE';

export type CheckoutV4Result = {
  ok: boolean;
  message: string;
  code?: CheckoutV4Code | string;
  checkoutVersion?: 3 | 4;
  requestStatus?: CheckoutRequestStatus;
  replayed?: boolean;
  retryAllowed?: boolean;
  orderNumber?: string;
  trackingCode?: string;
  createdAt?: string;
  priceMode?: PriceMode;
  subtotal?: number;
  tax?: number;
  shipping?: number;
  total?: number;
  emailStatus?: 'queued' | 'not_queued';
  transferReceiptUrl?: string | null;
};

export type CheckoutRecoveryAttempt = {
  version: 4;
  requestKey: string;
  recoveryToken: string;
  payloadSignature: string;
  actorScope: 'guest' | 'authenticated';
  commercialVersion: number | null;
  contextToken: string | null;
  cartFingerprint: string | null;
  startedAt: string;
  result?: {
    orderNumber: string;
    trackingCode: string;
    createdAt: string;
    priceMode: PriceMode;
    total: number;
  };
};
