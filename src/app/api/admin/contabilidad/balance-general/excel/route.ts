import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { getBalanceSheetReport } from "@/services/supabase/accounting-reports.service";
import { balanceSheetExcelRows, buildExcelResponse } from "@/utils/accounting-report-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  await requirePermission("accounting:export");
  const data = await getBalanceSheetReport(request.nextUrl.searchParams);
  const table = balanceSheetExcelRows(data);
  return buildExcelResponse(
    "car-zone-balance-general.xlsx",
    "Balance General",
    "Balance General",
    `Período: ${data.periodLabel} · Validación: ${data.balanced ? "Balance correcto" : "Descuadre contable"}`,
    data.generatedAt,
    table.headers,
    table.rows,
    table.totals,
  );
}
