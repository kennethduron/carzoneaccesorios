export type PosSource = "web" | "pos" | "manual";
export type PosChannel = "website" | "store" | "whatsapp" | "phone" | "other";
export type PosDeliveryMode = "store_immediate" | "home_delivery" | "cash_on_delivery";
export type PosPaymentMethod = "cash" | "card" | "bank_transfer" | "commercial_credit";
export type PosPaymentState = "pending" | "approved" | "rejected" | "not_required";
export type PosCustomerCommercialStatus =
  | "retail"
  | "wholesale_pending_first_purchase"
  | "wholesale_active"
  | "wholesale_suspended";

export type PosCreditSnapshot = {
  customerId: string;
  enabled: boolean;
  status: "active" | "suspended" | "missing";
  creditLimit: number;
  openBalance: number;
  availableCredit: number;
  overdueBalance: number;
  openReceivables: number;
  partialReceivables: number;
  overdueReceivables: number;
  blocked: boolean;
  blockReasons: string[];
  calculatedAt: string;
};

export type PosPriceSnapshot = {
  productId: string;
  sku: string;
  productName: string;
  quantity: number;
  priceMode: "retail" | "wholesale";
  retailUnitPrice: number;
  wholesaleUnitPrice: number;
  appliedUnitPrice: number;
  originalLineTotal: number;
  discountTotal: number;
  finalLineTotal: number;
  includedTaxRate: number;
  includedTaxAmount: number;
  unitCostSnapshot: number | null;
  marginAmount: number | null;
  marginPercentage: number | null;
};

export type PosBelowCostOverrideInput = {
  confirmed: true;
  reason: string;
};

export type PosDiscountInput = {
  scope: "line" | "sale";
  kind: "amount" | "percentage";
  value: number;
  productId: string | null;
  reason: string;
  belowCostOverride: PosBelowCostOverrideInput | null;
};

export type PosDeliveryChargeInput = {
  suggestedAmount: number;
  requestedAmount: number;
  reason: string | null;
};

export type PosCashOnDeliveryChargeInput = {
  requestedAmount: number;
  reason: string;
};

export type PosNewCustomerInput = {
  contactName: string;
  businessName: string | null;
  phone: string;
  email: string | null;
  rtn: string | null;
  address: string | null;
  city: string | null;
  commercialIntent: "retail" | "wholesale_candidate";
};

export type PosCustomerInput =
  | { kind: "existing"; customerId: string }
  | { kind: "new"; customer: PosNewCustomerInput; duplicateConfirmationId: string | null };

export type PosSaleLineInput = { productId: string; quantity: number };

export type PosPaymentInput =
  | { method: "cash"; amountReceived: number }
  | { method: "card"; state: "pending" | "approved"; reference: string | null; evidenceId: string | null }
  | { method: "bank_transfer"; state: "pending" | "approved"; reference: string | null; evidenceId: string | null }
  | { method: "commercial_credit" };

export type PosSaleRequest = {
  requestKey: string;
  customer: PosCustomerInput;
  lines: PosSaleLineInput[];
  channel: Exclude<PosChannel, "website">;
  deliveryMode: PosDeliveryMode;
  payment: PosPaymentInput;
  discounts: PosDiscountInput[];
  deliveryCharge: PosDeliveryChargeInput;
  cashOnDeliveryCharge: PosCashOnDeliveryChargeInput | null;
};

export type PosRecoverableWarning = {
  code: string;
  message: string;
  retryable: boolean;
  context: Record<string, string | number | boolean | null>;
};

export type PosSaleResult = {
  requestKey: string;
  result: "completed" | "pending_payment";
  idempotentReplay: boolean;
  orderId: string;
  orderNumber: string;
  paymentId: string | null;
  paymentStatus: PosPaymentState;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoicePdfUrl: string | null;
  receivableId: string | null;
  accountingStatus: "disabled" | "event_recorded" | "pending" | "not_applicable";
  warnings: PosRecoverableWarning[];
  createdAt: string;
};

export type PosSafeErrorCode =
  | "POS_PERMISSION_DENIED"
  | "POS_CUSTOMER_NOT_FOUND"
  | "POS_CUSTOMER_DUPLICATE"
  | "POS_CREDIT_INACTIVE"
  | "POS_CREDIT_OVERDUE"
  | "POS_CREDIT_LIMIT_INSUFFICIENT"
  | "POS_STOCK_INSUFFICIENT"
  | "POS_PRICE_CHANGED"
  | "POS_FISCAL_AUTHORIZATION_INVALID"
  | "POS_PAYMENT_PENDING"
  | "POS_IDEMPOTENCY_CONFLICT"
  | "POS_POST_COMMIT_RECOVERABLE_FAILURE";

export type PosCustomerType = "retail" | "wholesale";
export type PosWholesaleStatus = "none" | "pending" | "approved" | "rejected" | "suspended";
export type PosCustomerStatus = "active" | "inactive";
export type PosCustomerCreditStatus = "not_enabled" | "active" | "on_hold" | "suspended";

export type PosCustomerSearchResult = {
  customerId: string;
  displayName: string;
  businessName: string | null;
  phoneMasked: string | null;
  emailMasked: string | null;
  customerType: PosCustomerType;
  wholesaleStatus: PosWholesaleStatus;
  hasPortalAccount: boolean;
  isBlocked: boolean;
  customerStatus: PosCustomerStatus;
  commercialVersion: number;
};

export type PosCustomerSearchPage = {
  results: PosCustomerSearchResult[];
  total: number;
  nextOffset: number | null;
};

export type PosCustomerCreditSummary = {
  status: PosCustomerCreditStatus;
  enabled: boolean;
  creditLimit: number;
  openBalance: number;
  availableCredit: number;
  overdueBalance: number;
  receivableCount: number;
  canUseCredit: boolean;
  reason: string;
  readOnly: true;
};

export type PosCustomerContext = {
  customerId: string;
  displayName: string;
  businessName: string | null;
  phone: string;
  email: string | null;
  taxId: string | null;
  address: string | null;
  city: string | null;
  commercialNotes: string | null;
  customerType: PosCustomerType;
  wholesaleStatus: PosWholesaleStatus;
  pricingMode: "retail" | "wholesale";
  pricingReason: string;
  commercialVersion: number;
  hasPortalAccount: boolean;
  customerStatus: PosCustomerStatus;
  credit: PosCustomerCreditSummary;
  summary: { orderCount: number; invoiceCount: number; totalBilled: number };
};

export type PosWholesaleEligibility = {
  eligible: boolean;
  thresholdAmount: number;
  evaluatedAmount: number;
  missingAmount: number;
  currentStatus: PosWholesaleStatus;
  pricingMode: "retail" | "wholesale";
  recommendedAction: string;
  commercialVersion: number;
};

export type PosCustomerWriteInput = {
  requestKey: string;
  contactName: string;
  phone: string;
  email: string | null;
  businessName: string | null;
  taxId: string | null;
  address: string | null;
  city: string | null;
  commercialNotes: string | null;
};

export type PosCustomerUpdateInput = PosCustomerWriteInput & {
  customerId: string;
  expectedCommercialVersion: number;
};

export type PosCustomerWriteResult = {
  ok: boolean;
  status: "created" | "updated" | "duplicate" | "version_conflict";
  message: string;
  customerId: string;
  commercialVersion: number;
  idempotentReplay: boolean;
};
