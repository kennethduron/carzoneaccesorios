"use client";

import { useEffect, useId, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";

export function InventoryAdjustmentConfirmDialog({ summary, pending, onCancel, onConfirm }: {
  summary: { date: string; lines: number; increases: number; decreases: number; reference: string; notes: string; total?: number };
  pending: boolean; onCancel: () => void; onConfirm: () => void;
}) {
  const titleId = useId(); const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null); const cancelRef = useRef<HTMLButtonElement>(null); const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previous = document.body.style.overflow; document.body.style.overflow = "hidden"; cancelRef.current?.focus();
    return () => { document.body.style.overflow = previous; returnFocus.current?.focus(); };
  }, []);
  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape" && !pending) { event.preventDefault(); onCancel(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]),[href],[tabindex]:not([tabindex='-1'])") ?? [])];
    const first = focusable[0]; const last = focusable.at(-1); if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/55 p-3 sm:items-center" onMouseDown={(e) => e.target===e.currentTarget && !pending && onCancel()}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} onKeyDown={onKeyDown}
      className="max-h-[calc(100dvh-1.5rem)] w-full max-w-lg overflow-y-auto rounded-xl bg-white p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-4"><div className="flex gap-3"><span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-700"><AlertTriangle aria-hidden size={21}/></span><div>
        <h2 id={titleId} className="text-xl font-semibold">Confirmar ajuste de inventario</h2>
        <p id={descriptionId} className="mt-2 text-sm leading-6 text-black/60">Una vez confirmado, este ajuste no podrá editarse. Cualquier corrección posterior deberá realizarse mediante una reversión.</p>
      </div></div><button type="button" aria-label="Cerrar confirmación" disabled={pending} onClick={onCancel} className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-black/10"><X aria-hidden size={18}/></button></div>
      <dl className="mt-5 grid grid-cols-2 gap-3 rounded-lg bg-[#f8fafc] p-4 text-sm">
        <div><dt className="text-black/50">Bodega</dt><dd className="font-semibold">Principal</dd></div><div><dt className="text-black/50">Fecha</dt><dd className="font-semibold">{summary.date}</dd></div>
        <div><dt className="text-black/50">Productos</dt><dd className="font-semibold">{summary.lines}</dd></div><div><dt className="text-black/50">Unidades</dt><dd className="font-semibold">+{summary.increases} / -{summary.decreases}</dd></div>
        {summary.total !== undefined ? <div><dt className="text-black/50">Valor total</dt><dd className="font-semibold">L {summary.total.toLocaleString("es-HN",{minimumFractionDigits:2})}</dd></div> : null}
        <div className="col-span-2"><dt className="text-black/50">Referencia</dt><dd className="break-words font-semibold">{summary.reference || "Sin referencia"}</dd></div>
        {summary.notes ? <div className="col-span-2"><dt className="text-black/50">Observación</dt><dd className="break-words">{summary.notes}</dd></div> : null}
      </dl>
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button ref={cancelRef} type="button" disabled={pending} onClick={onCancel} className="min-h-11 rounded-lg border border-black/15 px-4 font-semibold">Revisar</button><button type="button" disabled={pending} onClick={onConfirm} className="min-h-11 rounded-lg bg-black px-4 font-semibold text-white disabled:opacity-50">{pending?"Confirmando…":"Confirmar ajuste"}</button></div>
    </div></div>;
}
