"use client";

import { useEffect, useRef, useState } from "react";
import { BadgeDollarSign, CheckCircle2, Clock3, LoaderCircle, X } from "lucide-react";
import type { PosDraftItem } from "@/types/point-of-sale";
import type { PosPriceRequest } from "@/types/sales-commercial";
import { formatCurrency } from "@/utils/pricing";

export function PosPriceRequestDialog({ item, draftId, draftVersion, current, onUpdate, onClose }: {
  item: PosDraftItem; draftId: string; draftVersion: number; current?: PosPriceRequest;
  onUpdate: (request: PosPriceRequest) => void; onClose: () => void;
}) {
  const [price, setPrice] = useState(String(current?.requestedUnitPrice ?? item.baseUnitPrice));
  const [reason, setReason] = useState(current?.reason ?? "");
  const [request, setRequest] = useState(current);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => {
    if (!request || !["pending", "approved"].includes(request.status)) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/admin/pos/price-requests/${request.requestId}`, { headers: { Accept: "application/json" } });
      if (!response.ok) return;
      const refreshed = await response.json() as PosPriceRequest;
      setRequest(refreshed); onUpdate(refreshed);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [onUpdate, request]);

  async function submit() {
    if (pending || !item.itemId) return;
    setPending(true); setMessage("");
    try {
      const response = await fetch("/api/admin/pos/price-requests", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ requestKey: crypto.randomUUID(), draftId, expectedDraftVersion: draftVersion,
          itemId: item.itemId, requestedUnitPrice: Number(price), reason }) });
      const payload = await response.json() as PosPriceRequest & { message?: string };
      if (!response.ok) throw new Error(payload.message ?? "No se pudo enviar la solicitud.");
      setRequest(payload); onUpdate(payload);
    } catch (error) { setMessage(error instanceof Error ? error.message : "No se pudo enviar la solicitud."); }
    finally { setPending(false); }
  }
  const variation = Number(price) > 0 ? ((Number(price) - item.baseUnitPrice) / item.baseUnitPrice) * 100 : 0;
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-3" role="dialog" aria-modal="true" aria-labelledby="price-request-title">
    <section className="max-h-[94dvh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-4 shadow-2xl sm:p-6">
      <header className="flex items-start justify-between gap-3"><div><h2 ref={titleRef} tabIndex={-1} id="price-request-title" className="text-xl font-semibold outline-none">Solicitar precio especial</h2><p className="mt-1 text-sm text-black/55">La autorización solo aplicará a esta venta, producto y cantidad.</p></div><button type="button" aria-label="Cerrar" onClick={onClose} className="grid size-11 place-items-center rounded-lg hover:bg-black/5"><X /></button></header>
      <div className="mt-4 rounded-xl border border-black/10 p-3"><p className="font-semibold">{item.productName}</p><p className="text-sm text-black/55">SKU: {item.sku} · {item.quantity} unidad{item.quantity === 1 ? "" : "es"}</p></div>
      <div className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-slate-50 p-3 text-center text-sm"><div><span className="text-black/50">Actual</span><strong className="block">{formatCurrency(item.baseUnitPrice)}</strong></div><div><span className="text-black/50">Solicitado</span><strong className="block text-red-700">{formatCurrency(Number(price) || 0)}</strong></div><div><span className="text-black/50">Variación</span><strong className="block text-red-700">{variation.toFixed(2)}%</strong></div></div>
      {!request ? <><label className="mt-4 block text-sm font-semibold">Precio solicitado<input autoFocus inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-black/15 px-3" /></label><label className="mt-3 block text-sm font-semibold">Motivo de la solicitud<textarea value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} className="mt-1 min-h-28 w-full rounded-lg border border-black/15 p-3" placeholder="Explique brevemente por qué solicita este precio." /></label><p className="mt-1 text-right text-xs text-black/45">{reason.length}/500</p></> : <div className={`mt-4 rounded-xl border p-4 ${request.status === "approved" ? "border-emerald-300 bg-emerald-50 text-emerald-950" : request.status === "pending" ? "border-amber-300 bg-amber-50 text-amber-950" : "border-red-200 bg-red-50 text-red-900"}`}><div className="flex gap-3">{request.status === "approved" ? <CheckCircle2 /> : <Clock3 />}<div><p className="font-semibold">{request.status === "pending" ? "Solicitud enviada · pendiente de decisión" : request.status === "approved" ? "Precio aprobado" : `Solicitud ${request.status}`}</p><p className="mt-1 text-sm">{request.status === "approved" ? "Válida por 30 minutos y para un solo uso." : request.decisionReason ?? "Te notificaremos cuando exista una respuesta."}</p></div></div></div>}
      {message ? <p role="alert" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-800">{message}</p> : null}
      <footer className="mt-5 grid gap-2 sm:grid-cols-2"><button type="button" onClick={onClose} className="min-h-12 rounded-lg border border-black/15 font-semibold">Volver a la venta</button>{!request ? <button type="button" disabled={pending || !item.itemId || Number(price) <= 0 || reason.trim().length < 5} onClick={() => void submit()} className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-[#e4252c] font-semibold text-white disabled:opacity-45">{pending ? <LoaderCircle className="animate-spin" /> : <BadgeDollarSign />} Enviar solicitud</button> : <a href={`/admin/pos?priceRequest=${request.requestId}`} className="inline-flex min-h-12 items-center justify-center rounded-lg border border-blue-300 font-semibold text-blue-700">Ver estado</a>}</footer>
    </section>
  </div>;
}
