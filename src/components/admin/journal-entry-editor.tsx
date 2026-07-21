"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { AlertTriangle, ArrowLeft, FileInput, Plus, RefreshCw, Save, Trash2 } from "lucide-react";
import {
  recalculateJournalDraftFromSourceAction,
  updateJournalDraftAction,
} from "@/app/admin/contabilidad/actions";
import { Button, Input } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import type { JournalEntryEditData, JournalEntryLineInput } from "@/types/accounting";
import { formatHnDateTime } from "@/utils/format";

type EditableLine = Omit<JournalEntryLineInput, "debit" | "credit"> & {
  client_id: string;
  debit: string;
  credit: string;
};

function newClientId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `line-${Date.now()}-${Math.random()}`;
}

function emptyLine(): EditableLine {
  return {
    client_id: newClientId(),
    account_id: "",
    debit: "0",
    credit: "0",
    description: "",
    customer_id: null,
    vendor_id: null,
    product_id: null,
  };
}

function initialLines(data: JournalEntryEditData): EditableLine[] {
  return data.entry.lines.map((line) => ({
    id: line.id,
    client_id: line.id,
    account_id: line.account_id,
    debit: String(line.debit),
    credit: String(line.credit),
    description: line.description ?? "",
    customer_id: line.customer_id,
    vendor_id: line.vendor_id,
    product_id: line.product_id,
  }));
}

function money(value: number) {
  return new Intl.NumberFormat("es-HN", { style: "currency", currency: "HNL" }).format(value);
}

function numberValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
}

function optionalId(value: string | null | undefined) {
  const cleaned = value?.trim();
  return cleaned ? cleaned : null;
}

function sourceLabel(sourceType: string | null) {
  if (sourceType === "financial_event") return "Evento financiero automático";
  if (sourceType === "manual" || !sourceType) return "Partida manual";
  return sourceType;
}

export function JournalEntryEditor({ data }: { data: JournalEntryEditData }) {
  const router = useRouter();
  const toast = useToast();
  const [isPending, startTransition] = useTransition();
  const [entryDate, setEntryDate] = useState(data.entry.entry_date);
  const [description, setDescription] = useState(data.entry.description);
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState<EditableLine[]>(() => initialLines(data));
  const [version, setVersion] = useState(data.entry.version);
  const [message, setMessage] = useState("");
  const isDraft = data.entry.status === "borrador";
  const isAutomatic = data.entry.source_type === "financial_event";

  const totals = useMemo(() => {
    const debit = Math.round(lines.reduce((sum, line) => sum + numberValue(line.debit), 0) * 100) / 100;
    const credit = Math.round(lines.reduce((sum, line) => sum + numberValue(line.credit), 0) * 100) / 100;
    const difference = Math.round((debit - credit) * 100) / 100;
    return { debit, credit, difference, balanced: debit > 0 && difference === 0 };
  }, [lines]);

  const validationMessage = useMemo(() => {
    if (!isDraft) return "Las partidas publicadas, reversadas o anuladas son inmutables.";
    if (!entryDate || description.trim().length < 3) return "Completa la fecha y una descripción válida.";
    if (reason.trim().length < 10) return "Escribe un motivo de cambio de al menos 10 caracteres.";
    if (lines.length < 2) return "La partida debe contener al menos dos líneas.";
    for (const line of lines) {
      const debit = numberValue(line.debit);
      const credit = numberValue(line.credit);
      if (!line.account_id) return "Todas las líneas deben tener una cuenta contable.";
      if (debit < 0 || credit < 0 || (debit > 0) === (credit > 0)) {
        return "Cada línea debe tener un monto positivo solo en débito o solo en crédito.";
      }
    }
    if (!totals.balanced) return "La partida no está cuadrada. El débito debe ser igual al crédito.";
    return "";
  }, [description, entryDate, isDraft, lines, reason, totals.balanced]);

  function updateLine(clientId: string, field: keyof EditableLine, value: string) {
    setLines((current) => current.map((line) => {
      if (line.client_id !== clientId) return line;
      const next = { ...line, [field]: value };
      if (field === "debit" && numberValue(value) > 0) next.credit = "0";
      if (field === "credit" && numberValue(value) > 0) next.debit = "0";
      return next;
    }));
  }

  function serializeLines(): JournalEntryLineInput[] {
    return lines.map((line) => ({
      id: line.id,
      account_id: line.account_id,
      debit: numberValue(line.debit),
      credit: numberValue(line.credit),
      description: optionalId(line.description),
      customer_id: optionalId(line.customer_id),
      vendor_id: optionalId(line.vendor_id),
      product_id: optionalId(line.product_id),
    }));
  }

  function save() {
    if (validationMessage) return;
    startTransition(async () => {
      const result = await updateJournalDraftAction({
        id: data.entry.id,
        expected_version: version,
        entry_date: entryDate,
        description,
        edit_reason: reason,
        lines: serializeLines(),
      });
      setMessage(result.message);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      if (result.version) setVersion(result.version);
      setReason("");
      toast.success(result.message);
      router.refresh();
    });
  }

  function recalculate() {
    if (!isDraft || !isAutomatic || reason.trim().length < 10) return;
    if (!window.confirm("Se reemplazarán las líneas del borrador con los importes vigentes del documento origen. ¿Deseas continuar?")) return;
    startTransition(async () => {
      const result = await recalculateJournalDraftFromSourceAction(data.entry.id, version, reason);
      setMessage(result.message);
      if (!result.ok) {
        toast.error(result.message);
        return;
      }
      if (result.version) setVersion(result.version);
      setReason("");
      toast.success(result.message);
      router.refresh();
    });
  }

  const source = data.sourceContext;
  const sourceDocumentHref = source?.accounts_payable
    ? "/admin/cuentas-por-pagar"
    : source?.purchase
      ? "/admin/compras"
      : null;

  return (
    <main className="min-h-screen bg-[#f7f7f8] px-4 py-5 text-[#080808] sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1400px] space-y-5">
        <header className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm sm:p-6">
          <Link href="/admin/contabilidad?journal_page=1" className="inline-flex items-center gap-2 text-sm font-semibold text-black/60 hover:text-[#b91c25]">
            <ArrowLeft size={16} /> Volver al libro diario
          </Link>
          <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[#b91c25]">Edición controlada de borrador</p>
              <h1 className="mt-1 text-2xl font-semibold sm:text-3xl">Editar partida contable</h1>
              <p className="mt-2 font-semibold">{data.entry.entry_number}</p>
              <p className="mt-1 text-sm text-black/55">Creada por {data.creatorName} · {formatHnDateTime(data.entry.created_at)} · Actualizada {formatHnDateTime(data.entry.updated_at)}</p>
            </div>
            <div className="flex flex-wrap gap-2 text-xs font-semibold">
              <span className={`rounded-full px-3 py-1.5 ${isDraft ? "bg-[#fff7ed] text-[#7c2d12]" : "bg-[#f4f4f5] text-black/60"}`}>{isDraft ? "Borrador" : data.entry.status}</span>
              <span className="rounded-full bg-[#eef2ff] px-3 py-1.5 text-[#3730a3]">Versión {version}</span>
            </div>
          </div>
        </header>

        {!isDraft ? (
          <div className="flex gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <AlertTriangle className="mt-0.5 shrink-0" size={19} />
            <div><p className="font-semibold">Esta partida ya no puede editarse.</p><p className="mt-1">Las correcciones posteriores a la publicación deben realizarse mediante reversión y una nueva partida.</p></div>
          </div>
        ) : null}

        <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <div className="rounded-2xl border border-black/10 bg-white p-4 shadow-sm sm:p-5">
              <h2 className="font-semibold">Encabezado</h2>
              <div className="mt-4 grid gap-4 sm:grid-cols-[210px_minmax(0,1fr)]">
                <label className="text-xs font-semibold uppercase text-black/50">Fecha
                  <Input className="mt-2" type="date" value={entryDate} disabled={!isDraft || isPending} onChange={(event) => setEntryDate(event.target.value)} />
                </label>
                <label className="text-xs font-semibold uppercase text-black/50">Descripción
                  <Input className="mt-2" value={description} maxLength={500} disabled={!isDraft || isPending} onChange={(event) => setDescription(event.target.value)} />
                </label>
              </div>
              <div className="mt-4 grid gap-3 rounded-xl bg-[#f7f7f8] p-4 text-sm sm:grid-cols-3">
                <div><p className="text-xs uppercase text-black/45">Origen bloqueado</p><p className="mt-1 font-semibold">{sourceLabel(data.entry.source_type)}</p></div>
                <div><p className="text-xs uppercase text-black/45">ID de origen</p><p className="mt-1 break-all font-mono text-xs">{data.entry.source_id ?? "Sin ID externo"}</p></div>
                <div><p className="text-xs uppercase text-black/45">Moneda</p><p className="mt-1 font-semibold">{source?.accounts_payable?.currency ?? "HNL"}</p></div>
              </div>
            </div>

            {isAutomatic ? (
              <div className="flex gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-950">
                <FileInput className="mt-0.5 shrink-0" size={19} />
                <div><p className="font-semibold">Partida generada desde un documento origen</p><p className="mt-1">Editar líneas crea una corrección manual auditada; no cambia la cuenta por pagar, la compra ni la factura del proveedor. Usa “Recalcular” para volver a sincronizar el borrador con el origen.</p></div>
              </div>
            ) : null}

            <div className="rounded-2xl border border-black/10 bg-white p-4 shadow-sm sm:p-5">
              <div className="flex items-center justify-between gap-3">
                <div><h2 className="font-semibold">Líneas contables</h2><p className="mt-1 text-sm text-black/50">Una cuenta y un solo lado positivo por línea.</p></div>
                <Button type="button" variant="ghost" disabled={!isDraft || isPending} onClick={() => setLines((current) => [...current, emptyLine()])}><Plus size={16} /> Agregar línea</Button>
              </div>
              <div className="mt-4 space-y-3">
                {lines.map((line, index) => (
                  <article key={line.client_id} className="rounded-xl border border-black/10 p-3 sm:p-4">
                    <div className="grid gap-3 xl:grid-cols-[minmax(240px,1.2fr)_minmax(200px,1fr)_140px_140px_44px]">
                      <label className="text-xs font-semibold uppercase text-black/45">Cuenta
                        <select className="mt-2 h-11 w-full rounded-lg border border-black/15 bg-white px-3 text-sm disabled:opacity-60" value={line.account_id} disabled={!isDraft || isPending} onChange={(event) => updateLine(line.client_id, "account_id", event.target.value)}>
                          <option value="">Seleccionar cuenta</option>
                          {data.activeAccounts.map((account) => <option key={account.id} value={account.id}>{account.code} - {account.name}</option>)}
                        </select>
                      </label>
                      <label className="text-xs font-semibold uppercase text-black/45">Descripción
                        <Input className="mt-2" value={line.description ?? ""} maxLength={500} disabled={!isDraft || isPending} onChange={(event) => updateLine(line.client_id, "description", event.target.value)} />
                      </label>
                      <label className="text-xs font-semibold uppercase text-black/45">Débito
                        <Input className="mt-2 text-right" type="number" min="0" step="0.01" value={line.debit} disabled={!isDraft || isPending} onChange={(event) => updateLine(line.client_id, "debit", event.target.value)} />
                      </label>
                      <label className="text-xs font-semibold uppercase text-black/45">Crédito
                        <Input className="mt-2 text-right" type="number" min="0" step="0.01" value={line.credit} disabled={!isDraft || isPending} onChange={(event) => updateLine(line.client_id, "credit", event.target.value)} />
                      </label>
                      <Button aria-label={`Eliminar línea ${index + 1}`} className="mt-6 px-3" type="button" variant="ghost" disabled={!isDraft || isPending || lines.length <= 2} onClick={() => setLines((current) => current.filter((item) => item.client_id !== line.client_id))}><Trash2 size={16} /></Button>
                    </div>
                    <details className="mt-3 text-sm text-black/55">
                      <summary className="cursor-pointer font-medium">Dimensiones opcionales de trazabilidad</summary>
                      <div className="mt-3 grid gap-3 md:grid-cols-3">
                        {(["vendor_id", "customer_id", "product_id"] as const).map((field) => (
                          <label key={field} className="text-xs font-semibold uppercase text-black/45">{field === "vendor_id" ? "Proveedor ID" : field === "customer_id" ? "Cliente ID" : "Producto ID"}
                            <Input className="mt-2 font-mono text-xs" value={line[field] ?? ""} disabled={!isDraft || isPending} onChange={(event) => updateLine(line.client_id, field, event.target.value)} />
                          </label>
                        ))}
                      </div>
                    </details>
                  </article>
                ))}
              </div>
            </div>
          </div>

          <aside className="space-y-4 lg:sticky lg:top-5 lg:self-start">
            <div className="rounded-2xl border border-black/10 bg-white p-4 shadow-sm sm:p-5">
              <h2 className="font-semibold">Totales</h2>
              <dl className="mt-4 space-y-3 text-sm">
                <div className="flex justify-between gap-3"><dt className="text-black/55">Débito</dt><dd className="font-semibold">{money(totals.debit)}</dd></div>
                <div className="flex justify-between gap-3"><dt className="text-black/55">Crédito</dt><dd className="font-semibold">{money(totals.credit)}</dd></div>
                <div className={`flex justify-between gap-3 border-t pt-3 ${totals.balanced ? "text-emerald-700" : "text-red-700"}`}><dt>Diferencia</dt><dd className="font-semibold">{money(Math.abs(totals.difference))}</dd></div>
              </dl>
              <p className={`mt-3 rounded-lg p-3 text-sm font-medium ${totals.balanced ? "bg-emerald-50 text-emerald-800" : "bg-red-50 text-red-800"}`}>{totals.balanced ? "La partida está balanceada." : `Existe una diferencia de ${money(Math.abs(totals.difference))}.`}</p>
            </div>

            {source ? (
              <div className="rounded-2xl border border-black/10 bg-white p-4 shadow-sm sm:p-5">
                <h2 className="font-semibold">Documento origen</h2>
                <dl className="mt-4 space-y-3 text-sm">
                  {source.accounts_payable ? <><div><dt className="text-black/45">Cuenta por pagar</dt><dd className="break-all font-mono text-xs">{source.accounts_payable.id}</dd></div><div className="flex justify-between"><dt>Total</dt><dd className="font-semibold">{money(source.accounts_payable.total_amount)}</dd></div></> : null}
                  {source.purchase ? <><div className="flex justify-between"><dt>Compra</dt><dd className="font-semibold">{source.purchase.purchase_number}</dd></div><div className="flex justify-between"><dt>Subtotal</dt><dd>{money(source.purchase.subtotal)}</dd></div><div className="flex justify-between"><dt>Impuesto</dt><dd>{money(source.purchase.tax_amount)}</dd></div></> : null}
                  {source.supplier_invoice ? <><div className="flex justify-between"><dt>Factura proveedor</dt><dd className="font-semibold">{source.supplier_invoice.invoice_number}</dd></div><div className="flex justify-between"><dt>Impuesto factura</dt><dd>{money(source.supplier_invoice.tax_amount)}</dd></div></> : null}
                </dl>
                {sourceDocumentHref ? <Link href={sourceDocumentHref} className="mt-4 inline-flex text-sm font-semibold text-[#b91c25] hover:underline">Ver módulo del documento origen</Link> : null}
              </div>
            ) : null}

            <div className="rounded-2xl border border-black/10 bg-white p-4 shadow-sm sm:p-5">
              <label className="text-xs font-semibold uppercase text-black/50">Motivo obligatorio
                <textarea className="mt-2 min-h-24 w-full rounded-lg border border-black/15 bg-white p-3 text-sm disabled:opacity-60" value={reason} maxLength={1000} disabled={!isDraft || isPending} placeholder="Explica qué se corrige y por qué" onChange={(event) => setReason(event.target.value)} />
              </label>
              {validationMessage ? <p className="mt-3 text-sm text-red-700">{validationMessage}</p> : null}
              {message ? <p className="mt-3 rounded-lg bg-[#f7f7f8] p-3 text-sm">{message}</p> : null}
              <div className="mt-4 grid gap-2">
                <Button type="button" variant="dark" disabled={Boolean(validationMessage) || isPending} onClick={save}><Save size={16} /> {isPending ? "Guardando…" : "Guardar cambios"}</Button>
                {isAutomatic ? <Button type="button" variant="ghost" disabled={!isDraft || isPending || reason.trim().length < 10} onClick={recalculate}><RefreshCw size={16} /> Recalcular desde origen</Button> : null}
                <Link href="/admin/contabilidad?journal_page=1" className="rounded-lg px-4 py-2 text-center text-sm font-semibold text-black/60 hover:bg-black/5">Cancelar</Link>
              </div>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
