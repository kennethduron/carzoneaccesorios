import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { getChartOfAccountsExportData, logAccountingCatalogEvent } from "@/services/supabase/accounting-catalog.service";
import { buildChartOfAccountsPdfResponse } from "@/utils/accounting-catalog-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const profile = await requirePermission("accounting:export");
  const data = await getChartOfAccountsExportData();
  await writeAuditLog({
    tableName: "accounting_accounts",
    action: "accounting.chart_export.generated",
    newData: { format: "pdf", rows: data.rows.length },
  });
  await logAccountingCatalogEvent({
    eventType: "chart_export.generated",
    metadata: { format: "pdf", rows: data.rows.length },
    createdBy: profile.id,
  });

  return buildChartOfAccountsPdfResponse(data);
}