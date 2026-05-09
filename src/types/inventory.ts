export type InventoryMovementType = "purchase" | "sale" | "return" | "adjustment";

export type InventoryProductOption = {
  id: string;
  sku: string;
  name: string;
  stock: number;
  min_stock: number;
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
  notes: string | null;
  created_at: string;
};

export type InventoryMovementInput = {
  product_id: string;
  movement_type: InventoryMovementType;
  quantity: number;
  notes: string;
};
