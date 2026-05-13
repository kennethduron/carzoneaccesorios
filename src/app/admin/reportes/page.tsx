import Link from "next/link";
import nextDynamic from "next/dynamic";
import { ArrowLeft } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { FiscalAlertsPanel } from "@/components/admin/fiscal-alerts-panel";
import { requirePermission } from "@/lib/auth/session";
import { getFiscalSettings } from "@/services/supabase/admin-fiscal.service";
import { getAdminReports } from "@/services/supabase/admin-reports.service";
import { getFiscalAlerts } from "@/utils/fiscal";

export const dynamic = "force-dynamic";

const ReportsDashboard = nextDynamic(
  () => import("@/components/admin/reports-dashboard").then((module) => module.ReportsDashboard),
  { loading: () => <div className="rounded-lg border border-black/10 bg-white p-5 text-sm text-black/60">Cargando reportes...</div> },
);

export default async function AdminReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  await requirePermission("reports:read");
  const params = await searchParams;
  const [reports, fiscalSettings] = await Promise.all([
    getAdminReports({ page: Number(params.page ?? 1), pageSize: 50 }),
    getFiscalSettings(),
  ]);
  const fiscalAlerts = getFiscalAlerts(fiscalSettings, reports.invoices);

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
        <p className="font-semibold">Reporte preliminar / paginado</p>
        <p className="mt-1">
          Esta vista calcula indicadores sobre la página actual, hasta {reports.pageSize} registros por módulo. No debe
          usarse como reporte contable final ni como cierre fiscal hasta mover las agregaciones a consultas SQL/RPC por
          rango completo y validarlas con contabilidad.
        </p>
      </section>
      <ReportsDashboard data={reports} fiscalSettings={fiscalSettings} />
    </AdminShell>
  );
}
