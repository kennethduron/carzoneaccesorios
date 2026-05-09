"use server";

import { revalidatePath } from "next/cache";
import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { InventoryMovementInput } from "@/types/inventory";

type InventoryMutationResult = {
  ok: boolean;
  message: string;
};

function movementDelta(type: InventoryMovementInput["movement_type"], quantity: number) {
  if (type === "purchase" || type === "return") {
    return Math.abs(quantity);
  }

  if (type === "sale") {
    return -Math.abs(quantity);
  }

  return quantity;
}

export async function createInventoryMovementAction(input: InventoryMovementInput): Promise<InventoryMutationResult> {
  const profile = await requirePermission("inventory:manage");
  const quantity = Number(input.quantity);

  if (!input.product_id || !Number.isFinite(quantity) || quantity === 0) {
    return { ok: false, message: "Selecciona un producto y una cantidad valida." };
  }

  const supabase = await getSupabaseServerClient();
  const { data: product, error: productError } = await supabase
    .from("products")
    .select("id, stock")
    .eq("id", input.product_id)
    .single<{ id: string; stock: number }>();

  if (productError || !product) {
    return { ok: false, message: productError?.message ?? "Producto no encontrado." };
  }

  const stockBefore = Number(product.stock);
  const delta = movementDelta(input.movement_type, quantity);
  const stockAfter = stockBefore + delta;

  if (stockAfter < 0) {
    return { ok: false, message: `Solo hay ${stockBefore} unidades disponibles.` };
  }

  const { error: updateError } = await supabase
    .from("products")
    .update({
      stock: stockAfter,
    })
    .eq("id", input.product_id);

  if (updateError) {
    return { ok: false, message: updateError.message };
  }

  const { error: movementError } = await supabase.from("inventory_movements").insert({
    product_id: input.product_id,
    user_id: profile.id,
    movement_type: input.movement_type,
    quantity: delta,
    stock_before: stockBefore,
    stock_after: stockAfter,
    reference_type: "inventory",
    notes: input.notes.trim() || null,
  });

  if (movementError) {
    return { ok: false, message: movementError.message };
  }

  await writeAuditLog({
    tableName: "inventory_movements",
    recordId: input.product_id,
    action: "inventory.movement.created",
    newData: {
      product_id: input.product_id,
      movement_type: input.movement_type,
      quantity: delta,
      stock_before: stockBefore,
      stock_after: stockAfter,
    },
  });

  revalidatePath("/admin/inventario");
  revalidatePath("/admin/productos");
  revalidatePath("/catalogo");
  revalidatePath("/");

  return { ok: true, message: "Movimiento de inventario registrado." };
}
