export type SupplierPaymentRepairClassification =
  | "eligible_late_recorded"
  | "already_accounted"
  | "modern_missing_outbox"
  | "historical_before_cutover"
  | "mapping_missing"
  | "chronology_conflict"
  | "invalid_payment"
  | "cancelled_or_reversed"
  | "review_required";

export type SupplierPaymentRepairLine = {
  side: "debit" | "credit";
  account_id: string | null;
  account_code: string | null;
  account_name: string | null;
  amount: number;
};

export type SupplierPaymentAccountingRepairPreview = {
  payment_id: string;
  payment_reference: string;
  supplier_reference: string;
  supplier_name: string;
  amount: number;
  currency: string;
  effective_paid_at: string | null;
  recorded_at: string;
  accounting_occurred_at: string | null;
  proposed_journal_date: string | null;
  accounts_payable_id: string;
  accounts_payable_reference: string;
  accounts_payable_status: string;
  payment_status: string;
  payment_method: string | null;
  classification: SupplierPaymentRepairClassification;
  classification_reason: string;
  routing_origin: string;
  cutover_at: string | null;
  cutover_applied: boolean;
  mapping: {
    payable_account_id: string | null;
    payable_account_code: string | null;
    payable_account_name: string | null;
    payment_account_id: string | null;
    payment_account_code: string | null;
    payment_account_name: string | null;
    payment_mapping_key: string | null;
  };
  existing_event: {
    id: string;
    version: "v1" | "v2";
    status: string;
    journal_entry_id: string | null;
  } | null;
  existing_outbox: {
    id: string;
    status: string;
    financial_event_id: string | null;
    journal_entry_id: string | null;
  } | null;
  existing_journal: {
    id: string;
    entry_number: string;
    entry_date: string;
    status: string;
  } | null;
  payable_recognition: {
    event_id: string;
    journal_entry_id: string;
    entry_number: string;
    entry_date: string;
    status: string;
  } | null;
  preview_lines: SupplierPaymentRepairLine[];
  total_debit: number;
  total_credit: number;
  balanced: boolean;
  manual_publication_required: true;
  expected_fingerprint: string;
};

export type SupplierPaymentRepairResult = {
  ok: boolean;
  status: string;
  payment_id?: string;
  payment_reference?: string;
  repair_id?: string;
  outbox_id?: string;
  outbox_created?: boolean;
  financial_event_id?: string | null;
  journal_entry_id?: string | null;
  proposed_journal_date?: string;
  classification?: SupplierPaymentRepairClassification;
  manual_publication_required: true;
  idempotent_replay: boolean;
};
