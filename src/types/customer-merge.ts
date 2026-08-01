export type CustomerMergeIdentityState = "equal" | "missing_primary" | "missing_secondary" | "empty" | "conflict";

export type CustomerMergeIdentityField = {
  field: string;
  primaryValue: string | null;
  secondaryValue: string | null;
  primaryNormalized: string | null;
  secondaryNormalized: string | null;
  state: CustomerMergeIdentityState;
  proposedAction: string;
};

export type CustomerMergeSignal = {
  strength: "strong" | "probable" | "weak";
  code: string;
};

export type CustomerMergePreview = {
  allowed: boolean;
  confidence: "strong" | "probable" | "weak";
  previewHash: string;
  primaryCustomerId: string;
  secondaryCustomerId: string;
  primaryCommercialVersion: number;
  secondaryCommercialVersion: number;
  identity: CustomerMergeIdentityField[];
  signals: CustomerMergeSignal[];
  warnings: string[];
  blockers: string[];
  requiredDecisions: string[];
  counts: Record<string, number>;
  financialTotals: Record<string, number>;
  fiscalHashes: Record<string, string>;
  accountingHashes: Record<string, string>;
  portal: { primaryUserId: string | null; secondaryUserId: string | null };
  credit: { primary: Record<string, unknown> | null; secondary: Record<string, unknown> | null };
  wholesale: {
    primary: { enabled: boolean; status: string; type: string };
    secondary: { enabled: boolean; status: string; type: string };
  };
  relationPlan: { reassign: string[]; preserveHistorical: string[] };
};

export type CustomerMergeHistoryAction =
  | "move_to_primary"
  | "remain_historical"
  | "preserve_immutable"
  | "resolve_through_alias"
  | "archive_with_secondary"
  | "no_change"
  | "blocked";

export type CustomerMergeHistoryItem = {
  category:
    | "order"
    | "invoice"
    | "payment"
    | "receivable"
    | "receivable_payment"
    | "accounting_entry"
    | "inventory_reservation"
    | "inventory_movement"
    | "crm_note"
    | "crm_followup"
    | "checkout_request";
  id: string;
  reference: string;
  title: string;
  date: string;
  status: string;
  statusLabel: string;
  amount: number | null;
  currency: "HNL" | null;
  sourceCustomerId: string | null;
  sourceCustomerLabel: string;
  action: CustomerMergeHistoryAction;
  actionLabel: string;
  visibilityAfterMerge: "visible_from_primary" | "owned_by_primary" | "unchanged";
  protected: boolean;
  details: Record<string, unknown>;
};

export type CustomerMergeHistoryMetric = {
  state: "available" | "empty" | "not_applicable" | "not_authorized" | "query_failed";
  count: number;
  total?: number;
  originalTotal?: number;
  openBalance?: number;
  debit?: number;
  credit?: number;
  quantity?: number;
};

export type CustomerMergeHistoryDetails = {
  presentationVersion: number;
  primaryCustomerId: string;
  secondaryCustomerId: string;
  primaryCommercialVersion: number;
  secondaryCommercialVersion: number;
  previewHash: string;
  items: CustomerMergeHistoryItem[];
  summary: Record<string, CustomerMergeHistoryMetric>;
  archiveConsequence: { action: "archive_with_secondary"; label: string };
  assurances: Array<{ code: string; label: string }>;
};

export type CustomerMergeDecision = {
  primaryValueSource: "primary" | "secondary";
  preserveOtherAsAlternate?: boolean;
  preserveOtherAsHistorical?: boolean;
};

export type CustomerMergeExecutionInput = {
  requestKey: string;
  primaryCustomerId: string;
  secondaryCustomerId: string;
  expectedPrimaryCommercialVersion: number;
  expectedSecondaryCommercialVersion: number;
  previewHash: string;
  identityDecisions: Record<string, CustomerMergeDecision>;
  creditDecision: Record<string, unknown>;
  commercialDecision: Record<string, unknown>;
  reason: string;
  source: "crm" | "customers" | "receivables" | "pos" | "support" | "controlled_production";
};

export type CustomerMergeActionResult = {
  ok: boolean;
  message: string;
  code?: string;
  preview?: CustomerMergePreview;
  historyDetails?: CustomerMergeHistoryDetails;
  executionEnabled?: boolean;
  result?: Record<string, unknown>;
};
