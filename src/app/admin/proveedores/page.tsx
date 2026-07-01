import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { SuppliersManager } from "@/components/admin/suppliers-manager";
import { AdminShell } from "@/components/admin/admin-shell";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getAdminSuppliers } from "@/services/supabase/suppliers.service";

export const dynamic = "force-dynamic";

export default async function SuppliersPage() {
  const profile = await requirePermission("admin:access");
  const canRead =
    hasEffectivePermission(profile.role, profile.permissions, "suppliers:read", profile.email) ||
    hasEffectivePermission(profile.role, profile.permissions, "suppliers:manage", profile.email);
  const canManage = hasEffectivePermission(profile.role, profile.permissions, "suppliers:manage", profile.email);

  if (!canRead) {
    redirect("/sin-permiso");
  }

  const data = await getAdminSuppliers();

  return (
    <AdminShell title="Proveedores">
      <div className="mb-5">
        <Link href="/admin" className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm">
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <SuppliersManager suppliers={data.suppliers} summary={data.summary} canManage={canManage} />
    </AdminShell>
  );
}
