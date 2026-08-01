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
  result?: Record<string, unknown>;
};
