import Link from "next/link";
import nextDynamic from "next/dynamic";
import { ArrowLeft, Settings } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { requirePermission } from "@/lib/auth/session";
import { writeErrorLog } from "@/lib/error-logging";
import { getFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import { adminInvoiceTaskLabels, getAdminInvoicesPage, normalizeAdminInvoiceTask, type AdminInvoicesPage } from "@/services/supabase/admin-invoices.service";
import { getFiscalAlerts } from "@/utils/fiscal";

export const dynamic = "force-dynamic";

const AdminInvoicesManager = nextDynamic(
  () => import("@/components/admin/admin-invoices-manager").then((module) => module.AdminInvoicesManager),
  { loading: () => <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">Cargando facturas...</div> },
);

async function getSafeAdminInvoicesPage(input: {
  page: number;
  task: ReturnType<typeof normalizeAdminInvoiceTask>;
}): Promise<{ invoicesPage: AdminInvoicesPage; errorMessage: string | null }> {
  try {
    return {
      invoicesPage: await getAdminInvoicesPage({ page: input.page, pageSize: 50, task: input.task }),
      errorMessage: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo consultar facturas.";
    await writeErrorLog({
      route: "/admin/facturas",
      action: "admin.invoices_page_query_failed",
      errorMessage: message,
      metadata: { task: input.task, page: input.page },
    });

    return {
      invoicesPage: {
        invoices: [],
        total: 0,
        page: input.page,
        pageSize: 50,
      },
      errorMessage: "No se pudieron cargar las facturas. Revisa permisos o intenta nuevamente.",
    };
  }
}

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
  const canCorrectInvoices = profile.permissions.includes("invoices:correct");
  const page = Number(params.page ?? 1) || 1;
  const [{ invoicesPage, errorMessage: invoicesErrorMessage }, fiscalSettings] = await Promise.all([
    getSafeAdminInvoicesPage({ page, task }),
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
        errorMessage={invoicesErrorMessage}
        activeTask={task ? { id: task, label: adminInvoiceTaskLabels[task] } : null}
      />
    </AdminShell>
  );
}

