import { hasEffectivePermission } from "@/lib/auth/permissions";
import { getSessionProfile } from "@/lib/auth/session";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AccountingAccountSearchResult, AdminSearchResponse } from "@/types/admin-search";
import type { Permission } from "@/types/auth";

export const dynamic = "force-dynamic";

type AccountSearchRow = {
  id: string;
  code: string;
  name: string;
  account_type: AccountingAccountSearchResult["accountType"];
  normal_balance: AccountingAccountSearchResult["normalBalance"];
  is_active: boolean;
  parent_id: string | null;
  is_selectable: boolean;
  total_count: number | string | null;
};

function boundedInteger(value: string | null, fallback: number, maximum: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.trunc(parsed), 0), maximum) : fallback;
}

export async function GET(request: Request) {
  const profile = await getSessionProfile();
  if (!profile) return Response.json({ message: "Autenticación requerida." }, { status: 401 });

  const allowedPermissions: Permission[] = [
    "accounting:read",
    "accounting:create",
    "accounting:edit_draft_entries",
    "accounting:settings",
    "accounting:manage",
  ];
  const allowed = allowedPermissions.some((permission) =>
    hasEffectivePermission(profile.role, profile.permissions, permission, profile.email),
  );
  if (!allowed) return Response.json({ message: "Acceso denegado." }, { status: 403 });

  const url = new URL(request.url);
  const query = (url.searchParams.get("q") ?? "").trim().replace(/\s+/g, " ").slice(0, 80);
  const limit = Math.max(1, boundedInteger(url.searchParams.get("limit"), 25, 50));
  const offset = boundedInteger(url.searchParams.get("offset"), 0, 10000);
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("search_accounting_accounts_v1", {
    p_query: query,
    p_limit: limit,
    p_offset: offset,
    p_include_inactive: false,
  });

  if (error) {
    const status = error.code === "42501" ? 403 : 500;
    return Response.json({ message: status === 403 ? "Acceso denegado." : "No se pudo buscar cuentas contables." }, { status });
  }

  const rows = (data ?? []) as unknown as AccountSearchRow[];
  const results: AccountingAccountSearchResult[] = rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    accountType: row.account_type,
    normalBalance: row.normal_balance,
    isActive: Boolean(row.is_active),
    parentId: row.parent_id,
    isSelectable: Boolean(row.is_selectable),
  }));
  const total = Number(rows[0]?.total_count ?? 0);
  const payload: AdminSearchResponse<AccountingAccountSearchResult> = {
    results,
    total: Number.isFinite(total) ? total : results.length,
    nextOffset: offset + results.length < total ? offset + results.length : null,
  };

  return Response.json(payload, { headers: { "Cache-Control": "private, no-store" } });
}
