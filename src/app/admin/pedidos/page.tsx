import Link from "next/link";
import nextDynamic from "next/dynamic";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";
import { getAdminOrdersPage } from "@/services/supabase/admin-orders.service";

export const dynamic = "force-dynamic";

const AdminOrdersManager = nextDynamic(
  () => import("@/components/admin/admin-orders-manager").then((module) => module.AdminOrdersManager),
  { loading: () => <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">Cargando pedidos...</div> },
);

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const profile = await requirePermission("admin:access");
  const canReadOrders =
    profile.role === "admin" || profile.permissions.includes("orders:read") || profile.permissions.includes("orders:manage");

  if (!canReadOrders) {
    redirect("/sin-permiso");
  }

  const params = await searchParams;
  const canManagePayments = profile.role === "admin" || profile.permissions.includes("payments:manage");
  const canGenerateInvoices = profile.role === "admin" || profile.permissions.includes("invoices:create");
  const ordersPage = await getAdminOrdersPage({ page: Number(params.page ?? 1), pageSize: 50 });

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
      <AdminOrdersManager
        orders={ordersPage.orders}
        total={ordersPage.total}
        page={ordersPage.page}
        pageSize={ordersPage.pageSize}
        canManagePayments={canManagePayments}
        canGenerateInvoices={canGenerateInvoices}
      />
    </AdminShell>
  );
}
