import type { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth/session";
import { getGeneralLedgerReport } from "@/services/supabase/accounting-reports.service";
import { buildPdfResponse, ledgerPdfTable } from "@/utils/accounting-report-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  await requirePermission("accounting:export");
  const data = await getGeneralLedgerReport(request.nextUrl.searchParams, { exportMode: true });
  return buildPdfResponse(ledgerPdfTable(data));
}