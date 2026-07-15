import type { AssignmentSelectorOption, ImportBatch, ImportRow } from "@/types/import-foundation";

export type HistoricalReceivableImportStatus = "pending" | "partial" | "paid" | "overdue" | "cancelled";
export type HistoricalReceivablePaymentMethod = "cash" | "bank_transfer" | "card" | "check" | "other";

export type HistoricalReceivableNormalizedRow = {
  customer_code: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  customer_tax_id: string | null;
  invoice_number: string;
  issue_date: string;
  due_date: string;
  original_amount: number;
  paid_amount: number;
  balance_due: number;
  status: HistoricalReceivableImportStatus;
  status_label: string;
  payment_method: HistoricalReceivablePaymentMethod | null;
  payment_label: string | null;
  reference: string | null;
  notes: string | null;
};

export type HistoricalReceivableImportActionState = {
  ok: boolean;
  message: string;
  errors: string[];
  batchId?: string;
};

export type HistoricalReceivablePreviewOutcome =
  | "applied"
  | "cancelled"
  | "rejected"
  | "reuse_customer"
  | "create_customer"
  | "duplicate"
  | "ambiguous"
  | "review_required";

export type HistoricalReceivablePreviewSummary = {
  batch_status: string;
  create_customers: number;
  reuse_customers: number;
  create_receivables: number;
  duplicates: number;
  ambiguous: number;
  rejected: number;
  review_required: number;
  processable: number;
  rows: Array<{ row_id: string; outcome: HistoricalReceivablePreviewOutcome; reason: string }>;
};

export type HistoricalReceivableApplySummary = {
  created_customers: number;
  reused_customers: number;
  created_receivables: number;
  reused_receivables: number;
  duplicates: number;
  ambiguous: number;
  rejected: number;
  applied_rows: number;
  review_required_rows: number;
};

export type HistoricalReceivableImportData = {
  batches: ImportBatch[];
  selectedBatch: ImportBatch | null;
  rows: ImportRow[];
  assignmentOptions: AssignmentSelectorOption[];
  preview: HistoricalReceivablePreviewSummary | null;
  canImport: boolean;
  canApply: boolean;
  canAssign: boolean;
  canRollback: boolean;
};
