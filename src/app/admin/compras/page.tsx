import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { PurchasesManager } from "@/components/admin/purchases-manager";
import { AdminShell } from "@/components/admin/admin-shell";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getAdminPurchases } from "@/services/supabase/purchases.service";
import { getSupplierOptions } from "@/services/supabase/suppliers.service";

export const dynamic = "force-dynamic";

export default async function PurchasesPage() {
  const profile = await requirePermission("admin:access");
  const canRead =
    hasEffectivePermission(profile.role, profile.permissions, "purchases:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "purchases:manage", profile.email);
  const canManage = hasEffectivePermission(profile.role, profile.permissions, "purchases:manage", profile.email);

  if (!canRead) {
    redirect("/sin-permiso");
  }

  const [{ purchases, summary }, suppliers] = await Promise.all([
    getAdminPurchases(),
    getSupplierOptions(true),
  ]);

  return (
    <AdminShell title="Compras">
      <div className="mb-5">
        <Link href="/admin" className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm">
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <PurchasesManager purchases={purchases} suppliers={suppliers} summary={summary} canManage={canManage} />
    </AdminShell>
  );
}
