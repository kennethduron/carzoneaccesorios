"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { CustomerMergeActionResult, CustomerMergePreview } from "@/types/customer-merge";

const uuid = z.string().uuid();
const previewSchema = z.object({ primaryCustomerId: uuid, secondaryCustomerId: uuid });
const decisionSchema = z.object({
  primaryValueSource: z.enum(["primary", "secondary"]),
  preserveOtherAsAlternate: z.boolean().optional(),
  preserveOtherAsHistorical: z.boolean().optional(),
});
const executionSchema = z.object({
  requestKey: z.string().trim().min(12).max(200),
  primaryCustomerId: uuid,
  secondaryCustomerId: uuid,
  expectedPrimaryCommercialVersion: z.number().int().nonnegative(),
  expectedSecondaryCommercialVersion: z.number().int().nonnegative(),
  previewHash: z.string().regex(/^[0-9a-f]{64}$/),
  identityDecisions: z.record(z.string(), decisionSchema),
  creditDecision: z.record(z.string(), z.unknown()),
  commercialDecision: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(10).max(1000),
  source: z.enum(["crm", "customers", "receivables", "pos", "support", "controlled_production"]),
});

function databaseError(message: string) {
  const code = message.match(/CUSTOMER_[A-Z0-9_]+/)?.[0] ?? "CUSTOMER_MERGE_FAILED";
  const labels: Record<string, string> = {
    CUSTOMER_MERGE_EXECUTION_DISABLED: "Las uniones están desactivadas temporalmente.",
    CUSTOMER_MERGE_PREVIEW_STALE: "Los clientes cambiaron. Actualiza la vista previa antes de continuar.",
    CUSTOMER_MERGE_COMMERCIAL_VERSION_CONFLICT: "La configuración comercial cambió. Actualiza la vista previa.",
    CUSTOMER_MERGE_TWO_PORTAL_ACCOUNTS: "No se pueden unir dos clientes con cuentas de portal diferentes.",
    CUSTOMER_MERGE_CHECKOUT_IN_PROGRESS: "Hay un checkout en curso. Intenta nuevamente cuando finalice.",
    CUSTOMER_MERGE_POS_DRAFT_ACTIVE: "Hay un borrador POS activo para uno de los clientes.",
    CUSTOMER_MERGE_CREDIT_CONFLICT: "Debes elegir explícitamente la configuración de crédito.",
    CUSTOMER_MERGE_TAX_ID_DECISION_REQUIRED: "El conflicto de RTN requiere una decisión fiscal explícita.",
  };
  return { code, message: labels[code] ?? "No se pudo completar la unión. No se aplicaron cambios parciales." };
}

export async function previewCustomerMergeAction(input: unknown): Promise<CustomerMergeActionResult> {
  await requirePermission("customers:merge");
  const parsed = previewSchema.safeParse(input);
  if (!parsed.success || parsed.data.primaryCustomerId === parsed.data.secondaryCustomerId) {
    return { ok: false, code: "CUSTOMER_MERGE_INVALID_PAIR", message: "Selecciona dos clientes diferentes." };
  }
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("preview_customer_merge_v1", {
    p_primary_customer_id: parsed.data.primaryCustomerId,
    p_secondary_customer_id: parsed.data.secondaryCustomerId,
  });
  if (error) return { ok: false, ...databaseError(error.message) };
  return { ok: true, message: "Vista previa actualizada.", preview: data as CustomerMergePreview };
}

export async function executeCustomerMergeAction(input: unknown): Promise<CustomerMergeActionResult> {
  await requirePermission("customers:merge");
  const parsed = executionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "CUSTOMER_MERGE_INVALID_INPUT", message: "Revisa las decisiones, la razón y la confirmación." };
  const value = parsed.data;
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("merge_customers_v1", {
    p_request_key: value.requestKey,
    p_primary_customer_id: value.primaryCustomerId,
    p_secondary_customer_id: value.secondaryCustomerId,
    p_expected_primary_commercial_version: value.expectedPrimaryCommercialVersion,
    p_expected_secondary_commercial_version: value.expectedSecondaryCommercialVersion,
    p_preview_hash: value.previewHash,
    p_identity_decisions: value.identityDecisions,
    p_credit_decision: value.creditDecision,
    p_commercial_decision: value.commercialDecision,
    p_reason: value.reason,
    p_source: value.source,
  });
  if (error) return { ok: false, ...databaseError(error.message) };
  const result = (data ?? {}) as Record<string, unknown>;
  if (result.ok !== true) return { ok: false, code: String(result.errorCode ?? "CUSTOMER_MERGE_FAILED"), message: String(result.message ?? "La unión fue revertida completamente."), result };
  revalidatePath("/admin/clientes");
  revalidatePath("/admin/crm");
  return { ok: true, message: "Clientes unificados de forma segura.", result };
}
