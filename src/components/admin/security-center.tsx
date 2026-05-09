"use client";

import { useState, useTransition } from "react";
import { DatabaseBackup, FileClock, LockKeyhole, ShieldCheck } from "lucide-react";
import { requestBackupAction } from "@/app/admin/seguridad/actions";
import { Button } from "@/components/ui";
import type { AdminSecurityData, BackupType } from "@/types/security";

type SecurityCenterProps = {
  data: AdminSecurityData;
};

const backupTypeLabels: Record<BackupType, string> = {
  manual: "Manual",
  scheduled: "Programado",
  pre_deploy: "Antes de deploy",
};

function formatDateTime(value: string | null) {
  return value ? new Date(value).toLocaleString("es-HN") : "-";
}

function compactJson(value: Record<string, unknown> | null) {
  if (!value) {
    return "-";
  }

  return JSON.stringify(value).slice(0, 140);
}

export function SecurityCenter({ data }: SecurityCenterProps) {
  const [backupType, setBackupType] = useState<BackupType>("manual");
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();

  const permissionCount = new Set(data.roles.flatMap((role) => role.permissions)).size;
  const latestBackup = data.backupLogs[0];
  const failedBackups = data.backupLogs.filter((backup) => backup.status === "failed").length;

  function requestBackup() {
    startTransition(async () => {
      const result = await requestBackupAction(backupType, notes);
      setMessage(result.message);
      if (result.ok) {
        setNotes("");
      }
    });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 md:grid-cols-4">
        <Metric label="Roles activos" value={data.roles.length.toLocaleString("es-HN")} />
        <Metric label="Permisos" value={permissionCount.toLocaleString("es-HN")} />
        <Metric label="Logs recientes" value={data.auditLogs.length.toLocaleString("es-HN")} />
        <Metric label="Backups fallidos" value={failedBackups.toLocaleString("es-HN")} />
      </div>

      <section className="grid gap-5 xl:grid-cols-[420px_1fr]">
        <div className="rounded-lg border border-black/10 bg-white p-5">
          <div className="mb-4 flex items-center gap-2">
            <DatabaseBackup size={19} />
            <h2 className="font-semibold">Backups</h2>
          </div>
          <div className="grid gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase text-black/50">Tipo</span>
              <select
                value={backupType}
                onChange={(event) => setBackupType(event.target.value as BackupType)}
                className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none"
              >
                {Object.entries(backupTypeLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase text-black/50">Notas</span>
              <textarea
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                className="min-h-24 w-full rounded-md border border-black/10 px-3 py-2 text-sm outline-none"
                placeholder="Motivo del respaldo"
              />
            </label>
            <Button onClick={requestBackup} disabled={isPending} variant="dark">
              <DatabaseBackup size={17} />
              {isPending ? "Registrando..." : "Solicitar backup"}
            </Button>
            {message ? <p className="text-sm text-black/60">{message}</p> : null}
            <div className="rounded-md bg-[#f7f7f2] p-3 text-sm text-black/65">
              <p className="font-medium text-[#1c1d1b]">Ultimo respaldo</p>
              <p>{latestBackup ? `${backupTypeLabels[latestBackup.backup_type]} / ${latestBackup.status}` : "Sin registros"}</p>
              <p>{latestBackup ? formatDateTime(latestBackup.created_at) : "-"}</p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-black/10 bg-white p-5">
          <div className="mb-4 flex items-center gap-2">
            <ShieldCheck size={19} />
            <h2 className="font-semibold">Controles activos</h2>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <ControlItem title="Rutas protegidas" description="/admin y /cuenta pasan por proxy y validacion server-side." />
            <ControlItem title="Permisos por rol" description="Cada pagina admin revalida permisos con requirePermission." />
            <ControlItem title="Validacion de formularios" description="Acciones server-side limpian texto, numeros, fechas e IDs." />
            <ControlItem title="Auditoria" description="Cambios criticos registran usuario, tabla, accion y datos relevantes." />
            <ControlItem title="RLS Supabase" description="Policies limitan lectura y escritura por rol y propietario." />
            <ControlItem title="Control de errores" description="Error boundaries evitan pantallas rotas y permiten reintentar." />
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
        <div className="flex items-center gap-2 border-b border-black/10 p-5">
          <LockKeyhole size={19} />
          <h2 className="font-semibold">Roles y permisos</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-[#f0ede2] text-xs uppercase text-black/55">
              <tr>
                <th className="px-4 py-3">Rol</th>
                <th className="px-4 py-3">Permisos</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {data.roles.map((role) => (
                <tr key={role.role}>
                  <td className="px-4 py-3 font-semibold capitalize">{role.role}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      {role.permissions.map((permission) => (
                        <span key={permission} className="rounded-md bg-[#e8f3f2] px-2 py-1 text-xs">
                          {permission}
                        </span>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid gap-5 xl:grid-cols-2">
        <DataTable
          title="Audit logs"
          icon={<FileClock size={19} />}
          columns={["Fecha", "Usuario", "Tabla", "Accion", "Datos"]}
          rows={data.auditLogs.map((log) => [
            formatDateTime(log.created_at),
            log.user_name ?? log.user_email ?? "Sistema",
            log.table_name,
            log.action,
            compactJson(log.new_data),
          ])}
        />
        <DataTable
          title="Historial de backups"
          icon={<DatabaseBackup size={19} />}
          columns={["Fecha", "Tipo", "Estado", "Solicitado por", "Notas"]}
          rows={data.backupLogs.map((backup) => [
            formatDateTime(backup.created_at),
            backupTypeLabels[backup.backup_type],
            backup.status,
            backup.requested_by_email ?? "Sistema",
            backup.notes ?? "-",
          ])}
        />
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-4">
      <p className="text-sm text-black/50">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
    </div>
  );
}

function ControlItem({ title, description }: { title: string; description: string }) {
  return (
    <article className="rounded-md bg-[#f7f7f2] p-3">
      <p className="font-semibold">{title}</p>
      <p className="mt-1 text-sm text-black/60">{description}</p>
    </article>
  );
}

function DataTable({
  title,
  icon,
  columns,
  rows,
}: {
  title: string;
  icon: React.ReactNode;
  columns: string[];
  rows: string[][];
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-black/10 bg-white">
      <div className="flex items-center gap-2 border-b border-black/10 p-5">
        {icon}
        <h2 className="font-semibold">{title}</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[680px] text-left text-sm">
          <thead className="bg-[#f0ede2] text-xs uppercase text-black/55">
            <tr>
              {columns.map((column) => (
                <th key={column} className="px-4 py-3">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-black/10">
            {rows.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-center text-black/50" colSpan={columns.length}>
                  Sin registros.
                </td>
              </tr>
            ) : (
              rows.map((row, index) => (
                <tr key={`${title}-${index}`}>
                  {row.map((cell, cellIndex) => (
                    <td key={`${title}-${index}-${cellIndex}`} className="px-4 py-3">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
