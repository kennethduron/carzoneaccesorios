import Link from "next/link";
import { ArrowLeft, AlertTriangle, BarChart3, Database, FileArchive, HardDrive, Trash2 } from "lucide-react";
import { AdminShell } from "@/components/admin/admin-shell";
import { requireStrictPermission } from "@/lib/auth/session";
import { getAdminUsageOverview } from "@/services/supabase/admin-usage.service";
import { cleanupLogsAction, recordBackupReviewAction } from "./actions";

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

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "Sin registro";
  }

  return new Intl.DateTimeFormat("es-HN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

const healthStyles = {
  verde: "bg-[#edf7ed] text-[#2f6f3e]",
  amarillo: "bg-[#fff9db] text-[#806600]",
  naranja: "bg-[#fff4e5] text-[#9b5b00]",
  rojo: "bg-[#fdecec] text-[#a33a2d]",
};

const severityStyles = {
  info: "bg-[#eef6ff] text-[#1d4f7a]",
  warning: "bg-[#fff9db] text-[#806600]",
  error: "bg-[#fff4e5] text-[#9b5b00]",
  critical: "bg-[#fdecec] text-[#a33a2d]",
};

const statusLabels = {
  open: "Abierto",
  reviewing: "En revisión",
  resolved: "Resuelto",
  ignored: "Ignorado",
};

export default async function AdminUsagePage() {
  await requireStrictPermission("technical:tools");
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

      <section className="mt-5 rounded-lg border border-black/10 bg-white p-5">
        <div className="mb-4 flex items-center gap-2">
          <BarChart3 size={18} />
          <h2 className="font-semibold">Cron y notificaciones</h2>
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-md border border-black/10 bg-[#f4f4f5] p-4">
            <p className="text-sm text-black/55">Secreto de cron</p>
            <p className="mt-1 text-xl font-semibold">{usage.cronSecretConfigured ? "Configurado" : "No configurado"}</p>
            <p className="mt-2 text-xs leading-5 text-black/50">No se muestra el valor real del secreto.</p>
          </div>
          <div className="rounded-md border border-black/10 bg-[#f4f4f5] p-4">
            <p className="text-sm text-black/55">Proveedor email</p>
            <p className="mt-1 text-xl font-semibold">{usage.notificationStatus.provider.toUpperCase()}</p>
            <p className="mt-2 text-xs leading-5 text-black/50">
              Estado: {usage.notificationStatus.configured ? "Configurado" : "No configurado"}
            </p>
          </div>
          <div className="rounded-md border border-black/10 bg-[#f4f4f5] p-4">
            <p className="text-sm text-black/55">Rate limits acumulados</p>
            <p className="mt-1 text-xl font-semibold">{formatNumber(usage.rateLimitRows)}</p>
            <p className="mt-2 text-xs leading-5 text-black/50">Se limpian por cron o por el job de reservas.</p>
          </div>
        </div>
        <div className="mt-4 grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
          <div className="rounded-md border border-black/10 p-4">
            <p className="text-sm font-semibold">Notificaciones ultimas 24h</p>
            <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <p>Enviadas: {formatNumber(usage.notificationStatus.sent24h)}</p>
              <p>Fallidas: {formatNumber(usage.notificationStatus.failed24h)}</p>
              <p>Omitidas: {formatNumber(usage.notificationStatus.skipped24h)}</p>
            </div>
            <p className="mt-3 text-xs text-black/50">
              Resend: {usage.notificationStatus.resendConfigured ? "Configurado" : "No configurado"} / Brevo:{" "}
              {usage.notificationStatus.brevoConfigured ? "Configurado" : "No configurado"}
            </p>
          </div>
          <div className="overflow-x-auto rounded-md border border-black/10 p-4">
            <p className="text-sm font-semibold">Ultimas ejecuciones cron</p>
            <table className="mt-3 w-full min-w-[640px] text-left text-sm">
              <thead className="border-b border-black/10 text-xs uppercase text-black/45">
                <tr>
                  <th className="py-2">Job</th>
                  <th className="py-2">Estado</th>
                  <th className="py-2">Inicio</th>
                  <th className="py-2">Duracion</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {usage.latestCronRuns.length === 0 ? (
                  <tr>
                    <td className="py-3 text-black/50" colSpan={4}>
                      Sin ejecuciones registradas.
                    </td>
                  </tr>
                ) : (
                  usage.latestCronRuns.map((run) => (
                    <tr key={`${run.job_name}-${run.started_at}`}>
                      <td className="py-3 font-medium">{run.job_name}</td>
                      <td className="py-3">{run.status}</td>
                      <td className="py-3">{formatDate(run.started_at)}</td>
                      <td className="py-3">{run.duration_ms ? `${run.duration_ms} ms` : "-"}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="mt-5 rounded-lg border border-black/10 bg-white p-5">
        <div className="mb-4 flex items-center gap-2">
          <AlertTriangle size={18} />
          <h2 className="font-semibold">Errores recientes</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-black/10 text-xs uppercase text-black/45">
              <tr>
                <th className="py-2">Fecha</th>
                <th className="py-2">Módulo / acción</th>
                <th className="py-2">Cliente</th>
                <th className="py-2">Razón</th>
                <th className="py-2">Severidad</th>
                <th className="py-2">Estado</th>
                <th className="py-2">Recomendación</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {usage.recentErrors.length === 0 ? (
                <tr>
                  <td className="py-3 text-black/50" colSpan={7}>
                    Sin errores operativos recientes.
                  </td>
                </tr>
              ) : (
                usage.recentErrors.map((error) => {
                  const severity = error.severity ?? "error";
                  const status = error.status ?? "open";
                  return (
                    <tr key={error.id} className="align-top">
                      <td className="py-3 text-xs text-black/55">{formatDate(error.created_at)}</td>
                      <td className="py-3">
                        <p className="font-medium">{error.module ?? error.category ?? "system"}</p>
                        <p className="mt-1 text-xs text-black/50">{error.action}</p>
                        {error.route ? <p className="mt-1 text-xs text-black/40">{error.route}</p> : null}
                      </td>
                      <td className="py-3">
                        <p>{error.user_email ?? "Anónimo / sistema"}</p>
                        {error.user_id ? <p className="mt-1 text-xs text-black/40">Usuario validado</p> : null}
                      </td>
                      <td className="py-3 text-black/65">
                        {error.admin_reason ?? error.customer_message ?? "Error técnico registrado sin clasificación previa."}
                        {error.error_code || error.http_status ? (
                          <p className="mt-1 text-xs text-black/45">
                            {error.error_code ? `Código: ${error.error_code}` : null}
                            {error.error_code && error.http_status ? " / " : null}
                            {error.http_status ? `HTTP ${error.http_status}` : null}
                          </p>
                        ) : null}
                      </td>
                      <td className="py-3">
                        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${severityStyles[severity]}`}>
                          {severity}
                        </span>
                      </td>
                      <td className="py-3">{statusLabels[status]}</td>
                      <td className="py-3 text-black/65">{error.recommendation ?? "Escalar a soporte técnico si se repite."}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

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
                  <th className="py-2">Más de {usage.retentionDays} días</th>
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
              Elimina registros de error_logs y notification_logs con más de {usage.retentionDays} días.
              Conserva la operación diaria ligera para Supabase Free.
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
            Regla operativa: imágenes y comprobantes viven en Cloudinary o Storage; Supabase guarda URL pública solo para imágenes de producto y metadatos privados para comprobantes.
          </p>
        </section>
      </div>

      <section className="mt-5 rounded-lg border border-black/10 bg-white p-5">
        <div className="mb-4 flex items-center gap-2">
          <Database size={18} />
          <h2 className="font-semibold">Estrategia de respaldo</h2>
        </div>
        <div className="grid gap-4 xl:grid-cols-[0.85fr_1.15fr]">
          <div className="rounded-lg border border-dashed border-black/15 bg-[#fafaf7] p-4">
            <p className="text-sm font-semibold">Tablas criticas</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {usage.criticalTables.map((table) => (
                <span key={table} className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-black/65">
                  {table}
                </span>
              ))}
            </div>
            <p className="mt-4 text-sm leading-6 text-black/55">
              Esta pantalla no ejecuta respaldos. Sirve como control interno para validar que base de datos,
              migraciones, archivos y variables puedan restaurarse sin improvisación.
            </p>
            <div className="mt-4 rounded-md bg-white p-3 text-sm">
              <p className="font-semibold">Última revisión</p>
              <p className="mt-1 text-black/60">{formatDate(usage.latestBackupCheck?.checked_at)}</p>
              <p className="mt-1 text-xs text-black/50">
                Plan registrado: {usage.latestBackupCheck?.plan_name ?? "free_or_unverified"} / Estado:{" "}
                {usage.latestBackupCheck?.status ?? "sin_revision"}
              </p>
            </div>
            <form action={recordBackupReviewAction} className="mt-3">
              <button
                type="submit"
                className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold"
              >
                <FileArchive size={16} />
                Registrar revisión manual
              </button>
            </form>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-black/10 text-xs uppercase text-black/45">
                <tr>
                  <th className="py-2">Area</th>
                  <th className="py-2">Estado</th>
                  <th className="py-2">Frecuencia</th>
                  <th className="py-2">Recomendacion</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {usage.backupChecklist.map((item) => (
                  <tr key={item.area}>
                    <td className="py-3 font-medium">{item.area}</td>
                    <td className="py-3">
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                          item.status === "configured"
                            ? "bg-[#edf7ed] text-[#2f6f3e]"
                            : item.status === "manual"
                              ? "bg-[#fff9db] text-[#806600]"
                              : "bg-[#fdecec] text-[#a33a2d]"
                        }`}
                      >
                        {item.status === "configured" ? "Configurado" : item.status === "manual" ? "Manual" : "Pendiente"}
                      </span>
                    </td>
                    <td className="py-3">{item.cadence}</td>
                    <td className="py-3 text-black/60">{item.recommendation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <section className="mt-5 rounded-lg border border-black/10 bg-white p-5">
        <div className="mb-4 flex items-center gap-2">
          <AlertTriangle size={18} />
          <h2 className="font-semibold">Reservas de inventario</h2>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-md border border-black/10 bg-[#f4f4f5] p-4">
            <p className="text-sm text-black/55">Reservas activas</p>
            <p className="mt-1 text-2xl font-semibold">{formatNumber(usage.reservedOrderCount)}</p>
          </div>
          <div className="rounded-md border border-black/10 bg-[#fff7ed] p-4">
            <p className="text-sm text-[#7c2d12]">Reservas vencidas pendientes de liberar</p>
            <p className="mt-1 text-2xl font-semibold text-[#7c2d12]">{formatNumber(usage.expiredReservationCount)}</p>
            <p className="mt-2 text-xs leading-5 text-[#7c2d12]">
              Endpoint cron: POST /api/cron/release-expired-reservations con Authorization Bearer del secreto configurado.
            </p>
          </div>
        </div>
      </section>

      <section className="mt-5 rounded-lg border border-black/10 bg-white p-5">
        <div className="mb-4 flex items-center gap-2">
          <AlertTriangle size={18} />
          <h2 className="font-semibold">Tablas más pesadas</h2>
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



