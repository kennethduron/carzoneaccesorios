import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  CommissionEntry,
  CommissionPage,
  CommissionRuleType,
  SellerCommercialListItem,
  SellerCommercialProfile,
  SellerProduct,
  SellerWorkspace,
} from "@/types/commissions";

export class CommissionServiceError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = "CommissionServiceError"; }
}

const messages: Record<string, string> = {
  COMMISSION_ACCESS_DENIED: "No tienes acceso a comisiones.",
  SELLER_COMMISSION_ACCESS_DENIED: "Solo puedes consultar tus propias comisiones.",
  SELLER_WORKSPACE_ACCESS_DENIED: "No tienes acceso al panel de ventas.",
  COMMISSION_RULE_INVALID_VALUE: "El tipo o valor de la regla no es valido.",
  COMMISSION_RULE_REASON_REQUIRED: "Escribe un motivo de 10 a 500 caracteres.",
  COMMISSION_RULE_EFFECTIVE_DATE_INVALID: "La vigencia no puede comenzar en el pasado.",
  COMMISSION_RULE_FUTURE_ALREADY_EXISTS: "Este vendedor ya tiene una regla futura programada.",
  COMMISSION_RULE_OVERLAP: "La nueva regla se superpone con otra version.",
  COMMISSION_ADJUSTMENT_REASON_REQUIRED: "Escribe un motivo de 10 a 500 caracteres.",
  COMMISSION_ADJUSTMENT_OUT_OF_RANGE: "El ajuste debe mantener la comision entre cero y su potencial.",
  COMMISSION_ADJUSTMENT_INVALID: "El ajuste no es valido para esta comision.",
  COMMISSION_NOT_FOUND: "No se encontro la comision solicitada.",
  COMMISSION_SELLER_NOT_FOUND: "No se encontro el vendedor.",
};

function fail(error: { message?: string; code?: string } | null, fallback: string): never {
  const code = error?.message || error?.code || "COMMISSION_OPERATION_FAILED";
  throw new CommissionServiceError(messages[code] ?? fallback, code);
}

export async function getMySellerWorkspace() {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_my_seller_workspace_v1");
  if (error || !data) fail(error, "No se pudo cargar el panel de ventas.");
  return data as unknown as SellerWorkspace;
}

export async function listMyCommissions(input: { from: string; to: string; status?: string; query?: string; limit: number; offset: number }) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_my_sales_commissions_v1", {
    p_from: input.from, p_to: input.to, p_status: input.status || null,
    p_query: input.query || null, p_limit: input.limit, p_offset: input.offset,
  });
  if (error || !data) fail(error, "No se pudieron cargar tus comisiones.");
  return data as unknown as CommissionPage;
}

export async function getMyCommission(entryId: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_my_sales_commission_v1", { p_entry_id: entryId });
  if (error || !data) fail(error, "No se pudo cargar la comision.");
  return data as unknown as CommissionEntry;
}

export async function getMyCommissionMap(orderIds: string[]) {
  if (!orderIds.length) return {} as Record<string, Pick<CommissionEntry, "entryId" | "status" | "potential" | "earned" | "remaining" | "reversed">>;
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_my_commissions_for_orders_v1", { p_order_ids: orderIds });
  if (error) fail(error, "No se pudo cargar el resumen de comisiones.");
  return (data ?? {}) as unknown as Record<string, Pick<CommissionEntry, "entryId" | "status" | "potential" | "earned" | "remaining" | "reversed">>;
}

export async function listCommissions(input: {
  sellerId?: string; status?: string; ruleType?: string; from?: string; to?: string;
  query?: string; sort?: "newest" | "oldest"; limit: number; offset: number;
}) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_sales_commissions_v1", {
    p_seller_id: input.sellerId || null, p_status: input.status || null,
    p_rule_type: input.ruleType || null, p_from: input.from || null, p_to: input.to || null,
    p_query: input.query || null, p_sort: input.sort ?? "newest",
    p_limit: input.limit, p_offset: input.offset,
  });
  if (error || !data) fail(error, "No se pudieron cargar las comisiones.");
  return data as unknown as CommissionPage;
}

export async function getCommissionDetail(entryId: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_sales_commission_detail_v1", { p_entry_id: entryId });
  if (error || !data) fail(error, "No se pudo cargar la comision.");
  return data as unknown as CommissionEntry & { rule: unknown; payments: Array<Record<string, unknown>> };
}

export async function listCommissionSellers(input: { query?: string; active?: string; limit: number; offset: number }) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_commission_sellers_v1", {
    p_query: input.query || null, p_active: input.active ?? "all", p_limit: input.limit, p_offset: input.offset,
  });
  if (error || !data) fail(error, "No se pudieron cargar los vendedores.");
  return data as unknown as { results: SellerCommercialListItem[]; total: number };
}

export async function getSellerCommercialProfile(sellerId: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_seller_commercial_profile_v1", { p_seller_id: sellerId });
  if (error || !data) fail(error, "No se pudo cargar el vendedor.");
  return data as unknown as SellerCommercialProfile;
}

export async function createCommissionRule(input: {
  requestKey: string; sellerId: string; type: CommissionRuleType; value: number; effectiveDate: string; reason: string;
}) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_sales_commission_rule_v1", {
    p_request_key: input.requestKey, p_seller_user_id: input.sellerId,
    p_rule_type: input.type, p_rule_value: input.value,
    p_effective_date: input.effectiveDate, p_reason: input.reason,
  });
  if (error || !data) fail(error, "No se pudo crear la nueva regla.");
  return data as unknown as { ruleId: string; version: number; status: string; effectiveFrom: string; idempotentReplay: boolean };
}

export async function adjustCommission(input: { requestKey: string; entryId: string; amountDelta: number; reason: string }) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("adjust_sales_commission_v1", {
    p_request_key: input.requestKey, p_entry_id: input.entryId,
    p_amount_delta: input.amountDelta, p_reason: input.reason,
  });
  if (error || !data) fail(error, "No se pudo registrar el ajuste.");
  return data as unknown as { entryId: string; earnedAmount: number; status: string; idempotentReplay: boolean };
}

export async function searchSellerProducts(input: { query?: string; limit: number; offset: number }) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("search_seller_products_v1", {
    p_query: input.query ?? "", p_limit: input.limit, p_offset: input.offset,
  });
  if (error || !data) fail(error, "No se pudieron cargar los productos.");
  return data as unknown as { results: SellerProduct[]; total: number };
}
