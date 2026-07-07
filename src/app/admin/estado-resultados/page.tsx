import { IncomeStatementReport } from "@/components/admin/accounting-reports";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getIncomeStatementReport } from "@/services/supabase/accounting-reports.service";

export const dynamic = "force-dynamic";

export default async function IncomeStatementPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const profile = await requirePermission("accounting:view_reports");
  const params = await searchParams;
  const data = await getIncomeStatementReport(params);
  const canExport = hasEffectivePermission(profile.role, profile.permissions, "accounting:export", profile.email);

  return <IncomeStatementReport data={data} canExport={canExport} />;
}
