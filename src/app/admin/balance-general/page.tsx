import { BalanceSheetReport } from "@/components/admin/accounting-reports";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getBalanceSheetReport } from "@/services/supabase/accounting-reports.service";

export const dynamic = "force-dynamic";

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const profile = await requirePermission("accounting:view_reports");
  const params = await searchParams;
  const data = await getBalanceSheetReport(params);
  const canExport = hasEffectivePermission(profile.role, profile.permissions, "accounting:export", profile.email);

  return <BalanceSheetReport data={data} canExport={canExport} />;
}
