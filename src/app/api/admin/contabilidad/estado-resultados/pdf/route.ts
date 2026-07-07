import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { getIncomeStatementReport } from "@/services/supabase/accounting-reports.service";
import { buildPdfResponse, incomeStatementPdfTable } from "@/utils/accounting-report-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  await requirePermission("accounting:export");
  const data = await getIncomeStatementReport(request.nextUrl.searchParams);
  return buildPdfResponse(incomeStatementPdfTable(data));
}
