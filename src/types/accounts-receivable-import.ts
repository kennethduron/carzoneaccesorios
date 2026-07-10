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

export type HistoricalReceivableApplySummary = {
  created: number;
  skipped: number;
};

export type HistoricalReceivableImportData = {
  batches: ImportBatch[];
  selectedBatch: ImportBatch | null;
  rows: ImportRow[];
  assignmentOptions: AssignmentSelectorOption[];
  canImport: boolean;
  canApply: boolean;
  canAssign: boolean;
  canRollback: boolean;
};
