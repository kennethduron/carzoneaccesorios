import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getAdminDashboardOverview } from "@/services/supabase/admin-dashboard.service";
import type { InventoryMovementRow, InventoryProductOption } from "@/types/inventory";

export type AdminInventoryFilters = {
  query?: string;
  filter?: "low_stock" | null;
  movementPage?: number;
  movementPageSize?: number;
};

export type AdminInventorySummary = {
  productsTotal: number;
  productOptionsLoaded: number;
  lowStockProducts: number;
  outOfStockProducts: number;
  activeReservations: number;
  movementsTotal: number;
  movementPage: number;
  movementPageSize: number;
};

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

function normalizePage(value: unknown) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizePageSize(value: unknown) {
  const pageSize = Number(value);
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return 50;
  }

  return Math.min(Math.floor(pageSize), 100);
}

export async function getAdminInventory(filters: AdminInventoryFilters = {}) {
  const supabase = await getSupabaseServerClient();
  const query = filters.query?.trim() ?? "";
  const movementPage = normalizePage(filters.movementPage);
  const movementPageSize = normalizePageSize(filters.movementPageSize);
  const movementFrom = (movementPage - 1) * movementPageSize;
  const movementTo = movementFrom + movementPageSize - 1;

  let productsQuery = supabase
    .from("products")
    .select("id, sku, name, stock, reserved_stock, available_stock, min_stock", { count: "exact" })
    .order("name", { ascending: true })
    .limit(50);

  if (query) {
    productsQuery = productsQuery.or(`sku.ilike.%${query}%,internal_code.ilike.%${query}%,name.ilike.%${query}%,brand.ilike.%${query}%`);
  }

  const productsRequest =
    filters.filter === "low_stock"
      ? supabase
          .rpc("get_admin_low_stock_products", {
            result_limit: 50,
            search_query: query || null,
          })
          .returns<InventoryProductOption[]>()
      : productsQuery.returns<InventoryProductOption[]>();

  const [{ data: products, error: productsError, count }, { data: movements, error: movementsError, count: movementsTotal }, overview] =
    await Promise.all([
      productsRequest,
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
          { count: "exact" },
        )
        .order("created_at", { ascending: false })
        .range(movementFrom, movementTo)
        .returns<MovementQueryRow[]>(),
      getAdminDashboardOverview(),
    ]);

  if (productsError) {
    throw new Error(productsError.message);
  }

  if (movementsError) {
    throw new Error(movementsError.message);
  }

  const productRows: InventoryProductOption[] = Array.isArray(products) ? products : [];
  const normalizedProducts = productRows.map((product) => ({
      ...product,
      stock: toNumber(product.stock),
      reserved_stock: toNumber(product.reserved_stock),
      available_stock: toNumber(product.available_stock ?? product.stock),
      min_stock: toNumber(product.min_stock),
    }));

  return {
    products: normalizedProducts,
    summary: {
      productsTotal: count ?? normalizedProducts.length,
      productOptionsLoaded: normalizedProducts.length,
      lowStockProducts: overview.lowStockProducts,
      outOfStockProducts: overview.outOfStockProducts,
      activeReservations: overview.activeReservations,
      movementsTotal: movementsTotal ?? 0,
      movementPage,
      movementPageSize,
    } satisfies AdminInventorySummary,
    movements: (movements ?? []).map(normalizeMovement),
  };
}
