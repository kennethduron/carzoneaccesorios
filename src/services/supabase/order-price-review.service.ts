import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import {
  classifyOrderPriceReviewV2,
  type OrderPriceAuditEvidence,
  type OrderPriceInvoiceEvidence,
} from "@/lib/orders/order-price-review";
import type { AdminOrderRow, OrderPriceFeatureFlags, OrderPriceReview } from "@/types/orders";

export const disabledOrderPriceFeatureFlags: OrderPriceFeatureFlags = {
  orderPriceReviewV2: false,
  orderPriceConfirmationModalV1: false,
};

export const emptyOrderPriceReview: OrderPriceReview = {
  status: "none",
  reasons: [],
  invoiceConsistent: null,
  legitimateModeFallbackItemIds: [],
  adjustments: [],
};

type FeatureFlagRow = { key: string; enabled: boolean };
type AuditRow = {
  id: string;
  record_id: string | null;
  action: string;
  actor_role: string | null;
  created_at: string;
  new_data: unknown;
  users: { full_name: string | null; email: string | null } | Array<{ full_name: string | null; email: string | null }> | null;
};
type InvoiceRow = {
  id: string;
  order_id: string;
  subtotal: unknown;
  tax: unknown;
  shipping_fee: unknown;
  cash_on_delivery_fee: unknown;
  small_order_fee: unknown;
  discount_total: unknown;
  total: unknown;
  invoice_items: Array<{
    order_item_id: string | null;
    quantity: unknown;
    unit_price: unknown;
    line_total: unknown;
  }> | null;
};

function environmentBoolean(name: string) {
  const value = process.env[name]?.trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function numeric(value: unknown) {
  return Number(value ?? 0);
}

function actorName(row: AuditRow) {
  const user = Array.isArray(row.users) ? row.users[0] : row.users;
  return user?.full_name ?? user?.email ?? null;
}

function normalizeAudit(row: AuditRow): OrderPriceAuditEvidence {
  const data = asObject(row.new_data);
  const priceChanges = asArray(data.price_changes ?? data.lines);
  return {
    auditId: row.id,
    action: row.action as OrderPriceAuditEvidence["action"],
    actorName: actorName(row),
    actorRole: String(data.actor_role ?? row.actor_role ?? ""),
    createdAt: row.created_at,
    versionAfter: data.commercial_terms_version === undefined
      ? numeric(data.version_after) || null
      : numeric(data.commercial_terms_version),
    note: typeof data.note === "string"
      ? data.note
      : typeof data.price_reason === "string" ? data.price_reason : null,
    changes: priceChanges.map((rawChange) => {
      const change = asObject(rawChange);
      return {
        orderItemId: String(change.order_item_id ?? ""),
        automaticUnitPrice: numeric(change.automatic_unit_price ?? change.original_authorized_price),
        previousUnitPrice: numeric(change.previous_unit_price ?? change.previous_final_price),
        finalUnitPrice: numeric(change.final_unit_price ?? change.new_unit_price),
      };
    }).filter((change) => Boolean(change.orderItemId)),
  };
}

function normalizeInvoice(row: InvoiceRow): OrderPriceInvoiceEvidence {
  return {
    subtotal: numeric(row.subtotal),
    tax: numeric(row.tax),
    shippingFee: numeric(row.shipping_fee),
    cashOnDeliveryFee: numeric(row.cash_on_delivery_fee),
    smallOrderFee: numeric(row.small_order_fee),
    discountTotal: numeric(row.discount_total),
    total: numeric(row.total),
    items: (row.invoice_items ?? []).map((item) => ({
      orderItemId: item.order_item_id,
      quantity: numeric(item.quantity),
      unitPrice: numeric(item.unit_price),
      lineTotal: numeric(item.line_total),
    })),
  };
}

export async function getOrderPriceFeatureFlags(): Promise<OrderPriceFeatureFlags> {
  const reviewOverride = environmentBoolean("ORDER_PRICE_REVIEW_V2");
  const confirmationOverride = environmentBoolean("ORDER_PRICE_CONFIRMATION_MODAL_V1");
  const admin = getSupabaseAdminClient();
  const { data } = await admin
    .from("order_price_feature_flags")
    .select("key, enabled")
    .in("key", ["order_price_review_v2", "order_price_confirmation_modal_v1"])
    .returns<FeatureFlagRow[]>();
  const stored = new Map((data ?? []).map((row) => [row.key, Boolean(row.enabled)]));
  return {
    orderPriceReviewV2: reviewOverride ?? stored.get("order_price_review_v2") ?? false,
    orderPriceConfirmationModalV1: confirmationOverride ?? stored.get("order_price_confirmation_modal_v1") ?? false,
  };
}

export async function getOrderPriceReviewBatch(
  orders: AdminOrderRow[],
  flags: OrderPriceFeatureFlags,
) {
  const result = new Map<string, OrderPriceReview>();
  if (!flags.orderPriceReviewV2 || orders.length === 0) return result;

  const admin = getSupabaseAdminClient();
  const orderIds = orders.map((order) => order.id);
  const invoiceIds = orders.flatMap((order) => order.invoice_id ? [order.invoice_id] : []);
  const [auditResult, invoiceResult] = await Promise.all([
    admin
      .from("audit_logs")
      .select("id, record_id, action, actor_role, created_at, new_data, users(full_name, email)")
      .eq("table_name", "orders")
      .in("record_id", orderIds)
      .in("action", ["sale.commercial_terms.adjusted", "sale.price_override.confirmed"])
      .order("created_at", { ascending: true })
      .returns<AuditRow[]>(),
    invoiceIds.length === 0
      ? Promise.resolve({ data: [] as InvoiceRow[], error: null })
      : admin
        .from("invoices")
        .select(`
          id,
          order_id,
          subtotal,
          tax,
          shipping_fee,
          cash_on_delivery_fee,
          small_order_fee,
          discount_total,
          total,
          invoice_items(order_item_id, quantity, unit_price, line_total)
        `)
        .in("id", invoiceIds)
        .returns<InvoiceRow[]>(),
  ]);

  if (auditResult.error) throw new Error(`No se pudo cargar la auditoria de precios: ${auditResult.error.message}`);
  if (invoiceResult.error) throw new Error(`No se pudo validar la factura: ${invoiceResult.error.message}`);

  const auditsByOrder = new Map<string, OrderPriceAuditEvidence[]>();
  for (const row of auditResult.data ?? []) {
    if (!row.record_id) continue;
    const audit = normalizeAudit(row);
    auditsByOrder.set(row.record_id, [...(auditsByOrder.get(row.record_id) ?? []), audit]);
  }
  const invoiceById = new Map(
    (invoiceResult.data ?? []).map((row) => [row.id, normalizeInvoice(row)]),
  );

  for (const order of orders) {
    result.set(order.id, classifyOrderPriceReviewV2(order, {
      audits: auditsByOrder.get(order.id) ?? [],
      invoice: order.invoice_id ? invoiceById.get(order.invoice_id) ?? null : null,
    }));
  }
  return result;
}
