import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { getIncomeStatementReport } from "@/services/supabase/accounting-reports.service";
import { buildExcelResponse, incomeStatementExcelRows } from "@/utils/accounting-report-export";
import { formatCurrency } from "@/utils/pricing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  await requirePermission("accounting:export");
  const data = await getIncomeStatementReport(request.nextUrl.searchParams);
  const table = incomeStatementExcelRows(data);
  return buildExcelResponse(
    "car-zone-estado-resultados.xlsx",
    "Resultados",
    "Estado de Resultados",
    `Período: ${data.periodLabel} · ${data.resultLabel}: ${formatCurrency(data.netIncome)}`,
    data.generatedAt,
    table.headers,
    table.rows,
    table.totals,
  );
}
