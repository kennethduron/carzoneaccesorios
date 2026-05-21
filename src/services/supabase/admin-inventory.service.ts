import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { InventoryMovementRow, InventoryProductOption } from "@/types/inventory";

type MovementQueryRow = Omit<InventoryMovementRow, "product_name" | "product_sku"> & {
  products: {
    name: string;
    sku: string;
  } | null;
};

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

function normalizeMovement(row: MovementQueryRow): InventoryMovementRow {
  return {
    id: row.id,
    product_id: row.product_id,
    product_name: row.products?.name ?? null,
    product_sku: row.products?.sku ?? null,
    user_id: row.user_id,
    movement_type: row.movement_type,
    quantity: toNumber(row.quantity),
    stock_before: toNumber(row.stock_before),
    stock_after: toNumber(row.stock_after),
    reference_type: row.reference_type,
    reference_id: row.reference_id,
    notes: row.notes,
    created_at: row.created_at,
  };
}

export async function getAdminInventory() {
  const supabase = await getSupabaseServerClient();

  const [{ data: products, error: productsError }, { data: movements, error: movementsError }] =
    await Promise.all([
      supabase
        .from("products")
        .select("id, sku, name, stock, reserved_stock, available_stock, min_stock")
        .order("name", { ascending: true })
        .returns<InventoryProductOption[]>(),
      supabase
        .from("inventory_movements")
        .select(
          `
          id,
          product_id,
          user_id,
          movement_type,
          quantity,
          stock_before,
          stock_after,
          reference_type,
          reference_id,
          notes,
          created_at,
          products(name, sku)
        `,
        )
        .order("created_at", { ascending: false })
        .limit(100)
        .returns<MovementQueryRow[]>(),
    ]);

  if (productsError) {
    throw new Error(productsError.message);
  }

  if (movementsError) {
    throw new Error(movementsError.message);
  }

  return {
    products: (products ?? []).map((product) => ({
      ...product,
      stock: toNumber(product.stock),
      reserved_stock: toNumber(product.reserved_stock),
      available_stock: toNumber(product.available_stock ?? product.stock),
      min_stock: toNumber(product.min_stock),
    })),
    movements: (movements ?? []).map(normalizeMovement),
  };
}
