import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { getBalanceSheetReport } from "@/services/supabase/accounting-reports.service";
import { balanceSheetPdfTable, buildPdfResponse } from "@/utils/accounting-report-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  await requirePermission("accounting:export");
  const data = await getBalanceSheetReport(request.nextUrl.searchParams);
  return buildPdfResponse(balanceSheetPdfTable(data));
}
