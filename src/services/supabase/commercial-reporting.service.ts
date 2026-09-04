import "server-only";

import { createHash } from "node:crypto";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { reportRows } from "@/lib/commercial-report-domain";
import type { CommissionRuleType } from "@/types/commissions";
import type { CommercialDashboardData, CommercialFilters, CommercialReportFormat, CommercialReportType, CommissionPolicy, PolicyAssignmentPreview, ReportGeneration, SavedReportConfiguration } from "@/types/commercial-reporting";

export class CommercialReportingServiceError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = "CommercialReportingServiceError"; }
}

const messages: Record<string,string> = {
  PHASE4_ACCESS_DENIED: "No tienes permiso para esta operación comercial.",
  COMMISSION_POLICY_INVALID: "Revisa el nombre, tipo y valor de la política.",
  COMMISSION_POLICY_NOT_FOUND: "No se encontró la política.",
  COMMISSION_POLICY_INACTIVE: "La política está inactiva.",
  COMMISSION_POLICY_REASON_REQUIRED: "Escribe un motivo de 10 a 500 caracteres.",
  COMMISSION_ASSIGNMENT_INVALID: "Selecciona entre 1 y 50 vendedores y una fecha válida.",
  COMMISSION_ASSIGNMENT_REASON_REQUIRED: "Escribe un motivo de asignación de 10 a 500 caracteres.",
  COMMISSION_ASSIGNMENT_PREVIEW_STALE: "La cobertura cambió. Revisa la vista previa nuevamente.",
  COMMISSION_ASSIGNMENT_CONFLICT: "La asignación contiene vendedores inactivos o reglas futuras en conflicto.",
  REPORT_PERIOD_INVALID: "El período del reporte no es válido.",
  REPORT_GENERATION_NOT_FOUND: "No se encontró el reporte generado.",
};

function fail(error: { message?: string; code?: string } | null, fallback: string): never {
  const code = error?.message || error?.code || "PHASE4_OPERATION_FAILED";
  throw new CommercialReportingServiceError(messages[code] ?? fallback, code);
}

export async function getCommercialDashboard(filters: CommercialFilters, limit = 20, offset = 0) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_commercial_dashboard_v1", { p_filters: filters, p_limit: limit, p_offset: offset });
  if (error || !data) fail(error, "No se pudo cargar el reporte comercial.");
  return data as unknown as CommercialDashboardData;
}

export async function listCommissionPolicies(input: { query?: string; status?: string; type?: string }) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_commission_policies_v1", { p_query: input.query || null, p_status: input.status || "all", p_type: input.type || "all" });
  if (error || !data) fail(error, "No se pudieron cargar las políticas.");
  return data as unknown as { results: CommissionPolicy[]; coverage: { activeSellers: number; withRule: number; scheduled: number } };
}

export async function createCommissionPolicy(input: { requestKey: string; name: string; type: CommissionRuleType; value: number; description: string }) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_commission_policy_v1", { p_request_key: input.requestKey, p_name: input.name, p_rule_type: input.type, p_rule_value: input.value, p_description: input.description });
  if (error || !data) fail(error, "No se pudo crear la política.");
  return data as unknown as CommissionPolicy & { idempotentReplay: boolean };
}

export async function duplicateCommissionPolicy(input: { requestKey: string; policyId: string; name: string }) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("duplicate_commission_policy_v1", { p_request_key: input.requestKey, p_policy_id: input.policyId, p_name: input.name });
  if (error || !data) fail(error, "No se pudo duplicar la política.");
  return data as unknown as CommissionPolicy & { idempotentReplay: boolean };
}

export async function deactivateCommissionPolicy(policyId: string, reason: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("deactivate_commission_policy_v1", { p_policy_id: policyId, p_reason: reason });
  if (error || !data) fail(error, "No se pudo desactivar la política.");
  return data as unknown as CommissionPolicy & { idempotentReplay: boolean };
}

export async function previewPolicyAssignment(policyId: string, sellerIds: string[], effectiveDate: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("preview_commission_policy_assignment_v1", { p_policy_id: policyId, p_seller_ids: sellerIds, p_effective_date: effectiveDate });
  if (error || !data) fail(error, "No se pudo preparar la asignación.");
  return data as unknown as PolicyAssignmentPreview;
}

export async function applyPolicyAssignment(input: { requestKey: string; policyId: string; sellerIds: string[]; effectiveDate: string; reason: string; previewToken: string }) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("apply_commission_policy_assignment_v1", { p_request_key: input.requestKey, p_policy_id: input.policyId, p_seller_ids: input.sellerIds, p_effective_date: input.effectiveDate, p_reason: input.reason, p_preview_token: input.previewToken });
  if (error || !data) fail(error, "No se pudo aplicar la política.");
  return data as unknown as { operationId: string; created: number; noOp: number; idempotentReplay: boolean };
}

export async function createReportGeneration(input: { requestKey: string; reportType: CommercialReportType; format: CommercialReportFormat; reportName: string; filters: CommercialFilters; sections: string[]; columns: string[]; configurationName?: string | null }) {
  const supabase = await getSupabaseServerClient();
  const start = await supabase.rpc("create_commercial_report_generation_v1", { p_request_key: input.requestKey, p_report_type: input.reportType, p_format: input.format, p_report_name: input.reportName, p_filters: input.filters, p_sections: input.sections, p_columns: input.columns, p_configuration_name: input.configurationName || null });
  if (start.error || !start.data) fail(start.error, "No se pudo iniciar el reporte.");
  const started = start.data as unknown as { generationId: string; status: string; idempotentReplay: boolean };
  if (started.status === "READY") return getReportSnapshot(started.generationId);
  if (started.status === "FAILED") throw new CommercialReportingServiceError("La solicitud anterior falló. Reintenta con una nueva solicitud.", "REPORT_GENERATION_FAILED");
  try {
    const dashboard = await getCommercialDashboard(input.filters, 5000, 0);
    if (dashboard.totalSales > 5000) throw new CommercialReportingServiceError("El reporte supera 5,000 filas. Acota el período o los filtros.", "REPORT_ROW_LIMIT");
    const rows = reportRows(input.reportType, dashboard);
    const snapshot = { dashboard, rows, generatedAt: new Date().toISOString(), reportType: input.reportType, reportName: input.reportName };
    const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    const completed = await supabase.rpc("complete_commercial_report_generation_v1", { p_generation_id: started.generationId, p_snapshot: snapshot, p_row_count: rows.length, p_snapshot_hash: hash });
    if (completed.error) fail(completed.error, "No se pudo finalizar el reporte.");
    return getReportSnapshot(started.generationId);
  } catch (error) {
    await supabase.rpc("fail_commercial_report_generation_v1", { p_generation_id: started.generationId, p_category: error instanceof CommercialReportingServiceError ? error.code : "GENERATION_FAILED", p_message: error instanceof Error ? error.message : "No se pudo generar el reporte." });
    throw error;
  }
}

export async function listReportHistory(limit = 10, offset = 0) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_commercial_report_history_v1", { p_limit: limit, p_offset: offset });
  if (error || !data) fail(error, "No se pudo cargar el historial.");
  return data as unknown as { results: ReportGeneration[]; total: number };
}

export async function listSavedReportConfigurations() {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.from("commercial_report_configurations").select("id,name,report_type,format,normalized_filters,included_sections,included_columns,created_at").eq("active",true).order("updated_at",{ascending:false}).limit(20);
  if (error) fail(error, "No se pudieron cargar las configuraciones guardadas.");
  return (data??[]).map(row=>({configurationId:row.id,name:row.name,reportType:row.report_type,format:row.format,filters:row.normalized_filters,sections:row.included_sections,columns:row.included_columns,createdAt:row.created_at})) as SavedReportConfiguration[];
}

export async function getReportSnapshot(generationId: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_commercial_report_snapshot_v1", { p_generation_id: generationId });
  if (error || !data) fail(error, "No se pudo recuperar el reporte.");
  return data as unknown as { generationId: string; reportType: CommercialReportType; format: CommercialReportFormat; reportName: string; filters: CommercialFilters; sections: string[]; columns: string[]; snapshot: { dashboard: CommercialDashboardData; rows: Array<Record<string,string|number|boolean>>; generatedAt: string; reportType: CommercialReportType; reportName: string }; snapshotHash: string };
}
