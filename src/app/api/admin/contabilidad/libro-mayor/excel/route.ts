import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { getGeneralLedgerReport } from "@/services/supabase/accounting-reports.service";
import { buildExcelResponse, ledgerExcelRows } from "@/utils/accounting-report-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  await requirePermission("accounting:export");
  const data = await getGeneralLedgerReport(request.nextUrl.searchParams, { exportMode: true });
  const table = ledgerExcelRows(data);
  const accountLabel = data.account ? `${data.account.code} - ${data.account.name}` : "Sin cuenta";
  return buildExcelResponse(
    "car-zone-libro-mayor.xlsx",
    "Libro Mayor",
    "Libro Mayor",
    `Período: ${data.periodLabel} · Cuenta: ${accountLabel}`,
    data.generatedAt,
    table.headers,
    table.rows,
    table.totals,
  );
}