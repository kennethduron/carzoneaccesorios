import "server-only";

import { applyPosDraftInventorySnapshots } from "@/lib/pos/inventory-mode";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  PosChargeCapabilities,
  PosCreditOverdueOverrideCapability,
  PosActiveDraftSummary,
  PosConfirmationInput,
  PosConfirmationResult,
  PosDraftSaveInput,
  PosInventorySnapshot,
  PosProductReservation,
  PosProductReservationPage,
  PosProductSearchPage,
  PosProductSearchResult,
  PosSaleDraft,
} from "@/types/point-of-sale";

type ConfirmationRow = {
  status: "confirmed";
  replayed: boolean;
  draft_id: string;
  order_id: string;
  order_number: string;
  invoice_id: string;
  invoice_number: string;
  payment_id: string | null;
  receivable_id: string | null;
  total: number | string;
  payment_method: PosConfirmationResult["paymentMethod"];
  amount_tendered: number | string | null;
  change_due: number | string | null;
  invoice_date: string;
  receipt_reference: string;
  accounting_status: string;
};

type CreditOverrideCapabilityRow = {
  feature_enabled: boolean;
  override_allowed: boolean;
};

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

type InventorySnapshotRow = {
  product_id: string;
  tracks_inventory: boolean;
  physical_stock: number | string | null;
  reserved_stock: number | string | null;
  available_stock: number | string | null;
  has_active_reservations: boolean;
  stock_observed_at: string;
};

type ProductReservationRow = {
  reservation_id: string;
  order_id: string;
  order_number: string;
  reserved_quantity: number | string;
  reservation_status: string;
  order_status: string;
  reservation_created_at: string;
  expires_at: string;
  review_required: boolean;
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

function nullableNumberValue(value: unknown) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function throwRpcError(error: { code?: string; message?: string; details?: string } | null, fallback: string): never {
  if (error?.message === "POS_CUSTOMER_SUSPENDED") {
    throw new PosDraftServiceError(
      "Este cliente está suspendido y no puede utilizarse para una nueva venta.",
      "POS_CUSTOMER_SUSPENDED",
    );
  }
  const code = error?.code ?? "POS_DRAFT_OPERATION_FAILED";
  const validationMessages: Record<string, string> = {
    POS_ADDITIONAL_CHARGE_DESCRIPTION_REQUIRED: "Escriba una descripción de 2 a 120 caracteres para el cargo adicional.",
    POS_OTHER_CHARGE_DESCRIPTION_REQUIRED: "Escriba una descripción de 2 a 120 caracteres para el otro cargo.",
    POS_CHARGE_DESCRIPTION_INVALID: "La descripción del cargo debe tener de 2 a 120 caracteres y no puede contener HTML ni saltos de línea.",
  };
  let context: { currentVersion?: number; status?: string; updatedAt?: string } = {};
  if (code === "PT409" && error?.details) {
    try { context = JSON.parse(error.details) as typeof context; } catch { context = {}; }
  }
  const safe = error?.message && validationMessages[error.message] ? validationMessages[error.message]
    : code === "42501" ? "Acceso denegado."
    : code === "P0002" ? "No se encontró el recurso solicitado."
      : code === "PT409" ? "Los datos cambiaron en otra pestaña o dispositivo. Recarga e intenta de nuevo."
        : code === "55000" ? "La operación todavía está en proceso."
          : code === "22023" && error?.message ? error.message
            : fallback;
  throw new PosDraftServiceError(safe, code, context);
}

const confirmationMessages: Record<string, string> = {
  POS_CREDIT_OVERDUE: "Existe saldo vencido: el credito esta en espera.",
  POS_CREDIT_OVERRIDE_DISABLED: "La autorizacion excepcional esta deshabilitada.",
  POS_CREDIT_OVERRIDE_FORBIDDEN: "No tienes permiso para autorizar esta excepcion.",
  POS_CREDIT_OVERRIDE_REASON_REQUIRED: "Escribe un motivo de autorizacion de al menos 10 caracteres.",
  POS_CREDIT_OVERRIDE_INVALID: "La autorizacion excepcional solo aplica a credito comercial.",
  POS_DRAFT_NOT_FOUND: "No se encontró el borrador de venta.",
  POS_DRAFT_ALREADY_CONFIRMED: "La venta ya fue confirmada con otros datos.",
  POS_DRAFT_CANCELLED: "El borrador fue abandonado.",
  POS_DRAFT_EXPIRED: "El borrador venció. Crea uno nuevo.",
  POS_DRAFT_CHANGED: "El borrador cambió. Recarga y revisa antes de confirmar.",
  POS_PERMISSION_DENIED: "No tienes permiso para confirmar ventas POS.",
  POS_CUSTOMER_INVALID: "El cliente ya no está disponible para esta venta.",
  POS_CUSTOMER_SUSPENDED: "Este cliente está suspendido y no puede utilizarse para una nueva venta.",
  POS_PRODUCT_INACTIVE: "Un producto ya no está activo.",
  POS_INSUFFICIENT_STOCK: "El inventario cambió y ya no hay existencias suficientes.",
  POS_PRICE_CHANGED: "Un precio, impuesto o condición comercial cambió. Guarda y revisa de nuevo.",
  POS_MANUAL_PRICE_DENIED: "El precio manual ya no cumple las reglas autorizadas.",
  POS_TAX_CONFIGURATION_INVALID: "La configuración tributaria no es válida.",
  POS_PAYMENT_METHOD_INVALID: "Selecciona un método de pago válido.",
  POS_AMOUNT_TENDERED_INSUFFICIENT: "El efectivo recibido debe cubrir el total.",
  POS_TRANSFER_REFERENCE_REQUIRED: "Confirma la transferencia e ingresa su referencia.",
  POS_CARD_CONFIGURATION_INVALID: "La cuenta puente genérica para tarjeta no está configurada.",
  POS_SHIPPING_MAPPING_INVALID: "El cargo de entrega no tiene un mapeo contable activo para la fecha de la factura.",
  POS_COD_MAPPING_INVALID: "El cargo contra entrega no tiene un mapeo contable activo para la fecha de la factura.",
  POS_OTHER_CHARGE_MAPPING_INVALID: "El cargo adicional u otro cargo no tiene un mapeo contable activo para la fecha de la factura.",
  POS_ADDITIONAL_CHARGE_DESCRIPTION_REQUIRED: "Escriba una descripción de 2 a 120 caracteres para el cargo adicional.",
  POS_OTHER_CHARGE_DESCRIPTION_REQUIRED: "Escriba una descripción de 2 a 120 caracteres para el otro cargo.",
  POS_CHARGE_DESCRIPTION_INVALID: "La descripción del cargo debe tener de 2 a 120 caracteres y no puede contener HTML ni saltos de línea.",
  POS_CREDIT_DISABLED: "El cliente no tiene crédito comercial habilitado.",
  POS_CREDIT_SUSPENDED: "La cuenta de crédito está suspendida.",
  POS_CREDIT_INSUFFICIENT: "El crédito disponible no cubre la venta.",
  POS_CONFIRMATION_CONFLICT: "La confirmación entró en conflicto. Recupera la venta antes de reintentar.",
  POS_REQUEST_KEY_CONFLICT: "La solicitud ya fue utilizada con datos diferentes.",
};

function throwConfirmationError(error: { code?: string; message?: string } | null): never {
  const safeCode = error?.message && confirmationMessages[error.message]
    ? error.message
    : error?.code === "42501" ? "POS_PERMISSION_DENIED" : "POS_CONFIRMATION_FAILED";
  throw new PosDraftServiceError(
    confirmationMessages[safeCode] ?? "No se pudo confirmar la venta. Ningún cambio económico fue aplicado.",
    safeCode,
  );
}

function confirmationResult(row: ConfirmationRow): PosConfirmationResult {
  return {
    status: row.status,
    replayed: row.replayed,
    draftId: row.draft_id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    invoiceId: row.invoice_id,
    invoiceNumber: row.invoice_number,
    paymentId: row.payment_id,
    receivableId: row.receivable_id,
    total: numberValue(row.total),
    paymentMethod: row.payment_method,
    amountTendered: row.amount_tendered === null ? null : numberValue(row.amount_tendered),
    changeDue: row.change_due === null ? null : numberValue(row.change_due),
    invoiceDate: row.invoice_date,
    receiptReference: row.receipt_reference,
    accountingStatus: row.accounting_status,
  };
}

function inventorySnapshot(row: InventorySnapshotRow): PosInventorySnapshot {
  return {
    productId: row.product_id,
    tracksInventory: row.tracks_inventory,
    physicalStock: nullableNumberValue(row.physical_stock),
    reservedStock: nullableNumberValue(row.reserved_stock),
    availableStock: nullableNumberValue(row.available_stock),
    hasActiveReservations: row.has_active_reservations,
    stockObservedAt: row.stock_observed_at,
  };
}

async function loadInventorySnapshotMap(
  supabase: Awaited<ReturnType<typeof getSupabaseServerClient>>,
  productIds: readonly string[],
) {
  const uniqueProductIds = [...new Set(productIds)];
  if (!uniqueProductIds.length) return new Map<string, PosInventorySnapshot>();
  const { data, error } = await supabase.rpc("get_pos_product_inventory_snapshot_v1", {
    p_product_ids: uniqueProductIds,
  });
  if (error) throwRpcError(error, "No se pudieron actualizar las existencias.");
  return new Map(
    ((data ?? []) as InventorySnapshotRow[]).map((row) => {
      const snapshot = inventorySnapshot(row);
      return [snapshot.productId, snapshot] as const;
    }),
  );
}

async function enrichDraftInventorySnapshots(
  supabase: Awaited<ReturnType<typeof getSupabaseServerClient>>,
  draft: PosSaleDraft,
) {
  if (!draft.items.length) return draft;
  const snapshots = await loadInventorySnapshotMap(
    supabase,
    draft.items.map((item) => item.productId),
  );
  return applyPosDraftInventorySnapshots(draft, snapshots);
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
  const inventorySnapshots = await loadInventorySnapshotMap(
    supabase,
    rows.map((row) => row.product_id),
  );
  const results: PosProductSearchResult[] = rows.map((row) => {
    const snapshot = inventorySnapshots.get(row.product_id);
    if (!snapshot) {
      throw new PosDraftServiceError(
        "No se pudo obtener la disponibilidad actual del producto.",
        "POS_INVENTORY_SNAPSHOT_MISSING",
      );
    }
    return {
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
      physicalStock: snapshot.physicalStock,
      reservedStock: snapshot.reservedStock,
      availableStock: snapshot.availableStock,
      tracksInventory: snapshot.tracksInventory,
      hasActiveReservations: snapshot.hasActiveReservations,
      stockObservedAt: snapshot.stockObservedAt,
      lowStockThreshold: numberValue(row.low_stock_threshold),
      imageUrl: row.image_url,
    };
  });
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
  const { data, error } = await supabase.rpc("create_selectable_pos_sale_draft_v1", { p_request_key: requestKey, p_customer_id: customerId });
  if (error || !data) throwRpcError(error, "No se pudo crear el borrador.");
  return data as unknown as PosSaleDraft;
}

export async function getPosDraft(draftId: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_pos_sale_draft_v1", { p_draft_id: draftId });
  if (error || !data) throwRpcError(error, "No se pudo cargar el borrador.");
  return enrichDraftInventorySnapshots(supabase, data as unknown as PosSaleDraft);
}

export async function listPosDrafts(limit: number, offset: number) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("list_pos_sale_drafts_v1", { p_limit: limit, p_offset: offset });
  if (error) throwRpcError(error, "No se pudieron listar los borradores.");
  return (data ?? []) as unknown as PosActiveDraftSummary[];
}

export async function savePosDraft(input: PosDraftSaveInput) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc('save_pos_sale_draft_with_charge_descriptions_v1', {
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
    p_delivery_charge: input.shippingFee,
    p_cash_on_delivery_charge: input.codFee,
    p_additional_charge: input.additionalCharge,
    p_other_charge: input.otherCharge,
    p_additional_charge_description: input.additionalChargeDescription,
    p_other_charge_description: input.otherChargeDescription,
  });
  if (error || !data) throwRpcError(error, "No se pudo guardar el borrador.");
  return enrichDraftInventorySnapshots(supabase, data as unknown as PosSaleDraft);
}

export async function getPosProductInventorySnapshots(productIds: readonly string[]) {
  const supabase = await getSupabaseServerClient();
  const snapshots = await loadInventorySnapshotMap(supabase, productIds);
  return [...snapshots.values()];
}

export async function getPosProductReservations(input: {
  productId: string;
  limit: number;
  offset: number;
}): Promise<PosProductReservationPage> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_pos_product_reservations_v1", {
    p_product_id: input.productId,
    p_limit: input.limit,
    p_offset: input.offset,
  });
  if (error) throwRpcError(error, "No se pudieron consultar los pedidos relacionados.");
  const rows = (data ?? []) as ProductReservationRow[];
  const results: PosProductReservation[] = rows.map((row) => ({
    reservationId: row.reservation_id,
    orderId: row.order_id,
    orderNumber: row.order_number,
    reservedQuantity: numberValue(row.reserved_quantity),
    reservationStatus: row.reservation_status,
    orderStatus: row.order_status,
    reservationCreatedAt: row.reservation_created_at,
    expiresAt: row.expires_at,
    reviewRequired: row.review_required,
  }));
  const total = numberValue(rows[0]?.total_count);
  return {
    results,
    total,
    nextOffset: input.offset + results.length < total ? input.offset + results.length : null,
  };
}

export async function abandonPosDraft(requestKey: string, draftId: string, expectedVersion: number) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("abandon_pos_sale_draft_v1", { p_request_key: requestKey, p_draft_id: draftId, p_expected_version: expectedVersion });
  if (error || !data) throwRpcError(error, "No se pudo abandonar el borrador.");
  return data as unknown as PosSaleDraft;
}

export async function confirmPosSale(input: PosConfirmationInput) {
  const supabase = await getSupabaseServerClient();
  const basePaymentPayload = input.payment.method === "cash"
    ? { method: input.payment.method, amount_tendered: input.payment.amountTendered }
    : input.payment.method === "commercial_credit"
      ? {
          method: input.payment.method,
          ...(input.payment.overdueOverrideReason
            ? { overdue_override_reason: input.payment.overdueOverrideReason.trim() }
            : {}),
        }
      : input.payment;
  const paymentPayload = {
    ...basePaymentPayload,
    price_override_request_ids: input.priceOverrideRequestIds ?? [],
  };
  const { data, error } = await supabase.rpc("confirm_pos_sale_with_charge_descriptions_v1", {
    p_draft_id: input.draftId,
    p_request_key: input.requestKey,
    p_expected_draft_version: input.expectedDraftVersion,
    p_invoice_date: input.invoiceDate,
    p_payment_payload: paymentPayload,
  });
  if (error || !data) throwConfirmationError(error);
  return confirmationResult(data as unknown as ConfirmationRow);
}

export async function getPosCreditOverdueOverrideCapability(): Promise<PosCreditOverdueOverrideCapability> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .rpc("get_pos_credit_overdue_override_capability_v1")
    .single<CreditOverrideCapabilityRow>();
  if (error || !data) throwRpcError(error, "No se pudo consultar la autorizacion excepcional de credito.");
  return {
    featureEnabled: Boolean(data.feature_enabled),
    overrideAllowed: Boolean(data.override_allowed),
  };
}

export async function recoverPosSaleConfirmation(draftId: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("recover_pos_sale_confirmation_v1", {
    p_draft_id: draftId,
  });
  if (error || !data) throwConfirmationError(error);
  return confirmationResult(data as unknown as ConfirmationRow);
}
