"use server";

import { revalidatePath } from "next/cache";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { revalidateProductAvailability } from "@/lib/product-availability-cache";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { InventoryAdjustmentDraftInput, InventoryAdjustmentProduct } from "@/types/inventory-adjustments";

type MutationResult = { ok: boolean; message: string; id?: string; version?: number };

function friendlyInventoryError(message: string) {
  if (message.includes("VERSION_CONFLICT") || message.includes("STOCK_CONFLICT")) return "Las existencias cambiaron mientras preparaba el ajuste. Revise las cantidades.";
  if (message.includes("RESERVED") || message.includes("stock_reservation")) return "No hay suficiente inventario libre debido a reservas existentes.";
  if (message.includes("CLOSED_PERIOD")) return "La fecha seleccionada pertenece a un período cerrado.";
  if (message.includes("PRODUCT_NOT_FOUND")) return "El producto ya no está disponible para este ajuste.";
  if (message.includes("INVALID_COST")) return "Uno de los productos no tiene un costo válido. Revise su costo antes de confirmar.";
  if (message.includes("DUPLICATE_PRODUCT")) return "Cada producto solo puede aparecer una vez en el ajuste.";
  if (message.includes("REASON_DETAIL_REQUIRED")) return "Escriba el detalle cuando seleccione el motivo Otro.";
  if (message.includes("NOT_CONFIRMABLE") || message.includes("IMMUTABLE")) return "Este ajuste ya no puede modificarse o confirmarse.";
  if (message.includes("FORBIDDEN")) return "No tiene permiso para realizar esta operación.";
  return "No se pudo completar la operación. Revise los datos e intente nuevamente.";
}

function validateDraft(input: InventoryAdjustmentDraftInput): string | null {
  if (!input.requestKey || !input.effectiveDate) return "Complete la fecha efectiva.";
  if (!Array.isArray(input.lines) || input.lines.length < 1 || input.lines.length > 100) return "Agregue entre 1 y 100 productos.";
  if (new Set(input.lines.map((line) => line.product_id)).size !== input.lines.length) return "Cada producto solo puede aparecer una vez.";
  for (const line of input.lines) {
    if (!line.product_id || !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 1_000_000) return "Las cantidades deben ser enteros entre 1 y 1,000,000.";
    if (line.reason_code === "other" && !line.reason_detail?.trim()) return "Escriba el detalle cuando seleccione el motivo Otro.";
  }
  if (input.reference.trim().length > 160 || input.notes.trim().length > 2000) return "La referencia o la observación supera el límite permitido.";
  return null;
}

export async function saveInventoryAdjustmentDraftAction(input: InventoryAdjustmentDraftInput): Promise<MutationResult> {
  await requirePermission("inventory:adjust_create");
  const validation = validateDraft(input);
  if (validation) return { ok: false, message: validation };
  const supabase = await getSupabaseServerClient();
  if (input.adjustmentId) {
    const { data, error } = await supabase.rpc("update_inventory_adjustment_draft_v1", {
      p_adjustment_id: input.adjustmentId, p_expected_version: input.expectedVersion ?? 1,
      p_effective_date: input.effectiveDate, p_reference: input.reference, p_notes: input.notes, p_lines: input.lines,
    });
    if (error) return { ok: false, message: friendlyInventoryError(error.message) };
    revalidatePath("/admin/inventario/ajustes");
    return { ok: true, id: input.adjustmentId, version: Number(data), message: "Borrador actualizado." };
  }
  const { data, error } = await supabase.rpc("create_inventory_adjustment_v1", {
    p_request_key: input.requestKey, p_effective_date: input.effectiveDate,
    p_reference: input.reference, p_notes: input.notes, p_lines: input.lines,
  });
  if (error) return { ok: false, message: friendlyInventoryError(error.message) };
  revalidatePath("/admin/inventario/ajustes");
  return { ok: true, id: String(data), version: 1, message: "Borrador guardado." };
}

export async function confirmInventoryAdjustmentAction(id: string, version: number, requestKey: string): Promise<MutationResult> {
  await requirePermission("inventory:adjust_confirm");
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("confirm_inventory_adjustment_v1", { p_adjustment_id: id, p_expected_version: version, p_request_key: requestKey });
  if (error) return { ok: false, message: friendlyInventoryError(error.message) };
  revalidateProductAvailability({ adminPaths: ["/admin/inventario", "/admin/inventario/ajustes", "/admin/productos", "/admin/reportes", "/admin/contabilidad"] });
  return { ok: true, id: String(data), version: version + 1, message: "Ajuste confirmado correctamente." };
}

export async function cancelInventoryAdjustmentAction(id: string, version: number): Promise<MutationResult> {
  await requirePermission("inventory:adjust_create");
  const supabase = await getSupabaseServerClient();
  const { error } = await supabase.rpc("cancel_inventory_adjustment_v1", { p_adjustment_id: id, p_expected_version: version });
  if (error) return { ok: false, message: friendlyInventoryError(error.message) };
  revalidatePath("/admin/inventario/ajustes");
  return { ok: true, message: "Borrador cancelado." };
}

export async function reverseInventoryAdjustmentAction(id: string, requestKey: string): Promise<MutationResult> {
  await requirePermission("inventory:adjust_reverse");
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("reverse_inventory_adjustment_v1", { p_adjustment_id: id, p_request_key: requestKey });
  if (error) return { ok: false, message: friendlyInventoryError(error.message) };
  revalidateProductAvailability({ adminPaths: ["/admin/inventario", "/admin/inventario/ajustes", "/admin/productos", "/admin/reportes", "/admin/contabilidad"] });
  return { ok: true, id: String(data), message: "Reversión completa registrada." };
}

export async function searchInventoryAdjustmentProductsAction(query: string): Promise<{ ok: boolean; items: InventoryAdjustmentProduct[]; message?: string }> {
  const profile = await requirePermission("inventory:adjust_read");
  const canCost = hasEffectivePermission(profile.role, profile.permissions, "inventory:cost_read", profile.email);
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("search_inventory_adjustment_products_v1", { p_query: query.trim() || null, p_limit: 25 });
  if (error) return { ok: false, items: [], message: "No se pudo buscar productos." };
  const items = (data ?? []) as unknown as InventoryAdjustmentProduct[];
  return { ok: true, items: items.map((item) => canCost ? item : { ...item, cost_price: undefined }) };
}
