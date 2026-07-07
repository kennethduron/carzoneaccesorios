import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { getTrialBalanceReport } from "@/services/supabase/accounting-reports.service";
import { buildExcelResponse, trialBalanceExcelRows } from "@/utils/accounting-report-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  await requirePermission("accounting:export");
  const data = await getTrialBalanceReport(request.nextUrl.searchParams);
  const table = trialBalanceExcelRows(data);
  return buildExcelResponse(
    "car-zone-balance-comprobacion.xlsx",
    "Balance",
    "Balance de Comprobación",
    `Período: ${data.periodLabel} · Validación: ${data.balanced ? "Balance correcto" : "Descuadre contable"}`,
    data.generatedAt,
    table.headers,
    table.rows,
    table.totals,
  );
}