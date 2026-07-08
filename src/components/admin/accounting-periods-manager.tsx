"use client";

import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, CalendarDays, CheckCircle2, Edit3, LockKeyhole, RotateCcw, Save, ShieldCheck, X } from "lucide-react";
import {
  closeAccountingPeriodAction,
  reopenAccountingPeriodAction,
  saveAccountingPeriodAction,
  validateAccountingPeriodCloseAction,
} from "@/app/admin/periodos-contables/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { AccountingPeriod, AccountingPeriodCloseValidation, AccountingPeriodInput, AccountingPeriodType } from "@/types/accounting";
import { formatHnDate, formatHnDateTime } from "@/utils/format";

type Props = {
  periods: AccountingPeriod[];
  currentPeriod: AccountingPeriod | null;
  canManage: boolean;
  canClose: boolean;
  canReopen: boolean;
};

type CloseResult = {
  periodId: string;
  message: string;
  validation?: AccountingPeriodCloseValidation;
};

const statusLabels = { open: "Abierto", closed: "Cerrado", reopened: "Reabierto" } satisfies Record<AccountingPeriod["status"], string>;
const statusClasses = {
  open: "bg-[#edf7ed] text-[#2f6f3e]",
  closed: "bg-[#f4f4f5] text-black/55",
  reopened: "bg-[#eef2ff] text-[#3730a3]",
} satisfies Record<AccountingPeriod["status"], string>;
const typeLabels = { monthly: "Mensual", annual: "Anual", custom: "Personalizado" } satisfies Record<AccountingPeriodType, string>;

function yearFrom(date: string) {
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) ? year : new Date().getFullYear();
}

function emptyForm(): AccountingPeriodInput {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa" }).format(new Date());
  return {
    name: "",
    period_type: "monthly",
    start_date: today.slice(0, 8).concat("01"),
    end_date: today,
    status: "open",
    fiscal_year: yearFrom(today),
    notes: "",
  };
}

function toInput(period: AccountingPeriod): AccountingPeriodInput {
  return {
    id: period.id,
    name: period.name,
    period_type: period.period_type,
    start_date: period.start_date,
    end_date: period.end_date,
    status: period.status,
    fiscal_year: period.fiscal_year,
    notes: period.notes ?? "",
  };
}

function formatAmount(value: number) {
  return value.toLocaleString("es-HN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function isCloseableStatus(status: AccountingPeriod["status"]) {
  return status === "open" || status === "reopened";
}

export function AccountingPeriodsManager({ periods, currentPeriod, canManage, canClose, canReopen }: Props) {
  const [form, setForm] = useState<AccountingPeriodInput>(() => emptyForm());
  const [message, setMessage] = useState("");
  const [closeResult, setCloseResult] = useState<CloseResult | null>(null);
  const [reopenTarget, setReopenTarget] = useState<AccountingPeriod | null>(null);
  const [reopenReason, setReopenReason] = useState("");
  const [isPending, startTransition] = useTransition();
  const toast = useToast();
  const editingPeriod = useMemo(() => periods.find((period) => period.id === form.id) ?? null, [form.id, periods]);
  const canSubmit = canManage && (!editingPeriod || editingPeriod.status === "open");
  const openCount = periods.filter((period) => period.status === "open").length;
  const reopenedCount = periods.filter((period) => period.status === "reopened").length;
  const closedCount = periods.filter((period) => period.status === "closed").length;

  function setField<Key extends keyof AccountingPeriodInput>(key: Key, value: AccountingPeriodInput[Key]) {
    setForm((current) => ({
      ...current,
      [key]: value,
      fiscal_year: key === "start_date" && typeof value === "string" ? yearFrom(value) : current.fiscal_year,
    }));
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

  function validateClose(period: AccountingPeriod) {
    if (!canClose || !isCloseableStatus(period.status)) return;
    startTransition(async () => {
      const result = await validateAccountingPeriodCloseAction(period.id);
      setCloseResult({ periodId: period.id, message: result.message, validation: result.validation });
      if (result.ok) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function closePeriod(period: AccountingPeriod) {
    if (!canClose || !isCloseableStatus(period.status) || closeResult?.periodId !== period.id || !closeResult.validation?.ready) return;
    startTransition(async () => {
      const result = await closeAccountingPeriodAction(period.id);
      setCloseResult({ periodId: period.id, message: result.message, validation: result.validation });
      if (result.ok) {
        toast.success(result.message);
        resetForm();
      } else {
        toast.error(result.message);
      }
    });
  }

  function openReopenDialog(period: AccountingPeriod) {
    if (!canReopen || period.status !== "closed") return;
    setReopenTarget(period);
    setReopenReason("");
  }

  function cancelReopen() {
    setReopenTarget(null);
    setReopenReason("");
  }

  function confirmReopen() {
    if (!reopenTarget || !canReopen || !reopenReason.trim()) return;
    startTransition(async () => {
      const result = await reopenAccountingPeriodAction(reopenTarget.id, reopenReason);
      if (result.ok) {
        toast.success(result.message);
        setCloseResult(null);
        resetForm();
        cancelReopen();
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
        <Metric label="Abiertos y reabiertos" value={(openCount + reopenedCount).toLocaleString("es-HN")} helper={`${openCount} abiertos / ${reopenedCount} reabiertos`} />
        <Metric label="Cerrados" value={closedCount.toLocaleString("es-HN")} helper="Protegidos contra registro contable" />
      </section>

      <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm sm:p-5">
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-lg font-semibold">Nuevo período</h2>
            <p className="mt-1 text-sm leading-6 text-black/55">Crea y administra períodos contables abiertos. El cierre y la reapertura se realizan desde controles autorizados.</p>
          </div>
          {form.id ? (
            <Button type="button" variant="ghost" onClick={resetForm} disabled={isPending}>
              <X size={16} />
              Cancelar edición
            </Button>
          ) : null}
        </div>
        {!canManage ? <p className="mb-4 rounded-md border border-black/10 bg-[#fafafa] p-3 text-sm text-black/60">Tienes acceso de lectura. No puedes crear ni editar períodos contables.</p> : null}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
          <Field label="Período contable" className="xl:col-span-2">
            <Input value={form.name} onChange={(event) => setField("name", event.target.value)} placeholder="Ej. Julio 2026" disabled={!canSubmit || isPending} />
          </Field>
          <Field label="Año fiscal">
            <Input type="number" min={2000} max={2100} value={form.fiscal_year} onChange={(event) => setField("fiscal_year", Number(event.target.value))} disabled={!canSubmit || isPending} />
          </Field>
          <Field label="Fecha inicial">
            <Input type="date" value={form.start_date} onChange={(event) => setField("start_date", event.target.value)} disabled={!canSubmit || isPending} />
          </Field>
          <Field label="Fecha final">
            <Input type="date" value={form.end_date} onChange={(event) => setField("end_date", event.target.value)} disabled={!canSubmit || isPending} />
          </Field>
          <Field label="Estado">
            <select value="open" disabled className="h-10 w-full rounded-md border border-black/10 bg-[#f4f4f5] px-3 text-sm text-black/60 outline-none">
              <option value="open">Abierto</option>
            </select>
          </Field>
          <Field label="Tipo">
            <select value={form.period_type} onChange={(event) => setField("period_type", event.target.value as AccountingPeriodType)} disabled={!canSubmit || isPending} className="h-10 w-full rounded-md border border-black/10 bg-white px-3 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15 disabled:bg-[#f4f4f5]">
              {Object.entries(typeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </Field>
          <Field label="Notas" className="md:col-span-2 xl:col-span-5">
            <textarea value={form.notes ?? ""} onChange={(event) => setField("notes", event.target.value)} rows={3} disabled={!canSubmit || isPending} className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15 disabled:bg-[#f4f4f5]" placeholder="Observación interna opcional" />
          </Field>
          <div className="flex items-end md:col-span-2 xl:col-span-6">
            {canManage ? (
              <Button type="button" onClick={submit} disabled={!canSubmit || isPending} variant="dark" className="w-full sm:w-auto">
                <Save size={16} />
                {isPending ? "Guardando..." : form.id ? "Guardar período" : "Crear período"}
              </Button>
            ) : null}
          </div>
        </div>
        {message ? <p className="mt-4 rounded-md border border-black/10 bg-[#fafafa] p-3 text-sm text-black/65">{message}</p> : null}
      </section>

      <section className="overflow-hidden rounded-lg border border-black/10 bg-white shadow-sm">
        <div className="flex flex-col gap-2 border-b border-black/10 p-4 sm:p-5 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <CalendarDays size={18} />
              <h2 className="font-semibold">Períodos contables</h2>
            </div>
            <p className="mt-1 text-sm text-black/55">Valida cierres, consulta bloqueos, reabre períodos cerrados con autorización y revisa la trazabilidad.</p>
          </div>
          {currentPeriod ? <StatusBadge status={currentPeriod.status} /> : null}
        </div>
        {periods.length === 0 ? (
          <div className="p-4 sm:p-5"><div className="rounded-md border border-dashed border-black/15 bg-[#fafafa] p-5 text-center text-sm text-black/60">No hay períodos contables configurados.</div></div>
        ) : (
          <PeriodList
            periods={periods}
            canManage={canManage}
            canClose={canClose}
            canReopen={canReopen}
            isPending={isPending}
            closeResult={closeResult}
            onEdit={(period) => setForm(toInput(period))}
            onValidate={validateClose}
            onClose={closePeriod}
            onReopen={openReopenDialog}
          />
        )}
      </section>

      {reopenTarget ? (
        <div className="fixed inset-0 z-50 flex items-end bg-black/40 p-3 sm:items-center sm:justify-center" role="dialog" aria-modal="true" aria-labelledby="reopen-period-title">
          <div className="w-full max-w-lg rounded-lg border border-black/10 bg-white p-4 shadow-xl sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p id="reopen-period-title" className="text-lg font-semibold">Reabrir período</p>
                <p className="mt-1 text-sm text-black/55">{reopenTarget.name}</p>
              </div>
              <Button type="button" variant="ghost" onClick={cancelReopen} disabled={isPending} aria-label="Cerrar">
                <X size={16} />
              </Button>
            </div>
            <label className="mt-4 block">
              <span className="mb-1 block text-xs font-medium uppercase text-black/50">Motivo de reapertura</span>
              <textarea value={reopenReason} onChange={(event) => setReopenReason(event.target.value)} rows={4} maxLength={500} disabled={isPending} className="w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15 disabled:bg-[#f4f4f5]" />
            </label>
            <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button type="button" variant="ghost" onClick={cancelReopen} disabled={isPending}>Cancelar</Button>
              <Button type="button" variant="dark" onClick={confirmReopen} disabled={isPending || !reopenReason.trim()}>
                <RotateCcw size={16} />
                Reabrir período
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PeriodList({ periods, canManage, canClose, canReopen, isPending, closeResult, onEdit, onValidate, onClose, onReopen }: {
  periods: AccountingPeriod[];
  canManage: boolean;
  canClose: boolean;
  canReopen: boolean;
  isPending: boolean;
  closeResult: CloseResult | null;
  onEdit: (period: AccountingPeriod) => void;
  onValidate: (period: AccountingPeriod) => void;
  onClose: (period: AccountingPeriod) => void;
  onReopen: (period: AccountingPeriod) => void;
}) {
  return (
    <>
      <div className="grid gap-3 p-3 md:hidden">
        {periods.map((period) => (
          <article key={period.id} className="rounded-md border border-black/10 bg-white p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words font-semibold">{period.name}</p>
                <p className="mt-1 text-xs text-black/50">{formatHnDate(period.start_date)} a {formatHnDate(period.end_date)}</p>
              </div>
              <StatusBadge status={period.status} />
            </div>
            <PeriodMetadata period={period} mobile />
            <PeriodActions period={period} canManage={canManage} canClose={canClose} canReopen={canReopen} isPending={isPending} closeResult={closeResult} onEdit={onEdit} onValidate={onValidate} onClose={onClose} onReopen={onReopen} mobile />
            {closeResult?.periodId === period.id ? <ValidationPanel result={closeResult} /> : null}
          </article>
        ))}
      </div>
      <div className="hidden max-w-full overflow-x-auto md:block">
        <table className="w-full min-w-[1180px] text-left text-sm">
          <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
            <tr>
              <th className="px-3 py-3">Período</th>
              <th className="px-3 py-3">Año fiscal</th>
              <th className="px-3 py-3">Fecha inicial</th>
              <th className="px-3 py-3">Fecha final</th>
              <th className="px-3 py-3">Estado</th>
              <th className="px-3 py-3">Trazabilidad</th>
              <th className="px-3 py-3">Actualizado</th>
              {canManage || canClose || canReopen ? <th className="px-3 py-3">Acción</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-black/10">
            {periods.map((period) => (
              <tr key={period.id}>
                <td className="px-3 py-3"><p className="font-semibold">{period.name}</p><p className="text-xs text-black/45">{typeLabels[period.period_type]}</p></td>
                <td className="px-3 py-3">{period.fiscal_year}</td>
                <td className="px-3 py-3">{formatHnDate(period.start_date)}</td>
                <td className="px-3 py-3">{formatHnDate(period.end_date)}</td>
                <td className="px-3 py-3"><StatusBadge status={period.status} /></td>
                <td className="px-3 py-3"><PeriodTrace period={period} /></td>
                <td className="px-3 py-3">{formatHnDateTime(period.updated_at)}</td>
                {canManage || canClose || canReopen ? (
                  <td className="px-3 py-3">
                    <PeriodActions period={period} canManage={canManage} canClose={canClose} canReopen={canReopen} isPending={isPending} closeResult={closeResult} onEdit={onEdit} onValidate={onValidate} onClose={onClose} onReopen={onReopen} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {closeResult ? <div className="hidden border-t border-black/10 p-4 md:block"><ValidationPanel result={closeResult} /></div> : null}
    </>
  );
}

function PeriodActions({ period, canManage, canClose, canReopen, isPending, closeResult, onEdit, onValidate, onClose, onReopen, mobile = false }: {
  period: AccountingPeriod;
  canManage: boolean;
  canClose: boolean;
  canReopen: boolean;
  isPending: boolean;
  closeResult: CloseResult | null;
  onEdit: (period: AccountingPeriod) => void;
  onValidate: (period: AccountingPeriod) => void;
  onClose: (period: AccountingPeriod) => void;
  onReopen: (period: AccountingPeriod) => void;
  mobile?: boolean;
}) {
  const validationReady = closeResult?.periodId === period.id && closeResult.validation?.ready;
  const closeable = isCloseableStatus(period.status);
  const baseClass = mobile ? "mt-3 grid gap-2 sm:grid-cols-2" : "flex flex-wrap gap-2";

  if (period.status === "closed") {
    return (
      <div className={baseClass}>
        <span className="inline-flex items-center justify-center gap-1 rounded-md border border-black/10 bg-[#fafafa] px-3 py-2 text-xs font-semibold text-black/55"><LockKeyhole size={14} />Solo lectura</span>
        {canReopen ? (
          <Button type="button" variant="ghost" onClick={() => onReopen(period)} disabled={isPending} className={mobile ? "w-full" : ""}>
            <RotateCcw size={16} />
            Reabrir período
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className={baseClass}>
      {canManage && period.status === "open" ? (
        <Button type="button" variant="ghost" onClick={() => onEdit(period)} disabled={isPending} className={mobile ? "w-full" : ""}>
          <Edit3 size={16} />
          Editar
        </Button>
      ) : null}
      {canClose && closeable ? (
        <>
          <Button type="button" variant="ghost" onClick={() => onValidate(period)} disabled={isPending} className={mobile ? "w-full" : ""}>
            <ShieldCheck size={16} />
            Validar cierre
          </Button>
          <Button type="button" variant="dark" onClick={() => onClose(period)} disabled={isPending || !validationReady} className={mobile ? "w-full" : ""}>
            <LockKeyhole size={16} />
            Cerrar período
          </Button>
        </>
      ) : null}
    </div>
  );
}

function PeriodMetadata({ period, mobile = false }: { period: AccountingPeriod; mobile?: boolean }) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
      <InfoBox label="Año fiscal" value={String(period.fiscal_year)} />
      <InfoBox label="Tipo" value={typeLabels[period.period_type]} />
      {period.status === "reopened" ? <InfoBox label="Estado" value="Período reabierto" wide /> : null}
      <InfoBox label="Actualizado" value={formatHnDateTime(period.updated_at)} wide />
      {period.closed_by_name ? <InfoBox label="Cerrado por" value={period.closed_by_name} wide /> : null}
      {period.closed_at ? <InfoBox label="Fecha de cierre" value={formatHnDateTime(period.closed_at)} wide /> : null}
      {period.reopened_by_name ? <InfoBox label="Reabierto por" value={period.reopened_by_name} wide /> : null}
      {period.reopened_at ? <InfoBox label="Fecha de reapertura" value={formatHnDateTime(period.reopened_at)} wide /> : null}
      {period.reopen_reason ? <InfoBox label="Motivo de reapertura" value={period.reopen_reason} wide /> : null}
      {!mobile && period.status === "open" ? <InfoBox label="Actividad" value="Disponible para registro" wide /> : null}
    </dl>
  );
}

function PeriodTrace({ period }: { period: AccountingPeriod }) {
  if (period.status === "open" && !period.closed_at && !period.reopened_at) {
    return <span className="text-xs text-black/45">Disponible para registro</span>;
  }

  return (
    <div className="space-y-1 text-xs text-black/55">
      {period.status === "closed" ? <p className="font-semibold text-black/65">Período cerrado</p> : null}
      {period.status === "reopened" ? <p className="font-semibold text-[#3730a3]">Período reabierto</p> : null}
      {period.closed_by_name ? <p>Cerrado por: {period.closed_by_name}</p> : null}
      {period.closed_at ? <p>Fecha de cierre: {formatHnDateTime(period.closed_at)}</p> : null}
      {period.reopened_by_name ? <p>Reabierto por: {period.reopened_by_name}</p> : null}
      {period.reopened_at ? <p>Fecha de reapertura: {formatHnDateTime(period.reopened_at)}</p> : null}
      {period.reopen_reason ? <p className="max-w-[260px] break-words">Motivo de reapertura: {period.reopen_reason}</p> : null}
    </div>
  );
}

function ValidationPanel({ result }: { result: CloseResult }) {
  const validation = result.validation;
  if (!validation) {
    return <p className="rounded-md border border-black/10 bg-[#fafafa] p-3 text-sm text-black/60">{result.message}</p>;
  }

  return (
    <div className="space-y-3 rounded-md border border-black/10 bg-[#fafafa] p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-black">Resultado de validación</p>
          <p className="mt-1 text-sm text-black/60">{validation.period_name ?? "Período seleccionado"}: {validation.ready ? "El período está listo para cierre." : result.message}</p>
        </div>
        <span className={`inline-flex w-fit items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${validation.ready ? "bg-[#edf7ed] text-[#2f6f3e]" : "bg-[#fff7ed] text-[#9a3412]"}`}>
          {validation.ready ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          {validation.ready ? "Listo" : "Con bloqueos"}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <InfoBox label="Partidas en borrador" value={validation.summary.draft_entries.toLocaleString("es-HN")} />
        <InfoBox label="Descuadres" value={validation.summary.unbalanced_entries.toLocaleString("es-HN")} />
        <InfoBox label="Eventos pendientes" value={validation.summary.pending_financial_events.toLocaleString("es-HN")} />
        <InfoBox label="Balance" value={`${formatAmount(validation.summary.trial_balance_debit)} / ${formatAmount(validation.summary.trial_balance_credit)}`} />
      </div>
      <ValidationList title="Bloqueos encontrados" items={validation.blockers} empty="No hay bloqueos para el cierre." tone="blocker" />
      <ValidationList title="Advertencias" items={validation.warnings} empty="No hay advertencias." tone="warning" />
    </div>
  );
}

function ValidationList({ title, items, empty, tone }: { title: string; items: string[]; empty: string; tone: "blocker" | "warning" }) {
  const color = tone === "blocker" ? "text-[#991b1b]" : "text-[#854d0e]";
  return (
    <div>
      <p className="text-xs font-semibold uppercase text-black/50">{title}</p>
      {items.length > 0 ? (
        <ul className="mt-2 space-y-1 text-sm text-black/65">
          {items.map((item) => <li key={item} className={`break-words ${color}`}>{item}</li>)}
        </ul>
      ) : <p className="mt-2 text-sm text-black/55">{empty}</p>}
    </div>
  );
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
