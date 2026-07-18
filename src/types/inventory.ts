export type InventoryMovementType = "purchase" | "sale" | "return" | "adjustment";

export type InventoryProductOption = {
  id: string;
  sku: string;
  internal_code?: string | null;
  name: string;
  brand?: string | null;
  category_name?: string | null;
  stock: number;
  reserved_stock: number;
  available_stock: number;
  min_stock: number;
  active?: boolean;
  auto_disabled_by_stock?: boolean;
  status?: "active" | "inactive" | "draft" | "archived";
};

export type InventoryMovementRow = {
  id: string;
  product_id: string;
  product_name: string | null;
  product_sku: string | null;
  user_id: string | null;
  movement_type: InventoryMovementType;
  quantity: number;
  stock_before: number;
  stock_after: number;
  reference_type: string | null;
  reference_id: string | null;
  order_item_id?: string | null;
  unit_cost_snapshot?: number | null;
  total_cost_snapshot?: number | null;
  cost_source?: string | null;
  cost_captured_at?: string | null;
  notes: string | null;
  created_at: string;
};

export type InventoryMovementInput = {
  product_id: string;
  movement_type: InventoryMovementType;
  quantity: number;
  notes: string;
};
