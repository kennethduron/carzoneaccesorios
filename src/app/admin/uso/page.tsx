import Link from "next/link";
import { ArrowLeft, AlertTriangle, BarChart3, Database, FileArchive, HardDrive, Trash2 } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { requireStrictPermission } from "@/lib/auth/session";
import { getAdminUsageOverview } from "@/services/supabase/admin-usage.service";
import { cleanupLogsAction } from "./actions";

export const dynamic = "force-dynamic";

function formatNumber(value: number) {
  return value.toLocaleString("es-HN");
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  if (value >= 1024 * 1024) {
    return `${(value / 1024 / 1024).toFixed(1)} MB`;
  }

  if (value >= 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${value} B`;
}

const healthStyles = {
  verde: "bg-[#edf7ed] text-[#2f6f3e]",
  amarillo: "bg-[#fff9db] text-[#806600]",
  naranja: "bg-[#fff4e5] text-[#9b5b00]",
  rojo: "bg-[#fdecec] text-[#a33a2d]",
};

export default async function AdminUsagePage() {
  await requireStrictPermission("system:monitoring");
  const usage = await getAdminUsageOverview();
  const oldLogTotal = usage.logs
    .filter((log) => log.table !== "audit_logs")
    .reduce((sum, log) => sum + log.olderThan90Days, 0);

  return (
    <AdminShell title="Uso y monitoreo">
      <div className="mb-5">
        <Link
          href="/admin"
          className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
        >
          <ArrowLeft size={16} />
          Panel administrativo
        </Link>
      </div>

      <section className="mb-5 rounded-lg border border-black/10 bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <BarChart3 size={18} />
              <h2 className="font-semibold">Estado técnico de infraestructura</h2>
            </div>
            <p className="text-sm leading-6 text-black/55">{usage.technicalRecommendation}</p>
            <p className="mt-2 text-xs text-black/45">
              Esta sección es privada para el proveedor técnico. No se muestra al dueño ni al equipo operativo.
            </p>
          </div>
          <div className="rounded-lg border border-black/10 p-4 text-right">
            <p className="text-sm text-black/50">Base de datos</p>
            <p className="mt-1 text-3xl font-semibold">{formatBytes(usage.databaseSizeBytes)}</p>
            <span className={`mt-2 inline-flex rounded-full px-3 py-1 text-xs font-semibold ${healthStyles[usage.healthStatus]}`}>
              {usage.healthStatus.toUpperCase()}
            </span>
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {usage.metrics.map((metric) => (
          <section key={metric.key} className="rounded-lg border border-black/10 bg-white p-4">
            <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-md bg-[#fff1f2] text-[#e4252c]">
              <Database size={18} />
            </div>
            <p className="text-sm text-black/55">{metric.label}</p>
            <p className="mt-1 text-2xl font-semibold">{formatNumber(metric.value)}</p>
            <p className="mt-2 text-xs leading-5 text-black/50">{metric.helper}</p>
          </section>
        ))}
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.15fr_0.85fr]">
        <section className="rounded-lg border border-black/10 bg-white p-5">
          <div className="mb-4 flex items-center gap-2">
            <FileArchive size={18} />
            <h2 className="font-semibold">Logs y retencion</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b border-black/10 text-xs uppercase text-black/45">
                <tr>
                  <th className="py-2">Tabla</th>
                  <th className="py-2">Total</th>
                  <th className="py-2">Mas de {usage.retentionDays} dias</th>
                  <th className="py-2">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {usage.logs.map((log) => (
                  <tr key={log.table}>
                    <td className="py-3 font-medium">{log.label}</td>
                    <td className="py-3">{formatNumber(log.total)}</td>
                    <td className="py-3">{formatNumber(log.olderThan90Days)}</td>
                    <td className="py-3">
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                          log.olderThan90Days > 0 ? "bg-[#fff4e5] text-[#9b5b00]" : "bg-[#edf7ed] text-[#2f6f3e]"
                        }`}
                      >
                        {log.olderThan90Days > 0 ? "Listo para limpiar" : "Controlado"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <form action={cleanupLogsAction} className="mt-4 rounded-lg border border-dashed border-black/15 bg-[#fafaf7] p-4">
            <p className="text-sm font-medium">Limpieza segura de logs antiguos</p>
            <p className="mt-1 text-sm text-black/55">
              Elimina registros de error_logs y notification_logs con mas de {usage.retentionDays} dias.
              Conserva la operacion diaria ligera para Supabase Free.
            </p>
            <button
              type="submit"
              disabled={oldLogTotal === 0}
              className="mt-3 inline-flex items-center gap-2 rounded-md bg-[#080808] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:bg-black/25"
            >
              <Trash2 size={16} />
              Limpiar logs antiguos
            </button>
          </form>
        </section>

        <section className="rounded-lg border border-black/10 bg-white p-5">
          <div className="mb-4 flex items-center gap-2">
            <HardDrive size={18} />
            <h2 className="font-semibold">Archivos pesados</h2>
          </div>
          <div className="space-y-3">
            {usage.storageReferences.map((item) => (
              <div key={item.label} className="rounded-md border border-black/10 p-3">
                <p className="text-sm text-black/55">{item.label}</p>
                <p className="mt-1 text-xl font-semibold">{formatNumber(item.value)}</p>
                <p className="mt-1 text-xs leading-5 text-black/50">{item.helper}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 rounded-md bg-[#fff1f2] p-3 text-sm leading-6 text-[#e4252c]">
            Regla operativa: imágenes y comprobantes viven en Cloudinary o Storage; Supabase solo guarda URLs y metadatos.
          </p>
        </section>
      </div>

      <section className="mt-5 rounded-lg border border-black/10 bg-white p-5">
        <div className="mb-4 flex items-center gap-2">
          <AlertTriangle size={18} />
          <h2 className="font-semibold">Tablas mas pesadas</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="border-b border-black/10 text-xs uppercase text-black/45">
              <tr>
                <th className="py-2">Tabla</th>
                <th className="py-2">Filas</th>
                <th className="py-2">Datos</th>
                <th className="py-2">Indices</th>
                <th className="py-2">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {usage.heaviestTables.map((table) => (
                <tr key={table.tableName}>
                  <td className="py-3 font-medium">{table.tableName}</td>
                  <td className="py-3">{formatNumber(table.rowEstimate)}</td>
                  <td className="py-3">{formatBytes(table.tableSizeBytes)}</td>
                  <td className="py-3">{formatBytes(table.indexSizeBytes)}</td>
                  <td className="py-3 font-semibold">{formatBytes(table.totalSizeBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AdminShell>
  );
}



