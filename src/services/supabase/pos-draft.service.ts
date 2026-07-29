import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  PosChargeCapabilities,
  PosActiveDraftSummary,
  PosDraftSaveInput,
  PosProductSearchPage,
  PosProductSearchResult,
  PosSaleDraft,
} from "@/types/point-of-sale";

type ProductRow = {
  product_id: string;
  sku: string;
  internal_code: string | null;
  product_name: string;
  brand: string;
  category_id: string | null;
  category_name: string | null;
  base_unit_price: number | string;
  pricing_source: "retail" | "wholesale";
  wholesale_min_quantity: number | string;
  tax_category: "standard" | "exempt";
  included_tax_rate: number | string;
  product_sales_version: number | string;
  product_status: "active" | "inactive" | "draft" | "archived";
  active: boolean;
  auto_disabled_by_stock: boolean;
  available_stock: number | string;
  low_stock_threshold: number | string;
  image_url: string | null;
  total_count: number | string;
};

export class PosDraftServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly context: { currentVersion?: number; status?: string; updatedAt?: string } = {},
  ) {
    super(message);
    this.name = "PosDraftServiceError";
  }
}

function numberValue(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function throwRpcError(error: { code?: string; message?: string; details?: string } | null, fallback: string): never {
  const code = error?.code ?? "POS_DRAFT_OPERATION_FAILED";
  let context: { currentVersion?: number; status?: string; updatedAt?: string } = {};
  if (code === "PT409" && error?.details) {
    try { context = JSON.parse(error.details) as typeof context; } catch { context = {}; }
  }
  const safe = code === "42501" ? "Acceso denegado."
    : code === "P0002" ? "No se encontro el recurso solicitado."
      : code === "PT409" ? "Los datos cambiaron en otra pestaña o dispositivo. Recarga e intenta de nuevo."
        : code === "55000" ? "La operación todavía está en proceso."
          : code === "22023" && error?.message ? error.message
            : fallback;
  throw new PosDraftServiceError(safe, code, context);
}

export async function searchPosProducts(input: { query: string; customerId: string; expectedCustomerCommercialVersion: number; categoryId?: string | null; brand?: string | null; includeUnavailable: boolean; limit: number; offset: number }): Promise<PosProductSearchPage> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("search_pos_products_v1", {
    p_query: input.query,
    p_customer_id: input.customerId,
    p_expected_customer_commercial_version: input.expectedCustomerCommercialVersion,
    p_category_id: input.categoryId || null,
    p_brand: input.brand || null,
    p_include_unavailable: input.includeUnavailable,
    p_limit: input.limit,
    p_offset: input.offset,
  });
  if (error) throwRpcError(error, "No se pudieron buscar productos.");
  const rows = (data ?? []) as unknown as ProductRow[];
  const results: PosProductSearchResult[] = rows.map((row) => ({
    productId: row.product_id,
    sku: row.sku,
    internalCode: row.internal_code,
    productName: row.product_name,
    brand: row.brand,
    categoryId: row.category_id,
    categoryName: row.category_name,
    baseUnitPrice: numberValue(row.base_unit_price),
    pricingSource: row.pricing_source,
    wholesaleMinQuantity: numberValue(row.wholesale_min_quantity),
    taxCategory: row.tax_category,
    includedTaxRate: numberValue(row.included_tax_rate),
    productSalesVersion: numberValue(row.product_sales_version),
    productStatus: row.product_status,
    active: row.active,
    autoDisabledByStock: row.auto_disabled_by_stock,
    availableStock: row.active && row.product_status === "active" ? numberValue(row.available_stock) : 0,
    lowStockThreshold: numberValue(row.low_stock_threshold),
    imageUrl: row.image_url,
  }));
  const total = numberValue(rows[0]?.total_count);
  return { results, total, nextOffset: input.offset + results.length < total ? input.offset + results.length : null };
}

export async function getPosChargeCapabilities(): Promise<PosChargeCapabilities> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_pos_charge_capabilities_v1");
  if (error || !data) throwRpcError(error, "No se pudieron cargar las capacidades.");
  return data as unknown as PosChargeCapabilities;
}

export async function createPosDraft(requestKey: string, customerId: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("create_pos_sale_draft_v1", { p_request_key: requestKey, p_customer_id: customerId });
  if (error || !data) throwRpcError(error, "No se pudo crear el borrador.");
  return data as unknown as PosSaleDraft;
}

export async function getPosDraft(draftId: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_pos_sale_draft_v1", { p_draft_id: draftId });
  if (error || !data) throwRpcError(error, "No se pudo cargar el borrador.");
  return data as unknown as PosSaleDraft;
}

export async function listPosDrafts(limit: number, offset: number) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_pos_sale_drafts_v1", { p_limit: limit, p_offset: offset });
  if (error) throwRpcError(error, "No se pudieron listar los borradores.");
  return (data ?? []) as unknown as PosActiveDraftSummary[];
}

export async function savePosDraft(input: PosDraftSaveInput) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("save_pos_sale_draft_v1", {
    p_request_key: input.requestKey,
    p_draft_id: input.draftId,
    p_expected_version: input.expectedVersion,
    p_customer_id: input.customerId,
    p_expected_customer_commercial_version: input.expectedCustomerCommercialVersion,
    p_items: input.items,
    p_delivery_mode: input.deliveryMode,
    p_delivery_address: input.deliveryAddress,
    p_delivery_notes: input.deliveryNotes,
    p_internal_notes: input.internalNotes,
    p_delivery_charge: 0,
    p_cash_on_delivery_charge: 0,
    p_other_charges: 0,
  });
  if (error || !data) throwRpcError(error, "No se pudo guardar el borrador.");
  return data as unknown as PosSaleDraft;
}

export async function abandonPosDraft(requestKey: string, draftId: string, expectedVersion: number) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("abandon_pos_sale_draft_v1", { p_request_key: requestKey, p_draft_id: draftId, p_expected_version: expectedVersion });
  if (error || !data) throwRpcError(error, "No se pudo abandonar el borrador.");
  return data as unknown as PosSaleDraft;
}
