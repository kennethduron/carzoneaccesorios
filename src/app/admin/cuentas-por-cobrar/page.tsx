import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { AccountsReceivableManager } from "@/components/admin/accounts-receivable-manager";
import { AdminShell } from "@/components/admin/admin-shell";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getAdminAccountsReceivable } from "@/services/supabase/credit.service";

export const dynamic = "force-dynamic";

export default async function AccountsReceivablePage() {
  const profile = await requirePermission("admin:access");
  const canRead =
    hasEffectivePermission(profile.role, profile.permissions, "receivables:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "credit:manage", profile.email);
  const canExport = hasEffectivePermission(profile.role, profile.permissions, "receivables:export", profile.email);
  const canMarkPaid =
    ["technical_owner", "business_owner", "admin"].includes(profile.role) &&
    hasEffectivePermission(profile.role, profile.permissions, "credit:mark_paid", profile.email);

  if (!canRead) {
    redirect("/sin-permiso");
  }

  const data = await getAdminAccountsReceivable();

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
      <AccountsReceivableManager
        rows={data.rows}
        summary={data.summary}
        canMarkPaid={canMarkPaid}
        canExport={canExport}
      />
    </AdminShell>
  );
}
