import { hasEffectivePermission } from "@/lib/auth/permissions";
import { getSessionProfile } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AdminSearchResponse, InventoryProductSearchResult } from "@/types/admin-search";

export const dynamic = "force-dynamic";

type InventoryProductSearchRow = {
  id: string;
  sku: string;
  internal_code: string | null;
  name: string;
  brand: string;
  category_name: string | null;
  status: string;
  is_active: boolean;
  stock: number | string | null;
  reserved_stock: number | string | null;
  available_stock: number | string | null;
  min_stock: number | string | null;
  auto_disabled_by_stock: boolean;
  total_count: number | string | null;
};

function boundedInteger(value: string | null, fallback: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 0), maximum) : fallback;
}

function toNumber(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function GET(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) return Response.json({ message: "Autenticación requerida." }, { status: 401 });

  const allowed =
    hasEffectivePermission(profile.role, profile.permissions, "inventory:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "inventory:manage", profile.email);
  if (!allowed) return Response.json({ message: "Acceso denegado." }, { status: 403 });

  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
  const limit = Math.max(1, boundedInteger(url.searchParams.get("limit"), 25, 50));
  const offset = boundedInteger(url.searchParams.get("offset"), 0, 10000);
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("search_inventory_products_v1", {
    p_query: query,
    p_limit: limit,
    p_offset: offset,
    p_include_inactive: true,
  });

  if (error) {
    const status = error.code === "42501" ? 403 : 500;
    return Response.json({ message: status === 403 ? "Acceso denegado." : "No se pudo buscar productos de inventario." }, { status });
  }

  const rows = (data ?? []) as unknown as InventoryProductSearchRow[];
  const results: InventoryProductSearchResult[] = rows.map((row) => ({
    id: row.id,
    sku: row.sku,
    internalCode: row.internal_code,
    name: row.name,
    brand: row.brand,
    categoryName: row.category_name,
    status: row.status,
    isActive: Boolean(row.is_active),
    stock: toNumber(row.stock),
    reservedStock: toNumber(row.reserved_stock),
    availableStock: toNumber(row.available_stock),
    minStock: toNumber(row.min_stock),
    autoDisabledByStock: Boolean(row.auto_disabled_by_stock),
  }));
  const total = toNumber(rows[0]?.total_count);
  const payload: AdminSearchResponse<InventoryProductSearchResult> = {
    results,
    total,
    nextOffset: offset + results.length < total ? offset + results.length : null,
  };

  return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
}
