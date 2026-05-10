import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { CrmManager } from "@/components/admin/crm-manager";
import { requirePermission } from "@/lib/auth/session";
import { getAdminCrm } from "@/services/supabase/admin-crm.service";

export const dynamic = "force-dynamic";

export default async function AdminCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await requirePermission("crm:manage");
  const params = await searchParams;
  const crm = await getAdminCrm({ customerPage: Number(params.page ?? 1), followupPage: 1, pageSize: 50 });

  return (
    <AdminShell title="Clientes">
      <div className="mb-5">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <CrmManager data={crm} basePath="/admin/clientes" focus="customers" />
    </AdminShell>
  );
}
