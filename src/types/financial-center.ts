import type { AccountingAccount } from "./accounting";

export type AccountingMappingType =
  | "default_account"
  | "payment_method"
  | "revenue"
  | "tax"
  | "receivable"
  | "inventory"
  | "discount"
  | "shipping"
  | "rounding"
  | "suspense";

export type FinancialEventStatus =
  | "pending"
  | "ready"
  | "draft_created"
  | "posted"
  | "failed"
  | "skipped"
  | "reversed";

export type AutomationMode = "disabled" | "dry_run" | "draft_only" | "auto_post";

export type AccountingMappingAccount = Pick<AccountingAccount, "id" | "code" | "name" | "type" | "is_active">;

export type AccountingMapping = {
  id: string;
  mapping_type: AccountingMappingType;
  source_key: string;
  account_id: string;
  priority: number;
  is_active: boolean;
  effective_from: string | null;
  effective_to: string | null;
  metadata: Record<string, unknown>;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  account: AccountingMappingAccount | null;
};

export type AccountingMappingInput = {
  id?: string;
  mapping_type: AccountingMappingType;
  source_key: string;
  account_id: string;
  priority?: number;
  is_active?: boolean;
  effective_from?: string | null;
  effective_to?: string | null;
  metadata?: Record<string, unknown>;
};

export type FinancialEvent = {
  id: string;
  source_type: string;
  source_id: string;
  event_purpose: string;
  posting_version: string;
  status: FinancialEventStatus;
  occurred_at: string;
  source_snapshot: Record<string, unknown>;
  validation_errors: unknown[];
  journal_entry_id: string | null;
  journal_entry?: {
    id: string;
    entry_number: string;
    status: string;
  } | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AccountingAutomationSetting = {
  id: string;
  key: string;
  value: Record<string, unknown>;
  description: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
};

export type RequiredMappingDefinition = {
  key: string;
  label: string;
  mappingType: AccountingMappingType;
  sourceKey: string;
};

export type MappingReadinessStatus = "configured" | "pending" | "inactive";
export type FinancialReadinessStatus = "ready" | "incomplete" | "review";

export type MappingReadinessItem = RequiredMappingDefinition & {
  status: MappingReadinessStatus;
  mappingId: string | null;
  account: AccountingMappingAccount | null;
  message: string;
};

export type PeriodReadiness = {
  status: "available" | "review";
  openPeriods: number;
  totalPeriods: number;
  message: string;
};

export type FinancialCenterSummary = {
  pendingEvents: number;
  configuredMappings: number;
  incompleteMappings: number;
  invalidMappings: number;
  automationMode: AutomationMode;
  readinessStatus: FinancialReadinessStatus;
};

export type FinancialCenterData = {
  summary: FinancialCenterSummary;
  mappings: AccountingMapping[];
  events: FinancialEvent[];
  readinessItems: MappingReadinessItem[];
  automationSetting: AccountingAutomationSetting | null;
  periodReadiness: PeriodReadiness;
};
