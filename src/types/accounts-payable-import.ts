import type { ImportBatch, ImportRow } from "@/types/import-foundation";

export type HistoricalPayableImportStatus = "pending" | "partial" | "paid" | "overdue" | "cancelled";
export type HistoricalPayablePaymentMethod = "cash" | "bank_transfer" | "card" | "check" | "other";

export type HistoricalPayableNormalizedRow = {
  supplier_code: string | null;
  supplier_name: string;
  supplier_tax_id: string | null;
  supplier_email: string | null;
  supplier_phone: string | null;
  supplier_invoice_number: string;
  purchase_number: string | null;
  issue_date: string;
  due_date: string;
  original_amount: number;
  paid_amount: number;
  balance_due: number;
  status: HistoricalPayableImportStatus;
  status_label: string;
  currency: string;
  payment_method: HistoricalPayablePaymentMethod | null;
  payment_label: string | null;
  payment_reference: string | null;
  payment_date: string | null;
  notes: string | null;
};

export type HistoricalPayableImportData = {
  batches: ImportBatch[];
  selectedBatch: ImportBatch | null;
  rows: ImportRow[];
  assignmentOptions: import("@/types/import-foundation").AssignmentSelectorOption[];
  canImport: boolean;
  canApply: boolean;
  canAssign: boolean;
  canRollback: boolean;
};

export type HistoricalPayableImportActionState = {
  ok: boolean;
  message: string;
  errors: string[];
  batchId?: string;
};

export type HistoricalPayableApplySummary = {
  invoices: number;
  payables: number;
  payments: number;
  skipped: number;
};
