import { hasEffectivePermission } from "@/lib/auth/permissions";
import { getSessionProfile } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AdminSearchResponse, PurchaseProductSearchResult } from "@/types/admin-search";

export const dynamic = "force-dynamic";

type PurchaseProductSearchRow = {
  id: string;
  sku: string;
  internal_code: string | null;
  name: string;
  brand: string;
  unit: string | null;
  status: string;
  is_active: boolean;
  available_stock: number | string | null;
  cost_price: number | string | null;
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
    hasEffectivePermission(profile.role, profile.permissions, "purchases:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "purchases:manage", profile.email);
  if (!allowed) return Response.json({ message: "Acceso denegado." }, { status: 403 });

  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim().replace(/\s+/g, " ").slice(0, 100);
  const limit = Math.max(1, boundedInteger(url.searchParams.get("limit"), 25, 50));
  const offset = boundedInteger(url.searchParams.get("offset"), 0, 10000);
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("search_purchase_products_v1", {
    p_query: query,
    p_limit: limit,
    p_offset: offset,
    p_include_inactive: true,
  });

  if (error) {
    const status = error.code === "42501" ? 403 : 500;
    return Response.json({ message: status === 403 ? "Acceso denegado." : "No se pudo buscar productos de compras." }, { status });
  }

  const rows = (data ?? []) as unknown as PurchaseProductSearchRow[];
  const results: PurchaseProductSearchResult[] = rows.map((row) => ({
    id: row.id,
    sku: row.sku,
    internalCode: row.internal_code,
    name: row.name,
    brand: row.brand,
    unit: row.unit,
    status: row.status,
    isActive: Boolean(row.is_active),
    availableStock: toNumber(row.available_stock),
    costPrice: toNumber(row.cost_price),
  }));
  const total = toNumber(rows[0]?.total_count);
  const payload: AdminSearchResponse<PurchaseProductSearchResult> = {
    results,
    total,
    nextOffset: offset + results.length < total ? offset + results.length : null,
  };

  return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
}
