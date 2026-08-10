"use client";

import { useEffect, useId, useRef } from "react";
import { AlertTriangle, LoaderCircle, X } from "lucide-react";
import { formatCurrency } from "@/utils/pricing";

type Props = {
  customerName: string;
  saleTotal: number;
  creditLimit: number;
  openBalance: number;
  availableCredit: number;
  overdueBalance: number;
  reason: string;
  pending: boolean;
  error?: string | null;
  onReasonChange: (reason: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
};

export function PosCreditOverdueOverrideDialog(props: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const reasonId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const reasonValid = props.reason.trim().length >= 10 && props.reason.trim().length <= 500;

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    reasonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, []);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !props.pending) {
      event.preventDefault();
      props.onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
    ) ?? [])];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return <div className="fixed inset-0 z-[110] flex items-end justify-center bg-black/60 p-2 sm:items-center sm:p-4">
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
      aria-describedby={descriptionId} onKeyDown={handleKeyDown}
      className="max-h-[calc(100dvh-1rem)] w-full max-w-xl overflow-y-auto overflow-x-hidden rounded-xl bg-white p-4 shadow-2xl sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-800"><AlertTriangle aria-hidden size={21} /></span>
          <div className="min-w-0"><h2 id={titleId} className="text-xl font-semibold">Autorizar venta con saldo vencido</h2><p id={descriptionId} className="mt-1 text-sm leading-6 text-black/60">Esta autorizacion aplica unicamente a esta venta. No modifica el limite ni elimina las cuentas vencidas.</p></div>
        </div>
        <button type="button" disabled={props.pending} onClick={props.onCancel}
          aria-label="Cerrar autorizacion excepcional"
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg border border-black/10 disabled:opacity-50"><X aria-hidden size={18} /></button>
      </div>
      <dl className="mt-5 grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-lg bg-black/[0.035] p-3 text-sm">
        <dt>Cliente</dt><dd className="min-w-0 break-words text-right font-semibold">{props.customerName}</dd>
        <dt>Total de esta venta</dt><dd className="text-right font-semibold">{formatCurrency(props.saleTotal)}</dd>
        <dt>Limite de credito</dt><dd className="text-right font-semibold">{formatCurrency(props.creditLimit)}</dd>
        <dt>Saldo utilizado</dt><dd className="text-right font-semibold">{formatCurrency(props.openBalance)}</dd>
        <dt>Disponible</dt><dd className="text-right font-semibold">{formatCurrency(props.availableCredit)}</dd>
        <dt>Saldo vencido</dt><dd className="text-right font-semibold text-red-700">{formatCurrency(props.overdueBalance)}</dd>
      </dl>
      <label htmlFor={reasonId} className="mt-5 block text-sm font-semibold">Motivo de autorizacion</label>
      <textarea ref={reasonRef} id={reasonId} value={props.reason} maxLength={500} rows={4}
        disabled={props.pending} onChange={(event) => props.onReasonChange(event.target.value)}
        aria-describedby={`${reasonId}-help`}
        className="mt-2 min-h-28 w-full resize-y rounded-lg border border-black/15 px-3 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] disabled:opacity-60" />
      <div id={`${reasonId}-help`} className="mt-1 flex justify-between gap-3 text-xs text-black/55"><span>Escriba entre 10 y 500 caracteres.</span><span>{props.reason.length}/500</span></div>
      <p className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">La proxima venta volvera a requerir validacion y, si corresponde, una nueva autorizacion.</p>
      {props.error ? <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">{props.error}</p> : null}
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="button" disabled={props.pending} onClick={props.onCancel}
          className="min-h-11 rounded-lg border border-black/15 px-4 text-sm font-semibold disabled:opacity-50">Cancelar</button>
        <button type="button" disabled={props.pending || !reasonValid} onClick={props.onConfirm}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#b91c25] px-4 text-sm font-semibold text-white disabled:opacity-50">
          {props.pending ? <LoaderCircle aria-hidden className="animate-spin motion-reduce:animate-none" size={18} /> : null}
          Autorizar y confirmar venta
        </button>
      </div>
    </div>
  </div>;
}
