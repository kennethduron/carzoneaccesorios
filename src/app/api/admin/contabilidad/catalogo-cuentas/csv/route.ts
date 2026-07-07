import { writeAuditLog } from "@/lib/audit";
import { isTechnicalOwner } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getChartOfAccountsExportData, logAccountingCatalogEvent } from "@/services/supabase/accounting-catalog.service";
import { buildChartOfAccountsCsvResponse } from "@/utils/accounting-catalog-export";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const profile = await requirePermission("accounting:export");

  if (!isTechnicalOwner(profile.role, profile.email)) {
    return new Response("Exportación CSV disponible solo para technical_owner.", { status: 403 });
  }

  const data = await getChartOfAccountsExportData();
  await writeAuditLog({
    tableName: "accounting_accounts",
    action: "accounting.chart_export.generated",
    newData: { format: "csv", rows: data.rows.length, technicalOnly: true },
  });
  await logAccountingCatalogEvent({
    eventType: "chart_export.generated",
    metadata: { format: "csv", rows: data.rows.length, technicalOnly: true },
    createdBy: profile.id,
  });

  return buildChartOfAccountsCsvResponse(data);
}