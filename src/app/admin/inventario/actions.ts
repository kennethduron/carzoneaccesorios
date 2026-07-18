"use server";

import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { revalidateProductAvailability } from "@/lib/product-availability-cache";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { InventoryMovementInput } from "@/types/inventory";

type InventoryMutationResult = {
  ok: boolean;
  message: string;
};

type InventoryMovementRpcResult = {
  movement_id: string;
  product_id: string;
  stock_before: number;
  stock_after: number;
  quantity: number;
};

export async function createInventoryMovementAction(input: InventoryMovementInput): Promise<InventoryMutationResult> {
  await requirePermission("inventory:manage");
  const quantity = Number(input.quantity);

  if (!input.product_id || !Number.isFinite(quantity) || quantity === 0) {
    return { ok: false, message: "Selecciona un producto y una cantidad valida." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error: movementError } = await supabase.rpc("create_inventory_movement_locked", {
    target_product_id: input.product_id,
    movement_kind: input.movement_type,
    raw_quantity: quantity,
    movement_notes: input.notes.trim() || null,
  });

  if (movementError) {
    return { ok: false, message: movementError.message };
  }

  const movement = (Array.isArray(data) ? data[0] : data) as InventoryMovementRpcResult | null;

  await writeAuditLog({
    tableName: "inventory_movements",
    recordId: movement?.movement_id ?? input.product_id,
    action: "inventory.movement.created",
    newData: {
      product_id: movement?.product_id ?? input.product_id,
      movement_type: input.movement_type,
      quantity: movement?.quantity ?? quantity,
      stock_before: movement?.stock_before,
      stock_after: movement?.stock_after,
    },
  });

  revalidateProductAvailability({
    adminPaths: ["/admin/inventario", "/admin/productos", "/admin/reportes", "/admin/contabilidad"],
  });

  return { ok: true, message: "Movimiento de inventario registrado." };
}
