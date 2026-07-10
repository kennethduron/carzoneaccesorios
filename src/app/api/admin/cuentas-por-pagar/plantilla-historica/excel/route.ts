import { writeAuditLog } from "@/lib/audit";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { accountsPayableImportTemplate } from "@/services/supabase/accounts-payable-import.service";
import { buildImportTemplateResponse } from "@/utils/import-excel";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const profile = await requirePermission("admin:access");
  const allowed =
    hasEffectivePermission(profile.role, profile.permissions, "payables:import", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "payables:review", profile.email);

  if (!allowed) await requirePermission("technical:tools");

  await writeAuditLog({
    tableName: "import_batches",
    action: "historical_payable_import.template_downloaded",
    newData: { format: "xlsx" },
  });

  return buildImportTemplateResponse(accountsPayableImportTemplate, "car-zone-plantilla-cuentas-por-pagar-historicas.xlsx");
}
