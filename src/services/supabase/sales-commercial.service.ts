import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getMyCommissionMap } from "@/services/supabase/commissions.service";
import type {
  MyPosSaleDetail, MyPosSalesPage, PosPriceRequest, PosPriceRequestPage,
} from "@/types/sales-commercial";

export class SalesCommercialServiceError extends Error {
  constructor(message: string, readonly code: string) { super(message); this.name = "SalesCommercialServiceError"; }
}

const safeMessages: Record<string, string> = {
  POS_PRICE_REQUEST_FORBIDDEN: "No tienes permiso para solicitar este precio.",
  POS_PRICE_REQUEST_INVALID: "Revisa el precio y escribe un motivo de 5 a 500 caracteres.",
  POS_REQUESTED_PRICE_NOT_PERMITTED: "El precio solicitado no cumple las reglas comerciales permitidas.",
  POS_PRICE_REQUEST_SAME_PRICE: "El precio solicitado debe ser diferente al precio actual.",
  POS_PRICE_REQUEST_ALREADY_OPEN: "Ya existe una solicitud activa para este producto y venta.",
  POS_PRICE_REQUEST_ITEM_CHANGED: "El producto cambió. Guarda y vuelve a solicitar autorización.",
  POS_PRICE_REQUEST_ALREADY_DECIDED: "La solicitud ya fue decidida por otro usuario.",
  POS_PRICE_REQUEST_NOT_REVOCABLE: "La autorización ya no puede revocarse.",
  POS_PRICE_DECISION_REASON_REQUIRED: "Escribe un motivo de 5 a 500 caracteres.",
  POS_PRICE_APPROVAL_INVALID: "La autorización venció, fue usada o las condiciones de la venta cambiaron.",
  POS_MY_SALES_RANGE_TOO_LARGE: "El rango máximo permitido es de 366 días.",
  POS_SELLER_CORRECTION_FORBIDDEN: "No tienes permiso para corregir el vendedor responsable.",
  POS_SELLER_CORRECTION_REASON_REQUIRED: "Escribe un motivo de 10 a 500 caracteres.",
  POS_SELLER_INVALID: "Selecciona un usuario comercial activo.",
};

function throwRpc(error: { code?: string; message?: string } | null, fallback: string): never {
  const code = error?.message || error?.code || "SALES_COMMERCIAL_FAILED";
  throw new SalesCommercialServiceError(safeMessages[code] ?? (error?.code === "P0002" ? "No se encontró el recurso solicitado." : fallback), code);
}

export async function createPriceRequest(input: {
  requestKey: string; draftId: string; expectedDraftVersion: number; itemId: string;
  requestedUnitPrice: number; reason: string;
}) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_pos_price_request_v1", {
    p_request_key: input.requestKey, p_draft_id: input.draftId,
    p_expected_draft_version: input.expectedDraftVersion, p_draft_item_id: input.itemId,
    p_requested_unit_price: input.requestedUnitPrice, p_reason: input.reason,
  });
  if (error || !data) throwRpc(error, "No se pudo enviar la solicitud de precio.");
  return data as unknown as PosPriceRequest;
}

export async function listPriceRequests(input: {
  status?: string; query?: string; sellerId?: string; from?: string; to?: string;
  sort: "newest" | "oldest"; limit: number; offset: number;
}) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_pos_price_requests_v1", {
    p_status: input.status ?? null, p_query: input.query || null,
    p_seller_user_id: input.sellerId || null, p_from: input.from || null,
    p_to: input.to || null, p_sort: input.sort,
    p_limit: input.limit, p_offset: input.offset,
  });
  if (error || !data) throwRpc(error, "No se pudieron cargar las solicitudes.");
  return data as unknown as PosPriceRequestPage;
}

export async function getPriceRequest(requestId: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_pos_price_request_v1", { p_request_id: requestId });
  if (error || !data) throwRpc(error, "No se pudo cargar la solicitud.");
  return data as unknown as PosPriceRequest;
}

export async function decidePriceRequest(requestId: string, action: "approve" | "reject" | "revoke", reason?: string | null) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("decide_pos_price_request_v1", {
    p_request_id: requestId, p_action: action, p_reason: reason || null,
  });
  if (error || !data) throwRpc(error, "No se pudo registrar la decisión.");
  return data as unknown as PosPriceRequest;
}

export async function cancelPriceRequest(requestId: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("cancel_pos_price_request_v1", { p_request_id: requestId });
  if (error || !data) throwRpc(error, "No se pudo cancelar la solicitud.");
  return data as unknown as PosPriceRequest;
}

export async function listMyPosSales(input: { from: string; to: string; status?: string; method?: string; query?: string; limit: number; offset: number }) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_my_pos_sales_v1", {
    p_from: input.from, p_to: input.to, p_status: input.status || null,
    p_payment_method: input.method || null, p_query: input.query || null,
    p_limit: input.limit, p_offset: input.offset,
  });
  if (error || !data) throwRpc(error, "No se pudieron cargar tus ventas.");
  const page = data as unknown as MyPosSalesPage;
  const commissions = await getMyCommissionMap(page.results.map((sale) => sale.orderId));
  return { ...page, results: page.results.map((sale) => ({ ...sale, commission: commissions[sale.orderId] ?? null })) };
}

export async function getMyPosSaleDetail(orderId: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_my_pos_sale_detail_v1", { p_order_id: orderId });
  if (error || !data) throwRpc(error, "No se pudo cargar el detalle de la venta.");
  const sale = data as unknown as MyPosSaleDetail;
  const commissions = await getMyCommissionMap([sale.orderId]);
  return { ...sale, commission: commissions[sale.orderId] ?? null };
}

export async function correctPosOrderSeller(input: { orderId: string; sellerUserId: string; reason: string }) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("correct_pos_order_seller_v1", {
    p_order_id: input.orderId, p_seller_user_id: input.sellerUserId, p_reason: input.reason,
  });
  if (error || !data) throwRpc(error, "No se pudo corregir el vendedor responsable.");
  return data as unknown as { orderId: string; sellerId: string; sellerName: string; changed: boolean };
}
