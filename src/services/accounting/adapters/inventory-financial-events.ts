import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { FinancialEventCandidate } from "@/services/accounting/financial-event-engine";

type InventoryMovementEventRow = {
  id: string;
  product_id: string;
  movement_type: string;
  quantity: unknown;
  stock_before: unknown;
  stock_after: unknown;
  reference_type: string | null;
  reference_id: string | null;
  order_item_id: string | null;
  unit_cost_snapshot: unknown;
  total_cost_snapshot: unknown;
  cost_source: string | null;
  cost_captured_at: string | null;
  created_at: string;
  products: {
    name: string | null;
    sku: string | null;
  } | null;
};

type OrderStatusRow = {
  id: string;
  status: string | null;
};

const finalizedOrderStatuses = new Set([
  "confirmado",
  "confirmed",
  "paid",
  "preparacion",
  "preparing",
  "empacado",
  "enviado",
  "en_ruta",
  "entregado",
  "shipped",
  "delivered",
]);

function toNumber(value: unknown) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) / 100 : 0;
}

function orderIdForMovement(row: InventoryMovementEventRow) {
  return row.reference_type === "orders" && row.reference_id ? row.reference_id : null;
}

function buildValidationErrors(unitCost: number, totalCost: number, orderStatus: string | null) {
  const errors: string[] = [];
  if (unitCost <= 0 || totalCost <= 0) {
    errors.push("No se puede calcular el costo de venta porque falta el costo histórico del producto.");
  }

  if (!orderStatus || !finalizedOrderStatuses.has(orderStatus)) {
    errors.push("El movimiento de inventario no pertenece a una venta finalizada.");
  }

  return errors;
}

export async function getInventoryFinancialEventCandidates(): Promise<FinancialEventCandidate[]> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("inventory_movements")
    .select(
      `
      id,
      product_id,
      movement_type,
      quantity,
      stock_before,
      stock_after,
      reference_type,
      reference_id,
      order_item_id,
      unit_cost_snapshot,
      total_cost_snapshot,
      cost_source,
      cost_captured_at,
      created_at,
      products(name, sku)
    `,
    )
    .eq("movement_type", "sale")
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<InventoryMovementEventRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  const rows = data ?? [];
  const orderIds = [...new Set(rows.map(orderIdForMovement).filter((id): id is string => Boolean(id)))];
  const orderStatusById = new Map<string, string | null>();

  if (orderIds.length > 0) {
    const { data: orders, error: ordersError } = await supabase
      .from("orders")
      .select("id, status")
      .in("id", orderIds)
      .returns<OrderStatusRow[]>();

    if (ordersError) {
      throw new Error(ordersError.message);
    }

    for (const order of orders ?? []) {
      orderStatusById.set(order.id, order.status);
    }
  }

  return rows.map((row) => {
    const quantity = toNumber(row.quantity);
    const unitCost = toNumber(row.unit_cost_snapshot);
    const totalCost = toNumber(row.total_cost_snapshot);
    const stockBefore = toNumber(row.stock_before);
    const stockAfter = toNumber(row.stock_after);
    const orderId = orderIdForMovement(row);
    const orderStatus = orderId ? orderStatusById.get(orderId) ?? null : null;
    const isPhysicalDeduction = quantity < 0 && stockAfter < stockBefore;
    const isFinalizedSale = Boolean(orderStatus && finalizedOrderStatuses.has(orderStatus));
    const eligible = row.movement_type === "sale" && isPhysicalDeduction && isFinalizedSale;

    return {
      eventType: "inventory_sale_movement",
      source_type: "inventory_movement",
      source_id: row.id,
      event_purpose: "inventory_cogs",
      posting_version: "v1",
      occurred_at: row.created_at,
      amount: totalCost,
      eligible,
      validation_errors: buildValidationErrors(unitCost, totalCost, orderStatus),
      source_snapshot: {
        inventory_movement_id: row.id,
        product_id: row.product_id,
        product_name: row.products?.name ?? null,
        sku: row.products?.sku ?? null,
        quantity: Math.abs(quantity),
        unit_cost_snapshot: unitCost,
        total_cost_snapshot: totalCost,
        cost_source: row.cost_source,
        cost_captured_at: row.cost_captured_at,
        order_id: orderId,
        order_item_id: row.order_item_id,
        movement_type: row.movement_type,
        movement_date: row.created_at,
      },
    };
  });
}