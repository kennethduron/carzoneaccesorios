import type { NextRequest } from "next/server";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getAdminAccountsReceivable } from "@/services/supabase/credit.service";
import type { AdminReceivableFilter, AdminReceivableSort, AdminReceivableSortDirection } from "@/types/credit";
import { buildReceivablesCsv, buildReceivablesWorkbook } from "@/utils/accounts-receivable-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const profile = await requirePermission("admin:access");
  if (!hasEffectivePermission(profile.role, profile.permissions, "receivables:export", profile.email)) {
    return Response.json({ error: "No tienes permiso para exportar cuentas por cobrar." }, { status: 403 });
  }
  const params = request.nextUrl.searchParams;
  const filter = (params.get("status") ?? "pending") as AdminReceivableFilter;
  const sort = (params.get("sort") ?? "created") as AdminReceivableSort;
  const direction = (params.get("direction") ?? "desc") as AdminReceivableSortDirection;
  const format = params.get("format") === "xlsx" ? "xlsx" : "csv";
  const data = await getAdminAccountsReceivable({ filter, query: params.get("q") ?? "", sort, direction, exportAll: true });
  if (data.truncated) {
    return Response.json({ error: "El conjunto supera el límite seguro de exportación. Acota la búsqueda o los filtros." }, { status: 422 });
  }
  const date = new Date().toISOString().slice(0, 10);
  if (format === "xlsx") {
    const buffer = await buildReceivablesWorkbook(data.rows, data.summary, { status: filter, query: data.query, sort, direction });
    return new Response(buffer, { headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="car-zone-cuentas-por-cobrar-${date}.xlsx"`,
      "Cache-Control": "private, no-store",
    }});
  }
  return new Response(buildReceivablesCsv(data.rows), { headers: {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="car-zone-cuentas-por-cobrar-${date}.csv"`,
    "Cache-Control": "private, no-store",
  }});
}
