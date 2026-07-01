import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { AccountsPayableManager } from "@/components/admin/accounts-payable-manager";
import { AdminShell } from "@/components/admin/admin-shell";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getAdminPayables } from "@/services/supabase/payables.service";
import { getPurchaseOptions } from "@/services/supabase/purchases.service";
import { getSupplierOptions } from "@/services/supabase/suppliers.service";

export const dynamic = "force-dynamic";

export default async function AccountsPayablePage() {
  const profile = await requirePermission("admin:access");
  const canRead =
    hasEffectivePermission(profile.role, profile.permissions, "payables:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "payables:manage", profile.email);
  const canManage = hasEffectivePermission(profile.role, profile.permissions, "payables:manage", profile.email);

  if (!canRead) {
    redirect("/sin-permiso");
  }

  const [{ payables, invoices, summary }, suppliers, purchases] = await Promise.all([
    getAdminPayables(),
    getSupplierOptions(true),
    getPurchaseOptions(),
  ]);

  return (
    <AdminShell title="Cuentas por pagar">
      <div className="mb-5">
        <Link href="/admin" className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm">
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <AccountsPayableManager payables={payables} invoices={invoices} suppliers={suppliers} purchases={purchases} summary={summary} canManage={canManage} />
    </AdminShell>
  );
}
