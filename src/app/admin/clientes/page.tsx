import Link from "next/link";
import nextDynamic from "next/dynamic";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getAdminCrm } from "@/services/supabase/admin-crm.service";

export const dynamic = "force-dynamic";

const CrmManager = nextDynamic(
  () => import("@/components/admin/crm-manager").then((module) => module.CrmManager),
  { loading: () => <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">Cargando clientes...</div> },
);

export default async function AdminCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const profile = await requirePermission("crm:manage");
  const canManageCredit =
    ["technical_owner", "business_owner", "admin"].includes(profile.role) &&
    hasEffectivePermission(profile.role, profile.permissions, "credit:mark_paid", profile.email);
  const canLinkPortalAccount = hasEffectivePermission(
    profile.role,
    profile.permissions,
    "customers:link_portal_account",
    profile.email,
  );
  const params = await searchParams;
  const crm = await getAdminCrm({ customerPage: Number(params.page ?? 1), followupPage: 1, pageSize: 20, viewerRole: profile.role });

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
      <CrmManager
        data={crm}
        basePath="/admin/clientes"
        focus="customers"
        canManageCredit={canManageCredit}
        canLinkPortalAccount={canLinkPortalAccount}
      />
    </AdminShell>
  );
}
