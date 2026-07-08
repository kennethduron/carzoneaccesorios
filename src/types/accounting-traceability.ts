export type AccountingTraceabilityStatus =
  | "published"
  | "draft"
  | "event"
  | "control"
  | "needs_configuration"
  | "none"
  | "reversed"
  | "cancelled"
  | "other";

export type AccountingTraceabilityTone = "success" | "warning" | "danger" | "neutral" | "info";

export type AccountingTraceabilityItem = {
  key: string;
  label: string;
  status: AccountingTraceabilityStatus;
  statusLabel: string;
  tone: AccountingTraceabilityTone;
  message: string | null;
  entryNumber: string | null;
  generatedDate: string | null;
  generatedTime: string | null;
  generatedBy: string;
  generatedByRole: string | null;
  publishedDate: string | null;
  publishedTime: string | null;
  publishedBy: string | null;
  publishedByRole: string | null;
  accountingPeriod: string | null;
  journalEntryHref: string | null;
  originLabel: string | null;
  originHref: string | null;
};

export type AccountingTraceabilitySummary = {
  items: AccountingTraceabilityItem[];
  primaryStatus: AccountingTraceabilityStatus;
  primaryStatusLabel: string;
  primaryTone: AccountingTraceabilityTone;
};
