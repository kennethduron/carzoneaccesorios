import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { AdminOrdersManager } from "@/components/admin/admin-orders-manager";
import { requirePermission } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function AdminOrdersPage() {
  const profile = await requirePermission("admin:access");
  const canManagePayments = profile.role === "admin" || profile.permissions.includes("payments:manage");

  return (
    <AdminShell title="Pedidos">
      <div className="mb-5">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <AdminOrdersManager canManagePayments={canManagePayments} />
    </AdminShell>
  );
}
