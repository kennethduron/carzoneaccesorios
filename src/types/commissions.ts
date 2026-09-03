export const commissionStatuses = ["ACCRUED", "PARTIALLY_EARNED", "EARNED", "VOIDED", "REVERSED"] as const;
export type CommissionStatus = (typeof commissionStatuses)[number];

export const commissionRuleTypes = ["PERCENTAGE", "FIXED_AMOUNT"] as const;
export type CommissionRuleType = (typeof commissionRuleTypes)[number];

export const commissionStatusLabels: Record<CommissionStatus, string> = {
  ACCRUED: "Potencial",
  PARTIALLY_EARNED: "Parcialmente ganada",
  EARNED: "Ganada",
  VOIDED: "Anulada",
  REVERSED: "Revertida",
};

export type CommissionRule = {
  ruleId: string;
  sellerId: string;
  version: number;
  type: CommissionRuleType;
  value: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
  createdAt: string;
  status: "ACTIVE" | "SCHEDULED" | "FINISHED";
};

export type CommissionEvent = {
  eventId: number;
  type: string;
  amountDelta: number;
  earnedAfter: number;
  sourceType: string;
  sourceId: string | null;
  reason: string | null;
  createdAt: string;
};

export type CommissionEntry = {
  entryId: string;
  orderId: string;
  sellerId: string;
  sellerName: string;
  ruleId: string;
  ruleVersion: number;
  ruleType: CommissionRuleType;
  ruleValue: number;
  eligibleBase: number;
  collectibleTotal: number;
  potential: number;
  earned: number;
  remaining: number;
  reversed: number;
  status: CommissionStatus;
  attributionRevision: number;
  supersededAt: string | null;
  createdAt: string;
  sale: {
    orderNumber: string;
    confirmedAt: string;
    status: string;
    customerName: string;
    total: number;
    specialPriceUsed: boolean;
  };
  collection: { collectedAmount: number; ratio: number };
  events: CommissionEvent[];
};

export type CommissionSummary = { potential: number; earned: number; remaining: number; reversed: number };
export type CommissionPage = {
  results: CommissionEntry[];
  total: number;
  summary: CommissionSummary;
  currentRule?: CommissionRule | null;
  from?: string;
  to?: string;
};

export type SellerWorkspace = {
  seller: { id: string; name: string };
  summary: {
    todaySales: number; todaySold: number; monthSales: number; monthSold: number;
    collected: number; outstanding: number; averageTicket: number;
  };
  commission: CommissionSummary & { currentRule: CommissionRule | null };
  drafts: Array<{ draftId: string; customerName: string; total: number; itemCount: number; updatedAt: string; expiresAt: string }>;
  priceRequests: {
    pending: number; approvedRecently: number; rejectedRecently: number;
    recent: Array<{ requestId: string; productName: string; sku: string; basePrice: number; requestedPrice: number; status: string; requestedAt: string }>;
  };
  recentSales: Array<{
    orderId: string; orderNumber: string; confirmedAt: string; customerName: string;
    total: number; status: string; collectedAmount: number; commissionStatus: CommissionStatus | null;
    commissionEarned: number | null;
  }>;
};

export type SellerCommercialListItem = {
  sellerId: string; name: string; email: string | null; phone: string | null;
  avatarUrl: string | null; active: boolean; sellerSince: string;
  salesCount: number; sold: number; cancelled: number;
  potential: number; earned: number; remaining: number; reversed: number;
};

export type SellerCommercialProfile = {
  seller: Pick<SellerCommercialListItem, "sellerId" | "name" | "email" | "phone" | "avatarUrl" | "active" | "sellerSince">;
  metrics: { sales: number; sold: number; collected: number; outstanding: number; averageTicket: number; cancelled: number };
  commission: CommissionSummary;
  currentRule: CommissionRule | null;
  scheduledRule: CommissionRule | null;
  ruleHistory: CommissionRule[];
  priceRequests: { total: number; approved: number; rejected: number; expiredOrCancelled: number };
  recentSales: SellerWorkspace["recentSales"];
  recentActivity: Array<{ eventId: number; type: string; amountDelta: number; createdAt: string; orderId: string }>;
};

export type SellerProduct = {
  productId: string; sku: string; internalCode: string | null; name: string; brand: string;
  authorizedPrice: number; tracksInventory: boolean; availableStock: number | null; imageUrl: string | null;
};
