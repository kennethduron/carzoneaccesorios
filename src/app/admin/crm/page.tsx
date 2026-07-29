import Link from "next/link";
import nextDynamic from "next/dynamic";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { getAdminCrm } from "@/services/supabase/admin-crm.service";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";

export const dynamic = "force-dynamic";

const CrmManager = nextDynamic(
  () => import("@/components/admin/crm-manager").then((module) => module.CrmManager),
  { loading: () => <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">Cargando CRM...</div> },
);

export default async function AdminCrmPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; task?: string }>;
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
  const canEditCustomerIdentity =
    ["technical_owner", "business_owner", "admin"].includes(profile.role) &&
    hasEffectivePermission(profile.role, profile.permissions, "customers:update_identity", profile.email);
  const canManageWholesale =
    ["technical_owner", "business_owner", "admin"].includes(profile.role) &&
    hasEffectivePermission(profile.role, profile.permissions, "wholesale:manage", profile.email);

  const params = await searchParams;
  const activeTask = params.task === "overdue" ? { id: "overdue" as const, label: "Seguimientos vencidos" } : null;
  const [crm, settings] = await Promise.all([
    getAdminCrm({
      customerPage: 1,
      followupPage: Number(params.page ?? 1),
      pageSize: 50,
      followupTask: activeTask?.id ?? null,
      viewerRole: profile.role,
    }),
    getPublicCompanySettings(),
  ]);

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
      <CrmManager
        data={crm}
        basePath="/admin/crm"
        focus="followups"
        activeTask={activeTask}
        canManageCredit={canManageCredit}
        canLinkPortalAccount={canLinkPortalAccount}
        canEditCustomerIdentity={canEditCustomerIdentity}
        canManageWholesale={canManageWholesale}
        firstWholesaleMinimum={Number(settings.first_wholesale_minimum ?? 10000)}
      />
    </AdminShell>
  );
}
