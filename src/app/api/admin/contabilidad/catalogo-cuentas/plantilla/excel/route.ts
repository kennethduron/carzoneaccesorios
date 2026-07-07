import { writeAuditLog } from "@/lib/audit";
import { requirePermission } from "@/lib/auth/session";
import { buildChartOfAccountsTemplateResponse } from "@/utils/accounting-catalog-export";
import { logAccountingCatalogEvent } from "@/services/supabase/accounting-catalog.service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const profile = await requirePermission("accounting:manage");
  await writeAuditLog({
    tableName: "accounting_accounts",
    action: "accounting.chart_template.downloaded",
    newData: { format: "xlsx" },
  });
  await logAccountingCatalogEvent({
    eventType: "chart_template.downloaded",
    metadata: { format: "xlsx" },
    createdBy: profile.id,
  });

  return buildChartOfAccountsTemplateResponse();
}