import Link from "next/link";
import nextDynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { CommercialNav } from "@/components/admin/commercial-nav";
import { SellerCustomers } from "@/components/admin/seller-customers";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/auth/session";
import {
  getAdminCrm,
  type AdminCrmCustomerFilter,
} from "@/services/supabase/admin-crm.service";
import { getPublicCompanySettings } from "@/services/supabase/company-settings.service";

export const dynamic = "force-dynamic";

const customerFilters = new Set<AdminCrmCustomerFilter>([
  "clients",
  "internal",
  "all",
  "active",
  "prospects",
  "wholesale",
  "wholesale_requests",
  "suspended",
]);

function customerFilter(value: string | undefined): AdminCrmCustomerFilter {
  return value && customerFilters.has(value as AdminCrmCustomerFilter)
    ? (value as AdminCrmCustomerFilter)
    : "clients";
}

function customerId(value: string | undefined) {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

const CrmManager = nextDynamic(
  () => import("@/components/admin/crm-manager").then((module) => module.CrmManager),
  { loading: () => <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">Cargando clientes...</div> },
);

export default async function AdminCustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; q?: string; filter?: string; customerId?: string }>;
}) {
  const profile = await requireSession();
  if (profile.role === "vendedor") return <AdminShell title="Clientes" variant="wide" eyebrow="Panel de ventas" backHref="/admin"><CommercialNav sellerMode/><SellerCustomers/></AdminShell>;
  if (!hasEffectivePermission(profile.role, profile.permissions, "crm:manage", profile.email)) redirect("/sin-permiso");
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
  const canMergeCustomers =
    ["technical_owner", "business_owner", "admin"].includes(profile.role) &&
    hasEffectivePermission(
      profile.role,
      profile.permissions,
      "customers:merge",
      profile.email,
    );

  const params = await searchParams;
  const initialQuery = String(params.q ?? "").trim().slice(0, 120);
  const initialFilter = customerFilter(params.filter);
  const initialCustomerId = customerId(params.customerId);
  const [crm, settings] = await Promise.all([
    getAdminCrm({
      customerPage: Number(params.page ?? 1),
      followupPage: 1,
      pageSize: 20,
      customerQuery: initialQuery,
      customerFilter: initialFilter,
      viewerRole: profile.role,
    }),
    getPublicCompanySettings(),
  ]);

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
        canEditCustomerIdentity={canEditCustomerIdentity}
        canManageWholesale={canManageWholesale}
        canMergeCustomers={canMergeCustomers}
        firstWholesaleMinimum={Number(settings.first_wholesale_minimum ?? 10000)}
        initialCustomerQuery={initialQuery}
        initialCustomerFilter={initialFilter}
        initialCustomerId={initialCustomerId}
      />
    </AdminShell>
  );
}
