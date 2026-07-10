"use client";

import { CheckCircle2, Database, FileSpreadsheet, RotateCcw, Search, ShieldCheck, Upload } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ImportAssignmentSelector } from "@/components/admin/import-assignment-selector";
import type { AssignmentSelectorOption, ImportFoundationData } from "@/types/import-foundation";
import { importBatchStatusLabels, importModuleLabel } from "@/utils/import-labels";


export function ImportFoundationManager({ data }: { data: ImportFoundationData }) {
  const [selectedOption, setSelectedOption] = useState<AssignmentSelectorOption | null>(null);
  const customerOptions = useMemo<AssignmentSelectorOption[]>(() => [], []);

  return (
    <div className="min-w-0 space-y-4">
      <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-semibold uppercase text-[#b91c25]">Centro de importaciones</p>
            <h2 className="mt-1 text-2xl font-semibold">Historial de importaciones</h2>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-black/55">
              Consulta y administra los archivos importados, los registros pendientes de revision y el historial de aplicaciones.
            </p>
          </div>
        </div>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Metric label="Lotes" value={data.summary.totalBatches} icon={Database} />
        <Metric label="Pendientes" value={data.summary.pendingAssignment} icon={Search} />
        <Metric label="Listos" value={data.summary.ready} icon={CheckCircle2} />
        <Metric label="Aplicados" value={data.summary.applied} icon={Upload} />
        <Metric label="Fallidos" value={data.summary.failed} icon={RotateCcw} />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 rounded-lg border border-black/10 bg-white p-4 shadow-sm">
          <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h3 className="text-base font-semibold">Registros en revision</h3>
              <p className="text-xs text-black/50">Seguimiento de archivos, validaciones y asignaciones antes de aplicar datos.</p>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full bg-[#edf7ed] px-2.5 py-1 text-xs font-semibold text-[#2f6f3e]">
              <ShieldCheck size={14} />
              Controlado
            </span>
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            <Step icon={FileSpreadsheet} title="Validacion de archivos" text="Revision de columnas, filas, duplicados y mensajes antes de continuar." />
            <Step icon={Database} title="Registros listos" text="Resumen de lotes con pendientes, registros validados, aplicados y con errores." />
            <Step icon={Search} title="Asignacion de clientes y proveedores" text="Busqueda y confirmacion manual cuando un registro necesita relacionarse con una cuenta existente." />
          </div>
        </div>

        <ImportAssignmentSelector kind="customer" options={customerOptions} value={selectedOption?.id ?? null} onChange={setSelectedOption} />
      </section>

      <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm">
        <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h3 className="text-base font-semibold">Lotes recientes</h3>
            <p className="text-xs text-black/50">Historial de archivos cargados y avance de cada proceso de importacion.</p>
          </div>
          <Link href="/admin/contabilidad" className="text-xs font-semibold text-[#e4252c] hover:text-[#b91c25]">Ver centro financiero</Link>
        </div>
        <div className="max-w-full overflow-x-auto rounded-md border border-black/10">
          <table className="w-full min-w-[780px] text-left text-sm">
            <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
              <tr>
                <th className="px-3 py-2">Modulo</th>
                <th className="px-3 py-2">Estado</th>
                <th className="px-3 py-2">Filas</th>
                <th className="px-3 py-2">Pendientes</th>
                <th className="px-3 py-2">Validadas</th>
                <th className="px-3 py-2">Aplicadas</th>
                <th className="px-3 py-2">Creado</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-black/10">
              {data.batches.map((batch) => (
                <tr key={batch.id}>
                  <td className="px-3 py-3 font-semibold">{importModuleLabel(batch.module)}</td>
                  <td className="px-3 py-3">{importBatchStatusLabels[batch.status]}</td>
                  <td className="px-3 py-3">{batch.total_rows.toLocaleString("es-HN")}</td>
                  <td className="px-3 py-3">{batch.pending_rows.toLocaleString("es-HN")}</td>
                  <td className="px-3 py-3">{batch.validated_rows.toLocaleString("es-HN")}</td>
                  <td className="px-3 py-3">{batch.applied_rows.toLocaleString("es-HN")}</td>
                  <td className="px-3 py-3">{formatDate(batch.created_at)}</td>
                </tr>
              ))}
              {data.batches.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-black/55">No hay lotes de importacion registrados todavia.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, icon: Icon }: { label: string; value: number; icon: LucideIcon }) {
  return (
    <div className="rounded-lg border border-black/10 bg-white p-3 shadow-sm">
      <div className="flex items-start gap-3">
        <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-md bg-[#fff1f2] text-[#e4252c]">
          <Icon size={17} />
        </span>
        <span>
          <span className="block text-xs font-semibold uppercase text-black/45">{label}</span>
          <span className="mt-1 block text-xl font-semibold">{value.toLocaleString("es-HN")}</span>
        </span>
      </div>
    </div>
  );
}

function Step({ icon: Icon, title, text }: { icon: LucideIcon; title: string; text: string }) {
  return (
    <div className="rounded-md border border-black/10 bg-[#fafafa] p-3">
      <span className="inline-flex size-9 items-center justify-center rounded-md bg-white text-[#e4252c] shadow-sm">
        <Icon size={17} />
      </span>
      <h4 className="mt-3 font-semibold">{title}</h4>
      <p className="mt-1 text-sm leading-6 text-black/55">{text}</p>
    </div>
  );
}

function formatDate(value: string | null) {
  if (!value) return "Sin registro";
  return new Intl.DateTimeFormat("es-HN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
