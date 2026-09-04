import type { CommissionRuleType } from "@/types/commissions";

export const commercialReportTypes = [
  "SELLER_SALES",
  "COMMISSIONS",
  "SPECIAL_PRICES",
  "OUTSTANDING_SALES",
  "CUSTOMER_TYPES",
  "PAYMENT_METHODS",
  "COMMERCIAL_SUMMARY",
] as const;

export type CommercialReportType = (typeof commercialReportTypes)[number];
export type CommercialReportFormat = "PDF" | "XLSX";

export type CommercialFilters = {
  from: string;
  to: string;
  sellerId: string | null;
  channel: "all" | "pos" | "web";
  customerType: "all" | "retail" | "wholesale";
  paymentMethod: "all" | "cash" | "card" | "bank_transfer" | "commercial_credit";
  saleStatus: "all" | "valid" | "cancelled";
  specialPrice: "all" | "with" | "without";
  comparePrevious: boolean;
};

export type MoneyKpis = {
  sales: number;
  sold: number;
  collected: number;
  outstanding: number;
  averageTicket: number;
  cancelled: number;
  cancelledAmount: number;
};

export type CommercialBreakdown = { key: string; label: string; count: number; amount: number };
export type CommercialTrend = { date: string; sold: number; collected: number; previousSold?: number; previousCollected?: number };
export type CommercialSellerRow = MoneyKpis & {
  sellerId: string | null;
  sellerName: string;
  potential: number;
  earned: number;
  remaining: number;
  reversed: number;
};
export type CommercialSaleRow = {
  orderId: string;
  orderNumber: string;
  date: string;
  sellerId: string | null;
  sellerName: string;
  customerName: string;
  customerType: "retail" | "wholesale";
  channel: string;
  paymentMethod: string;
  status: string;
  total: number;
  collected: number;
  outstanding: number;
  specialPrice: boolean;
  potential: number;
  earned: number;
  remaining: number;
};

export type CommercialPriceRequestRow = {
  requestId: string;
  requestedAt: string;
  sellerId: string;
  sellerName: string;
  productName: string;
  sku: string;
  status: string;
  baseUnitPrice: number;
  requestedUnitPrice: number;
  difference: number;
  consumedOrderId: string | null;
};

export type SellerCommercialDetail = {
  customersAttended: number;
  retailCustomers: number;
  wholesaleCustomers: number;
  attributionCorrections: number;
  cancellations: number;
  cancelledAmount: number;
  reversedCommission: number;
  ruleHistory: Array<{
    ruleId: string;
    version: number;
    type: CommissionRuleType;
    value: number;
    effectiveFrom: string;
    effectiveTo: string | null;
    policyName: string | null;
  }>;
};

export type CommercialDashboardData = {
  generatedAt: string;
  timezone: "America/Tegucigalpa";
  filters: CommercialFilters;
  kpis: MoneyKpis;
  previous: MoneyKpis | null;
  trend: CommercialTrend[];
  sellers: CommercialSellerRow[];
  paymentMethods: CommercialBreakdown[];
  customerTypes: CommercialBreakdown[];
  channels: CommercialBreakdown[];
  specialPrices: { requests: number; approved: number; rejected: number; expiredOrCancelled: number; used: number; soldAmount: number };
  priceRequests: CommercialPriceRequestRow[];
  commissions: { potential: number; earned: number; remaining: number; reversed: number };
  coverage: { activeSellers: number; withRule: number; withoutRule: number; scheduled: number; percentage: number };
  attention: Array<{ code: string; label: string; count: number; amount?: number; href: string }>;
  sellerDetail: SellerCommercialDetail | null;
  sales: CommercialSaleRow[];
  totalSales: number;
};

export type CommissionPolicy = {
  policyId: string;
  name: string;
  type: CommissionRuleType;
  value: number;
  description: string;
  baseContract: "ELIGIBLE_MERCHANDISE_BEFORE_TAX";
  active: boolean;
  createdAt: string;
  createdByName: string;
  usageCount: number;
  lastAppliedAt: string | null;
};

export type PolicyAssignmentSeller = {
  sellerId: string;
  name: string;
  active: boolean;
  currentRule: { type: CommissionRuleType; value: number } | null;
  futureRule: { type: CommissionRuleType; value: number; effectiveFrom: string } | null;
  outcome: "CREATE" | "NO_OP" | "FUTURE_CONFLICT" | "INACTIVE";
};

export type PolicyAssignmentPreview = {
  previewToken: string;
  policy: CommissionPolicy;
  effectiveDate: string;
  selected: number;
  willCreate: number;
  noOp: number;
  conflicts: number;
  sellers: PolicyAssignmentSeller[];
};

export type ReportGeneration = {
  generationId: string;
  reportType: CommercialReportType;
  format: CommercialReportFormat;
  status: "PENDING" | "READY" | "FAILED";
  reportName: string;
  filters: CommercialFilters;
  rowCount: number;
  generatedAt: string | null;
  createdAt: string;
  generatedByName: string;
  errorCategory: string | null;
};

export type SavedReportConfiguration = {
  configurationId: string;
  name: string;
  reportType: CommercialReportType;
  format: CommercialReportFormat;
  filters: CommercialFilters;
  sections: string[];
  columns: string[];
  createdAt: string;
};
