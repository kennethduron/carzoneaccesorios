import Link from "next/link";
import nextDynamic from "next/dynamic";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";
import { getAdminCrm } from "@/services/supabase/admin-crm.service";

export const dynamic = "force-dynamic";

const CrmManager = nextDynamic(
  () => import("@/components/admin/crm-manager").then((module) => module.CrmManager),
  { loading: () => <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">Cargando CRM...</div> },
);

export default async function AdminCrmPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await requirePermission("crm:manage");
  const params = await searchParams;
  const crm = await getAdminCrm({ customerPage: 1, followupPage: Number(params.page ?? 1), pageSize: 50 });

  return (
    <AdminShell title="CRM">
      <div className="mb-5">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      <CrmManager data={crm} basePath="/admin/crm" focus="followups" />
    </AdminShell>
  );
}
