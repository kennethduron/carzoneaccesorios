export type ImportModule = "accounts_receivable" | "accounts_payable";

export type ImportBatchStatus =
  | "uploaded"
  | "validating"
  | "validated"
  | "pending_assignment"
  | "ready"
  | "applied"
  | "cancelled"
  | "rolled_back"
  | "failed";

export type ImportRowValidationStatus = "pending" | "valid" | "invalid" | "warning";
export type ImportAssignmentType = "none" | "customer" | "supplier";
export type ImportAssignmentStatus = "not_required" | "pending" | "suggested" | "manual" | "confirmed" | "unassigned";
export type ImportApplyStatus = "pending" | "ready" | "applied" | "skipped" | "failed" | "rolled_back";
export type ImportPermissionAction = "import" | "apply" | "rollback" | "assign" | "review" | "audit";

export type ImportBatch = {
  id: string;
  module: ImportModule;
  status: ImportBatchStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  total_rows: number;
  pending_rows: number;
  validated_rows: number;
  applied_rows: number;
  failed_rows: number;
  rollback_batch_id: string | null;
  rollback_reason: string | null;
  audit_log_id: string | null;
  completed_at: string | null;
  applied_at: string | null;
  rolled_back_at: string | null;
  metadata: Record<string, unknown>;
};

export type ImportRow = {
  id: string;
  batch_id: string;
  module: ImportModule;
  row_number: number;
  original_data: Record<string, unknown>;
  normalized_data: Record<string, unknown>;
  validation_status: ImportRowValidationStatus;
  validation_messages: string[];
  suggested_customer_id: string | null;
  suggested_supplier_id: string | null;
  assignment_type: ImportAssignmentType;
  assignment_status: ImportAssignmentStatus;
  assigned_customer_id: string | null;
  assigned_supplier_id: string | null;
  assigned_by: string | null;
  assigned_at: string | null;
  apply_status: ImportApplyStatus;
  apply_error: string | null;
  audit_metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type ImportFoundationSummary = {
  totalBatches: number;
  pendingAssignment: number;
  ready: number;
  applied: number;
  failed: number;
};

export type ImportFoundationData = {
  batches: ImportBatch[];
  summary: ImportFoundationSummary;
};

export type ImportValidationMessage = {
  rowNumber: number;
  field?: string;
  message: string;
};

export type ImportPreviewRow = {
  rowNumber: number;
  originalData: Record<string, unknown>;
  normalizedData: Record<string, unknown>;
  validationStatus: ImportRowValidationStatus;
  validationMessages: string[];
  assignmentType: ImportAssignmentType;
  assignmentStatus: ImportAssignmentStatus;
  applyStatus: ImportApplyStatus;
  suggestedCustomerId?: string | null;
  suggestedSupplierId?: string | null;
};

export type ImportValidationResult = {
  ok: boolean;
  rows: ImportPreviewRow[];
  errors: string[];
};

export type ImportColumnDefinition = {
  key: string;
  label: string;
  required?: boolean;
  dropdownOptions?: string[];
  example?: string | number;
  readOnly?: boolean;
  width?: number;
};

export type ImportTemplateDefinition = {
  title: string;
  description: string;
  sheetName: string;
  columns: ImportColumnDefinition[];
  examples?: Array<Record<string, string | number | null>>;
  instructions?: string[];
};

export type AssignmentSelectorKind = "customer" | "supplier";

export type AssignmentSelectorOption = {
  id: string;
  kind: AssignmentSelectorKind;
  name: string;
  email: string | null;
  phone: string | null;
  taxId: string | null;
  code: string | null;
};
