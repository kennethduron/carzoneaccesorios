import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-admin";
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
    cost_price: unknown;
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

const inventoryMovementTypes = ["sale", "return", "adjustment"];
const reservationReferenceTypes = new Set(["reservation", "inventory_reservation", "inventory_reservations", "stock_reservation", "stock_reservations"]);
const writeoffReferenceTypes = new Set(["writeoff", "inventory_writeoff", "merma", "baja", "dado_de_baja"]);

function toNumber(value: unknown) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? Math.round(numberValue * 100) / 100 : 0;
}

function normalizeText(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function orderIdForMovement(row: InventoryMovementEventRow) {
  return row.reference_type === "orders" && row.reference_id ? row.reference_id : null;
}

function isReservationOnlyMovement(row: InventoryMovementEventRow) {
  return reservationReferenceTypes.has(normalizeText(row.reference_type));
}

function movementCost(row: InventoryMovementEventRow, allowProductCostFallback: boolean) {
  const quantity = Math.abs(toNumber(row.quantity));
  let unitCost = toNumber(row.unit_cost_snapshot);
  let totalCost = toNumber(row.total_cost_snapshot);
  let costSource = row.cost_source;
  let costCapturedAt = row.cost_captured_at;

  if ((unitCost <= 0 || totalCost <= 0) && allowProductCostFallback) {
    const productCost = toNumber(row.products?.cost_price);
    if (productCost > 0) {
      unitCost = unitCost > 0 ? unitCost : productCost;
      totalCost = totalCost > 0 ? totalCost : Math.round(productCost * quantity * 100) / 100;
      costSource = costSource ?? "product_cost_price_at_inventory_adjustment";
      costCapturedAt = costCapturedAt ?? row.created_at;
    }
  }

  return { quantity, unitCost, totalCost, costSource, costCapturedAt };
}

function buildSaleValidationErrors(unitCost: number, totalCost: number, orderStatus: string | null) {
  const errors: string[] = [];
  if (unitCost <= 0 || totalCost <= 0) {
    errors.push("No se puede generar la partida porque falta el costo histórico del producto.");
  }

  if (!orderStatus || !finalizedOrderStatuses.has(orderStatus)) {
    errors.push("El movimiento de inventario no pertenece a una venta finalizada.");
  }

  return errors;
}

function buildReturnValidationErrors(unitCost: number, totalCost: number, linkedToSale: boolean) {
  const errors: string[] = [];
  if (unitCost <= 0 || totalCost <= 0) {
    errors.push("No se puede generar la partida de devolución porque falta el costo histórico original.");
  }

  if (!linkedToSale) {
    errors.push("La devolución de inventario no está vinculada a una venta previa.");
  }

  return errors;
}

function buildAdjustmentValidationErrors(unitCost: number, totalCost: number) {
  return unitCost > 0 && totalCost > 0 ? [] : ["No se puede calcular el valor contable del movimiento porque falta el costo del producto."];
}

function inventorySnapshot(row: InventoryMovementEventRow, cost: ReturnType<typeof movementCost>) {
  return {
    inventory_movement_id: row.id,
    product_id: row.product_id,
    product_name: row.products?.name ?? null,
    sku: row.products?.sku ?? null,
    quantity: cost.quantity,
    unit_cost_snapshot: cost.unitCost,
    total_cost_snapshot: cost.totalCost,
    cost_source: cost.costSource,
    cost_captured_at: cost.costCapturedAt,
    movement_type: row.movement_type,
    movement_date: row.created_at,
    reference_type: row.reference_type,
    reference_id: row.reference_id,
  };
}

export async function getInventoryFinancialEventCandidates(): Promise<FinancialEventCandidate[]> {
  const supabase = getSupabaseAdminClient();
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
      products(name, sku, cost_price)
    `,
    )
    .in("movement_type", inventoryMovementTypes)
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<InventoryMovementEventRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []).filter((row) => !isReservationOnlyMovement(row));
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
    const stockBefore = toNumber(row.stock_before);
    const stockAfter = toNumber(row.stock_after);
    const orderId = orderIdForMovement(row);
    const orderStatus = orderId ? orderStatusById.get(orderId) ?? null : null;
    const isPhysicalDeduction = row.movement_type === "sale" && quantity < 0 && stockAfter < stockBefore;
    const isFinalizedSale = Boolean(orderStatus && finalizedOrderStatuses.has(orderStatus));
    const isReturnToStock = row.movement_type === "return" && quantity > 0 && stockAfter > stockBefore;
    const isAdjustmentGain = row.movement_type === "adjustment" && quantity > 0 && stockAfter > stockBefore;
    const isAdjustmentLoss = row.movement_type === "adjustment" && quantity < 0 && stockAfter < stockBefore;
    const isWriteoff = isAdjustmentLoss && writeoffReferenceTypes.has(normalizeText(row.reference_type));
    const allowProductCostFallback = isAdjustmentGain || isAdjustmentLoss;
    const cost = movementCost(row, allowProductCostFallback);
    const linkedToSale = Boolean(orderId || row.order_item_id);

    if (row.movement_type === "return") {
      return {
        eventType: "inventory_return_movement",
        source_type: "inventory_movement",
        source_id: row.id,
        event_purpose: "inventory_return",
        posting_version: "v1",
        occurred_at: row.created_at,
        amount: cost.totalCost,
        eligible: isReturnToStock && linkedToSale,
        validation_errors: buildReturnValidationErrors(cost.unitCost, cost.totalCost, linkedToSale),
        source_snapshot: inventorySnapshot(row, cost),
      };
    }

    if (isAdjustmentGain || isAdjustmentLoss) {
      return {
        eventType: isAdjustmentGain ? "inventory_adjustment_gain" : isWriteoff ? "inventory_writeoff" : "inventory_adjustment_loss",
        source_type: "inventory_movement",
        source_id: row.id,
        event_purpose: isAdjustmentGain ? "inventory_adjustment_gain" : isWriteoff ? "inventory_writeoff" : "inventory_adjustment_loss",
        posting_version: "v1",
        occurred_at: row.created_at,
        amount: cost.totalCost,
        eligible: true,
        validation_errors: buildAdjustmentValidationErrors(cost.unitCost, cost.totalCost),
        source_snapshot: inventorySnapshot(row, cost),
      };
    }

    const costForSale = movementCost(row, false);
    return {
      eventType: "inventory_sale_movement",
      source_type: "inventory_movement",
      source_id: row.id,
      event_purpose: "inventory_cogs",
      posting_version: "v1",
      occurred_at: row.created_at,
      amount: costForSale.totalCost,
      eligible: isPhysicalDeduction && isFinalizedSale,
      validation_errors: buildSaleValidationErrors(costForSale.unitCost, costForSale.totalCost, orderStatus),
      source_snapshot: inventorySnapshot(row, costForSale),
    };
  });
}
