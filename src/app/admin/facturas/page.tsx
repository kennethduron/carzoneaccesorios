import Link from "next/link";
import nextDynamic from "next/dynamic";
import { ArrowLeft, Settings } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";
import { getFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import { adminInvoiceTaskLabels, getAdminInvoicesPage, normalizeAdminInvoiceTask } from "@/services/supabase/admin-invoices.service";
import { getFiscalAlerts } from "@/utils/fiscal";

export const dynamic = "force-dynamic";

const AdminInvoicesManager = nextDynamic(
  () => import("@/components/admin/admin-invoices-manager").then((module) => module.AdminInvoicesManager),
  { loading: () => <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">Cargando facturas...</div> },
);

export default async function AdminInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; task?: string }>;
}) {
  const profile = await requirePermission("invoices:read");
  const params = await searchParams;
  const task = normalizeAdminInvoiceTask(params.task);
  const canUseTechnicalExports =
    profile.email?.toLowerCase() === "kennethduron.paz@gmail.com" ||
    profile.role === "technical_owner" ||
    profile.permissions.includes("technical:tools");
  const canCancelInvoices = profile.permissions.includes("invoices:manage");
  const canCorrectInvoices =
    ["technical_owner", "admin", "business_owner", "contadora"].includes(profile.role) ||
    profile.permissions.includes("invoices:correct");
  const [invoicesPage, fiscalSettings] = await Promise.all([
    getAdminInvoicesPage({ page: Number(params.page ?? 1), pageSize: 50, task }),
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
        fiscalAlerts={fiscalAlerts}
        canCancelInvoices={canCancelInvoices}
        canCorrectInvoices={canCorrectInvoices}
        canUseTechnicalExports={canUseTechnicalExports}
        activeTask={task ? { id: task, label: adminInvoiceTaskLabels[task] } : null}
      />
    </AdminShell>
  );
}

