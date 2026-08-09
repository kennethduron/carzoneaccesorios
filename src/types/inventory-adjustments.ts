export type InventoryAdjustmentStatus = "draft" | "confirmed" | "cancelled" | "reversed";
export type InventoryAdjustmentDirection = "increase" | "decrease";
export type InventoryAdjustmentReason =
  | "physical_count_surplus"
  | "recovery"
  | "physical_count_shortage"
  | "damage_or_shrinkage"
  | "loss"
  | "operational_error"
  | "other";

export type InventoryAdjustmentProduct = {
  id: string; sku: string; internal_code?: string | null; name: string; brand: string;
  active: boolean; status: string; stock: number; reserved_stock: number; available_stock: number; cost_price?: number;
};

export type InventoryAdjustmentLineInput = {
  product_id: string; direction: InventoryAdjustmentDirection; quantity: number;
  reason_code: InventoryAdjustmentReason; reason_detail?: string; unit_cost?: number;
};

export type InventoryAdjustmentDraftInput = {
  requestKey: string; adjustmentId?: string; expectedVersion?: number; effectiveDate: string;
  reference: string; notes: string; lines: InventoryAdjustmentLineInput[];
};

export type InventoryAdjustmentListItem = {
  id: string; adjustment_number: string; status: InventoryAdjustmentStatus; version: number;
  effective_date: string; reference?: string; created_at: string; confirmed_at?: string;
  actor_name: string; line_count: number; type: "increase" | "decrease" | "mixed";
  increase_quantity: number; decrease_quantity: number; accounting_status: string;
  total_cost?: number; reversal_of_id?: string;
};

export type InventoryAdjustmentListResult = { total: number; items: InventoryAdjustmentListItem[] };

export type InventoryAdjustmentDocument = InventoryAdjustmentListItem & {
  request_key: string; notes?: string; cancelled_at?: string; reversed_at?: string;
  created_by: string; created_by_name: string;
  lines: Array<{
    id: string; product_id: string; direction: InventoryAdjustmentDirection; quantity: number;
    reason_code: InventoryAdjustmentReason; reason_detail?: string; product_sku_snapshot: string;
    product_name_snapshot: string; stock_before: number; reserved_before: number; available_before: number;
    stock_after?: number; reserved_after?: number; available_after?: number; active: boolean;
    unit_cost_snapshot?: number; total_cost_snapshot?: number;
  }>;
};
