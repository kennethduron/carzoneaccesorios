import { AdminBackButton } from "@/components/admin/admin-back-button";
import { AdminShell } from "@/components/admin/admin-shell";
import { WholesaleCustomersManager } from "@/components/admin/wholesale-customers-manager";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getAdminCrm } from "@/services/supabase/admin-crm.service";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";

export const dynamic = "force-dynamic";

export default async function AdminWholesaleCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const profile = await requirePermission("wholesale:manage");
  const params = await searchParams;
  const activeStatus = params.status === "pending" ? { id: "pending" as const, label: "Solicitudes mayoristas pendientes" } : null;
  const [data, settings] = await Promise.all([
    getAdminCrm({ pageSize: 100, wholesaleStatus: activeStatus?.id ?? null }),
    getPublicCompanySettings(),
  ]);

  return (
    <AdminShell title="Clientes Mayoristas">
      <AdminBackButton />
      <WholesaleCustomersManager
        customers={data.customers}
        activeFilter={activeStatus}
        canManageWholesale={hasEffectivePermission(profile.role, profile.permissions, "wholesale:manage", profile.email)}
        firstWholesaleMinimum={Number(settings.first_wholesale_minimum ?? 10000)}
      />
    </AdminShell>
  );
}
