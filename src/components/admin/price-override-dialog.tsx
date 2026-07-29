"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { PosDraftItem } from "@/types/pos-drafts";
import { formatCurrency } from "@/utils/pricing";

export function PriceOverrideDialog({ item, returnFocus, onCancel, onApply }: {
  item: PosDraftItem;
  returnFocus: React.RefObject<HTMLElement | null>;
  onCancel: () => void;
  onApply: (price: number, reason: string) => void;
}) {
  const [price, setPrice] = useState(String(item.finalUnitPrice));
  const [reason, setReason] = useState(item.priceOverrideReason ?? "");
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const priceRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { priceRef.current?.focus(); }, []);
  useEffect(() => () => returnFocus.current?.focus(), [returnFocus]);

  function keyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") { event.preventDefault(); onCancel(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])") ?? [])];
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  const numericPrice = Number(price);
  const valid = Number.isFinite(numericPrice) && numericPrice > 0 && reason.trim().length >= 5;
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-3 sm:items-center" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="price-override-title" aria-describedby="price-override-help" onKeyDown={keyDown} className="max-h-[calc(100dvh-1.5rem)] w-full max-w-md overflow-y-auto rounded-xl bg-white p-5 shadow-2xl">
      <div className="flex items-start justify-between gap-3"><div><p className="text-sm font-semibold text-[#e4252c]">Cambio autorizado</p><h2 id="price-override-title" className="text-xl font-semibold">Ajustar precio</h2></div><button type="button" onClick={onCancel} aria-label="Cerrar cambio de precio" className="inline-flex size-11 items-center justify-center rounded-lg border border-black/10"><X size={18} /></button></div>
      <p className="mt-2 font-semibold">{item.productName}</p><p className="text-sm text-black/55">Precio base: {formatCurrency(item.baseUnitPrice)}</p>
      <div className="mt-4 grid gap-4"><label className="grid gap-1.5 text-sm font-semibold">Precio final<input ref={priceRef} type="number" inputMode="decimal" min="0.01" step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} className="min-h-11 rounded-lg border border-black/15 px-3" /></label><label className="grid gap-1.5 text-sm font-semibold">Motivo<input minLength={5} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} aria-describedby="price-override-help" className="min-h-11 rounded-lg border border-black/15 px-3" /></label></div>
      <p id="price-override-help" className="mt-3 text-xs leading-5 text-black/55">El servidor exige un motivo de 5 caracteres, permiso vigente y precio superior al costo. El costo nunca se muestra.</p>
      <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end"><button type="button" onClick={onCancel} className="min-h-11 rounded-lg border border-black/15 px-4 text-sm font-semibold">Cancelar</button><button type="button" disabled={!valid} onClick={() => onApply(numericPrice, reason.trim())} className="min-h-11 rounded-lg bg-[#e4252c] px-4 text-sm font-semibold text-white disabled:opacity-50">Aplicar ajuste</button></div>
    </div>
  </div>;
}
