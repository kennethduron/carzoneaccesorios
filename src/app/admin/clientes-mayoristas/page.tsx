import { AdminShell } from "@/components/admin/admin-shell";
import { WholesaleCustomersManager } from "@/components/admin/wholesale-customers-manager";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getAdminCrm } from "@/services/supabase/admin-crm.service";

export const dynamic = "force-dynamic";

export default async function AdminWholesaleCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const profile = await requirePermission("wholesale:manage");
  const params = await searchParams;
  const activeStatus = params.status === "pending" ? { id: "pending" as const, label: "Solicitudes mayoristas pendientes" } : null;
  const data = await getAdminCrm({ pageSize: 100, wholesaleStatus: activeStatus?.id ?? null });

  return (
    <AdminShell title="Clientes Mayoristas">
      <WholesaleCustomersManager
        customers={data.customers}
        activeFilter={activeStatus}
        canManageWholesale={hasEffectivePermission(profile.role, profile.permissions, "wholesale:manage", profile.email)}
      />
    </AdminShell>
  );
}
