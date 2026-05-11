import Link from "next/link";
import nextDynamic from "next/dynamic";
import { ArrowLeft, Settings } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";
import { getFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import { getAdminInvoicesPage } from "@/services/supabase/admin-invoices.service";
import { getFiscalAlerts } from "@/utils/fiscal";

export const dynamic = "force-dynamic";

const AdminInvoicesManager = nextDynamic(
  () => import("@/components/admin/admin-invoices-manager").then((module) => module.AdminInvoicesManager),
  { loading: () => <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">Cargando facturas...</div> },
);

export default async function AdminInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const profile = await requirePermission("invoices:read");
  const params = await searchParams;
  const canCancelInvoices = profile.role === "admin" || profile.permissions.includes("invoices:manage");
  const canCorrectInvoices =
    profile.role === "admin" || profile.permissions.includes("invoices:create") || profile.permissions.includes("invoices:manage");
  const [invoicesPage, fiscalSettings] = await Promise.all([
    getAdminInvoicesPage({ page: Number(params.page ?? 1), pageSize: 50 }),
    getFiscalSettings(),
  ]);
  const fiscalAlerts = getFiscalAlerts(fiscalSettings, invoicesPage.invoices);

  return (
    <AdminShell title="Facturas">
      <div className="mb-5 flex flex-wrap gap-2">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
        <Link
          href="/admin/configuracion-fiscal"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <Settings size={16} />
          Configuración fiscal
        </Link>
      </div>
      <AdminInvoicesManager
        invoices={invoicesPage.invoices}
        total={invoicesPage.total}
        page={invoicesPage.page}
        pageSize={invoicesPage.pageSize}
        fiscalSettings={fiscalSettings}
        fiscalAlerts={fiscalAlerts}
        canCancelInvoices={canCancelInvoices}
        canCorrectInvoices={canCorrectInvoices}
      />
    </AdminShell>
  );
}
