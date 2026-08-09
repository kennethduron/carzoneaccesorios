import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { InventoryAdjustmentDocument, InventoryAdjustmentListResult } from "@/types/inventory-adjustments";

export async function getInventoryAdjustments(filters: {
  query?: string; status?: string; from?: string; to?: string; page?: number; pageSize?: number;
} = {}): Promise<InventoryAdjustmentListResult> {
  const supabase = await getSupabaseServerClient();
  const pageSize = Math.min(Math.max(Number(filters.pageSize) || 50, 1), 100);
  const page = Math.max(Number(filters.page) || 1, 1);
  const { data, error } = await supabase.rpc("list_inventory_adjustments_v1", {
    p_query: filters.query?.trim() || null,
    p_status: filters.status || null,
    p_from: filters.from || null,
    p_to: filters.to || null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  if (error) throw new Error("No se pudo cargar el historial de ajustes.");
  return (data ?? { total: 0, items: [] }) as unknown as InventoryAdjustmentListResult;
}

export async function getInventoryAdjustment(id: string): Promise<InventoryAdjustmentDocument> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_inventory_adjustment_v1", { p_adjustment_id: id });
  if (error || !data) throw new Error("No se encontró el ajuste solicitado.");
  return data as unknown as InventoryAdjustmentDocument;
}
