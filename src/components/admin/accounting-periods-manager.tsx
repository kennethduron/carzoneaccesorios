"use client";

import { useMemo, useState, useTransition } from "react";
import { CalendarDays, CheckCircle2, Edit3, Save, X } from "lucide-react";
import { saveAccountingPeriodAction } from "@/app/admin/periodos-contables/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { AccountingPeriod, AccountingPeriodInput, AccountingPeriodType } from "@/types/accounting";
import { formatHnDate, formatHnDateTime } from "@/utils/format";

type Props = { periods: AccountingPeriod[]; currentPeriod: AccountingPeriod | null; canManage: boolean };

const statusLabels = { open: "Abierto", closed: "Cerrado", reopened: "Reabierto" } satisfies Record<AccountingPeriod["status"], string>;
const statusClasses = { open: "bg-[#edf7ed] text-[#2f6f3e]", closed: "bg-[#f4f4f5] text-black/55", reopened: "bg-[#eef2ff] text-[#3730a3]" } satisfies Record<AccountingPeriod["status"], string>;
const typeLabels = { monthly: "Mensual", annual: "Anual", custom: "Personalizado" } satisfies Record<AccountingPeriodType, string>;

function yearFrom(date: string) {
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) ? year : new Date().getFullYear();
}

function emptyForm(): AccountingPeriodInput {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa" }).format(new Date());
  return { name: "", period_type: "monthly", start_date: today.slice(0, 8).concat("01"), end_date: today, status: "open", fiscal_year: yearFrom(today), notes: "" };
}

function toInput(period: AccountingPeriod): AccountingPeriodInput {
  return { id: period.id, name: period.name, period_type: period.period_type, start_date: period.start_date, end_date: period.end_date, status: period.status, fiscal_year: period.fiscal_year, notes: period.notes ?? "" };
}

export function AccountingPeriodsManager({ periods, currentPeriod, canManage }: Props) {
  const [form, setForm] = useState<AccountingPeriodInput>(() => emptyForm());
  const [message, setMessage] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();
  const editingPeriod = useMemo(() => periods.find((period) => period.id === form.id) ?? null, [form.id, periods]);
  const canSubmit = canManage && (!editingPeriod || editingPeriod.status === "open");
  const openCount = periods.filter((period) => period.status === "open").length;
  const closedCount = periods.filter((period) => period.status === "closed").length;

  function setField<Key extends keyof AccountingPeriodInput>(key: Key, value: AccountingPeriodInput[Key]) {
    setForm((current) => ({ ...current, [key]: value, fiscal_year: key === "start_date" && typeof value === "string" ? yearFrom(value) : current.fiscal_year }));
  }

  function resetForm() {
    setForm(emptyForm());
    setMessage("");
  }

  function submit() {
    if (!canSubmit) return;
    startTransition(async () => {
      const result = await saveAccountingPeriodAction(form);
      setMessage(result.message);
      if (result.ok) {
        toast.success(result.message);
        resetForm();
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <div className="min-w-0 space-y-5">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Período actual" value={currentPeriod?.name ?? "Sin períodos configurados"} helper={currentPeriod ? `${formatHnDate(currentPeriod.start_date)} a ${formatHnDate(currentPeriod.end_date)}` : "No hay períodos contables configurados."} />
        <Metric label="Períodos configurados" value={periods.length.toLocaleString("es-HN")} helper="Ordenados por fecha inicial" />
        <Metric label="Abiertos" value={openCount.toLocaleString("es-HN")} helper="Disponibles para reportes" />
        <Metric label="Cerrados" value={closedCount.toLocaleString("es-HN")} helper="Solo lectura" />
      </section>

      <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm sm:p-5">
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div><h2 className="text-lg font-semibold">Nuevo período</h2><p className="mt-1 text-sm leading-6 text-black/55">Phase 2I-1 administra períodos abiertos. Cierre, reapertura y bloqueo quedan fuera de esta fase.</p></div>
          {form.id ? <Button type="button" variant="ghost" onClick={resetForm} disabled={isPending}><X size={16} />Cancelar edición</Button> : null}
        </div>
        {!canManage ? <p className="mb-4 rounded-md border border-black/10 bg-[#fafafa] p-3 text-sm text-black/60">Tienes acceso de lectura. No puedes crear ni editar períodos contables.</p> : null}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <Field label="Períodos contables" className="xl:col-span-2"><Input value={form.name} onChange={(event) => setField("name", event.target.value)} placeholder="Ej. Julio 2026" disabled={!canSubmit || isPending} /></Field>
          <Field label="Año fiscal"><Input type="number" min={2000} max={2100} value={form.fiscal_year} onChange={(event) => setField("fiscal_year", Number(event.target.value))} disabled={!canSubmit || isPending} /></Field>
          <Field label="Fecha inicial"><Input type="date" value={form.start_date} onChange={(event) => setField("start_date", event.target.value)} disabled={!canSubmit || isPending} /></Field>
          <Field label="Fecha final"><Input type="date" value={form.end_date} onChange={(event) => setField("end_date", event.target.value)} disabled={!canSubmit || isPending} /></Field>
          <Field label="Estado"><select value="open" disabled className="h-10 w-full rounded-md border border-black/10 bg-[#f4f4f5] px-3 text-sm text-black/60 outline-none"><option value="open">Abierto</option></select></Field>
          <Field label="Tipo"><select value={form.period_type} onChange={(event) => setField("period_type", event.target.value as AccountingPeriodType)} disabled={!canSubmit || isPending} className="h-10 w-full rounded-md border border-black/10 bg-white px-3 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15 disabled:bg-[#f4f4f5]">{Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          <Field label="Notas" className="md:col-span-2 xl:col-span-5"><textarea value={form.notes ?? ""} onChange={(event) => setField("notes", event.target.value)} rows={3} disabled={!canSubmit || isPending} className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15 disabled:bg-[#f4f4f5]" placeholder="Observación interna opcional" /></Field>
          <div className="flex items-end md:col-span-2 xl:col-span-6">{canManage ? <Button type="button" onClick={submit} disabled={!canSubmit || isPending} variant="dark" className="w-full sm:w-auto"><Save size={16} />{isPending ? "Guardando..." : form.id ? "Guardar período" : "Crear período"}</Button> : null}</div>
        </div>
        {message ? <p className="mt-4 rounded-md border border-black/10 bg-[#fafafa] p-3 text-sm text-black/65">{message}</p> : null}
      </section>

      <section className="overflow-hidden rounded-lg border border-black/10 bg-white shadow-sm">
        <div className="flex flex-col gap-2 border-b border-black/10 p-4 sm:p-5 md:flex-row md:items-center md:justify-between">
          <div><div className="flex items-center gap-2"><CalendarDays size={18} /><h2 className="font-semibold">Períodos contables</h2></div><p className="mt-1 text-sm text-black/55">Estado de solo lectura. Cierre y reapertura no están disponibles en esta fase.</p></div>
          {currentPeriod ? <StatusBadge status={currentPeriod.status} /> : null}
        </div>
        {periods.length === 0 ? <div className="p-4 sm:p-5"><div className="rounded-md border border-dashed border-black/15 bg-[#fafafa] p-5 text-center text-sm text-black/60">No hay períodos contables configurados.</div></div> : <PeriodList periods={periods} canManage={canManage} isPending={isPending} onEdit={(period) => setForm(toInput(period))} />}
      </section>
    </div>
  );
}

function PeriodList({ periods, canManage, isPending, onEdit }: { periods: AccountingPeriod[]; canManage: boolean; isPending: boolean; onEdit: (period: AccountingPeriod) => void }) {
  return <><div className="grid gap-3 p-3 md:hidden">{periods.map((period) => <article key={period.id} className="rounded-md border border-black/10 bg-white p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="break-words font-semibold">{period.name}</p><p className="mt-1 text-xs text-black/50">{formatHnDate(period.start_date)} a {formatHnDate(period.end_date)}</p></div><StatusBadge status={period.status} /></div><dl className="mt-3 grid grid-cols-2 gap-2 text-sm"><InfoBox label="Año fiscal" value={String(period.fiscal_year)} /><InfoBox label="Tipo" value={typeLabels[period.period_type]} /><InfoBox label="Actualizado" value={formatHnDateTime(period.updated_at)} wide /></dl>{canManage && period.status === "open" ? <Button type="button" variant="ghost" onClick={() => onEdit(period)} disabled={isPending} className="mt-3 w-full"><Edit3 size={16} />Editar</Button> : null}</article>)}</div><div className="hidden max-w-full overflow-x-auto md:block"><table className="w-full min-w-[980px] text-left text-sm"><thead className="bg-[#e7e5e4] text-xs uppercase text-black/55"><tr><th className="px-3 py-3">Período</th><th className="px-3 py-3">Año fiscal</th><th className="px-3 py-3">Fecha inicial</th><th className="px-3 py-3">Fecha final</th><th className="px-3 py-3">Estado</th><th className="px-3 py-3">Actualizado</th>{canManage ? <th className="px-3 py-3">Acción</th> : null}</tr></thead><tbody className="divide-y divide-black/10">{periods.map((period) => <tr key={period.id}><td className="px-3 py-3"><p className="font-semibold">{period.name}</p><p className="text-xs text-black/45">{typeLabels[period.period_type]}</p></td><td className="px-3 py-3">{period.fiscal_year}</td><td className="px-3 py-3">{formatHnDate(period.start_date)}</td><td className="px-3 py-3">{formatHnDate(period.end_date)}</td><td className="px-3 py-3"><StatusBadge status={period.status} /></td><td className="px-3 py-3">{formatHnDateTime(period.updated_at)}</td>{canManage ? <td className="px-3 py-3">{period.status === "open" ? <Button type="button" variant="ghost" onClick={() => onEdit(period)} disabled={isPending}><Edit3 size={16} />Editar</Button> : <span className="text-xs text-black/45">Solo lectura</span>}</td> : null}</tr>)}</tbody></table></div></>;
}

function Field({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return <label className={`block ${className}`}><span className="mb-1 block text-xs font-medium uppercase text-black/50">{label}</span>{children}</label>;
}
function Metric({ label, value, helper }: { label: string; value: string; helper: string }) {
  return <article className="rounded-lg border border-black/10 bg-white p-4 shadow-sm"><p className="text-sm text-black/50">{label}</p><p className="mt-1 break-words text-xl font-semibold leading-tight">{value}</p><p className="mt-1 text-sm text-black/55">{helper}</p></article>;
}
function StatusBadge({ status }: { status: AccountingPeriod["status"] }) {
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${statusClasses[status]}`}><CheckCircle2 size={14} />{statusLabels[status]}</span>;
}
function InfoBox({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <div className={`rounded-md bg-[#f8fafc] p-2 ${wide ? "col-span-2" : ""}`}><dt className="text-xs uppercase text-black/45">{label}</dt><dd className="mt-1 break-words font-semibold">{value}</dd></div>;
}
