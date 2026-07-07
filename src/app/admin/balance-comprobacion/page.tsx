import { TrialBalanceReport } from "@/components/admin/accounting-reports";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getTrialBalanceReport } from "@/services/supabase/accounting-reports.service";

export const dynamic = "force-dynamic";

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const profile = await requirePermission("accounting:view_reports");
  const params = await searchParams;
  const data = await getTrialBalanceReport(params);
  const canExport = hasEffectivePermission(profile.role, profile.permissions, "accounting:export", profile.email);

  return <TrialBalanceReport data={data} canExport={canExport} />;
}