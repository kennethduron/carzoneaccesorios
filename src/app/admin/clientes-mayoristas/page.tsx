import { AdminShell } from "@/components/admin/admin-shell";
import { WholesaleCustomersManager } from "@/components/admin/wholesale-customers-manager";
import { requirePermission } from "@/lib/auth/session";
import { getAdminCrm } from "@/services/supabase/admin-crm.service";

export const dynamic = "force-dynamic";

export default async function AdminWholesaleCustomersPage() {
  await requirePermission("customers:manage");
  const data = await getAdminCrm({ pageSize: 100 });

  return (
    <AdminShell title="Clientes Mayoristas">
      <WholesaleCustomersManager customers={data.customers} />
    </AdminShell>
  );
}
