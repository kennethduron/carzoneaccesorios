import Link from "next/link";
import nextDynamic from "next/dynamic";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { FiscalAlertsPanel } from "@/components/admin/fiscal-alerts-panel";
import { requireSession } from "@/lib/auth/session";
import { getFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import { getAdminReports } from "@/services/supabase/admin-reports.service";
import type { AppRole } from "@/types/auth";
import type { ReportFilters, ReportPaymentMethod } from "@/types/reports";
import { getFiscalAlerts } from "@/utils/fiscal";

export const dynamic = "force-dynamic";

const ReportsDashboard = nextDynamic(
  () => import("@/components/admin/reports-dashboard").then((module) => module.ReportsDashboard),
  { loading: () => <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">Cargando reportes...</div> },
);

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const profile = await requireSession();
  const fullAccessRoles = new Set<AppRole>(["technical_owner", "admin", "business_owner", "contadora"]);
  const accessMode = fullAccessRoles.has(profile.role) && profile.permissions.includes("reports:read") ? "full" : null;
  const canUseTechnicalExports =
    profile.email?.toLowerCase() === "kennethduron.paz@gmail.com" ||
    profile.role === "technical_owner" ||
    profile.permissions.includes("technical:tools");

  if (!accessMode) {
    redirect("/sin-permiso");
  }

  const params = await searchParams;
  const filters: ReportFilters = {
    page: Number(readParam(params.page) ?? 1),
    pageSize: 50,
    startDate: readParam(params.startDate),
    endDate: readParam(params.endDate),
    customer: readParam(params.customer),
    product: readParam(params.product),
    sku: readParam(params.sku),
    invoice: accessMode === "full" ? readParam(params.invoice) : "",
    paymentMethod: readParam(params.paymentMethod) as ReportPaymentMethod | "all" | undefined,
    priceMode: readParam(params.priceMode) as ReportFilters["priceMode"],
    invoiceStatus: accessMode === "full" ? (readParam(params.invoiceStatus) as ReportFilters["invoiceStatus"]) : "all",
    orderStatus: readParam(params.orderStatus) as ReportFilters["orderStatus"],
  };

  const [reports, fiscalSettings] = await Promise.all([
    getAdminReports(filters),
    accessMode === "full" ? getFiscalSettings() : Promise.resolve(null),
  ]);
  const fiscalAlerts = fiscalSettings ? getFiscalAlerts(fiscalSettings, reports.invoices) : [];

  return (
    <AdminShell title="Reportes">
      <div className="mb-5">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>
      {fiscalAlerts.length > 0 ? (
        <div className="mb-5">
          <FiscalAlertsPanel alerts={fiscalAlerts} />
        </div>
      ) : null}
      <section className="mb-5 rounded-lg border border-[#f2b8a0] bg-[#fff7ed] p-4 text-sm text-[#7c2d12]">
        <p className="font-semibold">Reportes paginados con filtros server-side</p>
        <p className="mt-1">
          Esta vista carga hasta {reports.pageSize} registros por tabla y aplica filtros antes de traer datos al panel.
          Para cierres contables grandes, usa filtros por fecha, cliente, factura, producto o metodo de pago y exporta
          cada segmento.
        </p>
      </section>
      <ReportsDashboard
        data={reports}
        fiscalSettings={fiscalSettings}
        accessMode={accessMode}
        canUseTechnicalExports={canUseTechnicalExports}
      />
    </AdminShell>
  );
}

function readParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}
