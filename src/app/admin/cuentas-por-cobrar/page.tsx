import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { AccountsReceivableImportManager } from "@/components/admin/accounts-receivable-import-manager";
import { AccountsReceivableManager } from "@/components/admin/accounts-receivable-manager";
import { AdminShell } from "@/components/admin/admin-shell";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getHistoricalAccountsReceivableImportData } from "@/services/supabase/accounts-receivable-import.service";
import { getAdminAccountsReceivable } from "@/services/supabase/credit.service";

export const dynamic = "force-dynamic";

export default async function AccountsReceivablePage({ searchParams }: { searchParams?: Promise<{ importBatch?: string }> }) {
  const profile = await requirePermission("admin:access");
  const canRead =
    hasEffectivePermission(profile.role, profile.permissions, "receivables:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "credit:manage", profile.email);
  const canExport = hasEffectivePermission(profile.role, profile.permissions, "receivables:export", profile.email);
  const canImport = hasEffectivePermission(profile.role, profile.permissions, "receivables:import", profile.email);
  const canApply = hasEffectivePermission(profile.role, profile.permissions, "receivables:apply", profile.email);
  const canAssign = hasEffectivePermission(profile.role, profile.permissions, "receivables:assign", profile.email);
  const canRollback =
    ["technical_owner", "business_owner"].includes(profile.role) &&
    hasEffectivePermission(profile.role, profile.permissions, "receivables:rollback", profile.email);
  const canMarkPaid = hasEffectivePermission(profile.role, profile.permissions, "credit:mark_paid", profile.email);

  if (!canRead) {
    redirect("/sin-permiso");
  }

  const resolvedSearchParams = await searchParams;
  const [data, importData] = await Promise.all([
    getAdminAccountsReceivable(),
    getHistoricalAccountsReceivableImportData({
      batchId: resolvedSearchParams?.importBatch ?? null,
      canImport,
      canApply,
      canAssign,
      canRollback,
    }),
  ]);

  return (
    <AdminShell title="Cuentas por cobrar">
      <div className="mb-5">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <div className="mb-5">
        <AccountsReceivableImportManager data={importData} />
      </div>
      <AccountsReceivableManager
        rows={data.rows}
        summary={data.summary}
        canMarkPaid={canMarkPaid}
        canExport={canExport}
      />
    </AdminShell>
  );
}
