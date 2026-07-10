import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  AssignmentSelectorKind,
  AssignmentSelectorOption,
  ImportBatch,
  ImportFoundationData,
  ImportModule,
  ImportPermissionAction,
  ImportPreviewRow,
  ImportRow,
} from "@/types/import-foundation";
export { importBatchStatusLabels, importModuleLabel } from "@/utils/import-labels";

type BatchQueryRow = Omit<ImportBatch, "metadata"> & {
  metadata: Record<string, unknown> | null;
};

type RowQueryRow = Omit<ImportRow, "original_data" | "normalized_data" | "validation_messages" | "audit_metadata"> & {
  original_data: Record<string, unknown> | null;
  normalized_data: Record<string, unknown> | null;
  validation_messages: unknown;
  audit_metadata: Record<string, unknown> | null;
};

function normalizeBatch(row: BatchQueryRow): ImportBatch {
  return {
    ...row,
    metadata: row.metadata ?? {},
  };
}

function normalizeMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? "")).filter(Boolean);
}

function normalizeRow(row: RowQueryRow): ImportRow {
  return {
    ...row,
    original_data: row.original_data ?? {},
    normalized_data: row.normalized_data ?? {},
    validation_messages: normalizeMessages(row.validation_messages),
    audit_metadata: row.audit_metadata ?? {},
  };
}

export async function getImportFoundationData(): Promise<ImportFoundationData> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("import_batches")
    .select(
      "id, module, status, created_by, created_at, updated_at, total_rows, pending_rows, validated_rows, applied_rows, failed_rows, rollback_batch_id, rollback_reason, audit_log_id, completed_at, applied_at, rolled_back_at, metadata",
    )
    .order("created_at", { ascending: false })
    .limit(25)
    .returns<BatchQueryRow[]>();

  if (error) throw new Error(error.message);

  const batches = (data ?? []).map(normalizeBatch);
  return {
    batches,
    summary: {
      totalBatches: batches.length,
      pendingAssignment: batches.filter((batch) => batch.status === "pending_assignment").length,
      ready: batches.filter((batch) => batch.status === "ready").length,
      applied: batches.filter((batch) => batch.status === "applied").length,
      failed: batches.filter((batch) => batch.status === "failed").length,
    },
  };
}

export async function getImportBatchRows(batchId: string): Promise<ImportRow[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("import_rows")
    .select(
      "id, batch_id, module, row_number, original_data, normalized_data, validation_status, validation_messages, suggested_customer_id, suggested_supplier_id, assignment_type, assignment_status, assigned_customer_id, assigned_supplier_id, assigned_by, assigned_at, apply_status, apply_error, audit_metadata, created_at, updated_at",
    )
    .eq("batch_id", batchId)
    .order("row_number", { ascending: true })
    .returns<RowQueryRow[]>();

  if (error) throw new Error(error.message);
  return (data ?? []).map(normalizeRow);
}

export async function createImportBatch(module: ImportModule, metadata: Record<string, unknown> = {}) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_import_batch", {
    import_module: module,
    batch_metadata: metadata,
  });

  if (error) throw new Error(error.message);
  return String(data);
}

export async function stageImportRows(batchId: string, rows: ImportPreviewRow[]) {
  const supabase = await getSupabaseServerClient();
  const payload = rows.map((row) => ({
    row_number: row.rowNumber,
    original_data: row.originalData,
    normalized_data: row.normalizedData,
    validation_status: row.validationStatus,
    validation_messages: row.validationMessages,
    suggested_customer_id: row.suggestedCustomerId ?? null,
    suggested_supplier_id: row.suggestedSupplierId ?? null,
    assignment_type: row.assignmentType,
    assignment_status: row.assignmentStatus,
    apply_status: row.applyStatus,
  }));

  const { data, error } = await supabase.rpc("upsert_import_rows", {
    target_batch_id: batchId,
    row_payload: payload,
  });

  if (error) throw new Error(error.message);
  return data as { rows?: number } | null;
}

export async function setImportBatchStatus(batchId: string, status: ImportBatch["status"], metadata: Record<string, unknown> = {}) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_import_batch_status", {
    target_batch_id: batchId,
    next_status: status,
    status_metadata: metadata,
  });

  if (error) throw new Error(error.message);
  return data as ImportBatch | null;
}

export async function checkImportFoundationPermission(module: ImportModule, action: ImportPermissionAction) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("has_import_foundation_permission", {
    import_module: module,
    import_action: action,
  });

  if (error) throw new Error(error.message);
  return Boolean(data);
}

export async function searchImportAssignmentOptions(kind: AssignmentSelectorKind, query: string): Promise<AssignmentSelectorOption[]> {
  const supabase = getSupabaseAdminClient();
  const needle = sanitizeAssignmentSearchTerm(query);
  if (needle.length < 2) return [];

  if (kind === "customer") {
    const pattern = `%${needle}%`;
    const { data, error } = await supabase
      .from("customers")
      .select("id, business_name, company_name, contact_name, email, phone, tax_id")
      .or(`business_name.ilike.${pattern},company_name.ilike.${pattern},contact_name.ilike.${pattern},email.ilike.${pattern},phone.ilike.${pattern},tax_id.ilike.${pattern}`)
      .order("updated_at", { ascending: false })
      .limit(20)
      .returns<Array<{ id: string; business_name: string | null; company_name: string | null; contact_name: string; email: string | null; phone: string | null; tax_id: string | null }>>();

    if (error) throw new Error(error.message);

    return (data ?? []).map((customer) => ({
      id: customer.id,
      kind,
      name: customer.business_name || customer.company_name || customer.contact_name,
      email: customer.email,
      phone: customer.phone,
      taxId: customer.tax_id,
      code: null,
    }));
  }

  const pattern = `%${needle}%`;
  const { data, error } = await supabase
    .from("suppliers")
    .select("id, name, email, phone, tax_id")
    .or(`name.ilike.${pattern},email.ilike.${pattern},phone.ilike.${pattern},tax_id.ilike.${pattern}`)
    .order("updated_at", { ascending: false })
    .limit(20)
    .returns<Array<{ id: string; name: string; email: string | null; phone: string | null; tax_id: string | null }>>();

  if (error) throw new Error(error.message);

  return (data ?? []).map((supplier) => ({
    id: supplier.id,
    kind,
    name: supplier.name,
    email: supplier.email,
    phone: supplier.phone,
    taxId: supplier.tax_id,
    code: null,
  }));
}

function sanitizeAssignmentSearchTerm(value: string) {
  return value.replace(/[%,()]/g, " ").trim();
}
