"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CalendarClock, ExternalLink, LoaderCircle, PackageSearch, X } from "lucide-react";
import type {
  PosInventorySnapshot,
  PosProductReservation,
  PosProductReservationPage,
} from "@/types/point-of-sale";

type Props = {
  productName: string;
  snapshot: PosInventorySnapshot;
  onClose: () => void;
};

function orderStatusLabel(status: string) {
  const labels: Record<string, string> = {
    pending: "Pendiente",
    recibido: "Recibido",
    confirmado: "Confirmado",
    confirmed: "Confirmado",
    preparacion: "En preparación",
    preparing: "En preparación",
    paid: "Pagado",
  };
  return labels[status] ?? "Pedido activo";
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-HN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Tegucigalpa",
  }).format(new Date(value));
}

export function PosProductReservationsDialog({ productName, snapshot, onClose }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [reservations, setReservations] = useState<PosProductReservation[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async (offset: number, signal?: AbortSignal) => {
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/admin/pos/products/${encodeURIComponent(snapshot.productId)}/reservations?limit=20&offset=${offset}`,
        { headers: { Accept: "application/json" }, cache: "no-store", signal },
      );
      const payload = await response.json() as PosProductReservationPage & { message?: string };
      if (!response.ok) throw new Error(payload.message || "No se pudieron consultar las reservas.");
      setReservations((current) => offset === 0 ? payload.results : [...current, ...payload.results]);
      setTotal(payload.total);
      setNextOffset(payload.nextOffset);
    } catch (error) {
      if (!signal?.aborted) {
        setMessage(error instanceof Error ? error.message : "No se pudieron consultar las reservas.");
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [snapshot.productId]);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const controller = new AbortController();
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const loadTimer = window.setTimeout(() => void load(0, controller.signal), 0);
    return () => {
      window.clearTimeout(loadTimer);
      controller.abort();
      document.body.style.overflow = previousOverflow;
      returnFocusRef.current?.focus();
    };
  }, [load]);

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
    ) ?? [])];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return <div
    className="fixed inset-0 z-[100] flex items-end justify-center bg-black/55 p-3 sm:items-center sm:p-4"
    onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
  >
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onKeyDown={handleKeyDown}
      className="max-h-[calc(100dvh-1.5rem)] w-full max-w-xl overflow-y-auto rounded-xl bg-white p-4 shadow-2xl sm:p-5"
      data-testid="pos-product-reservations-dialog"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-800"><PackageSearch aria-hidden="true" size={20} /></span>
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold">Pedidos con unidades reservadas</h2>
            <p id={descriptionId} className="mt-1 break-words text-sm text-black/60">{productName}</p>
          </div>
        </div>
        <button ref={closeRef} type="button" aria-label="Cerrar pedidos relacionados" onClick={onClose} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg border border-black/10"><X aria-hidden="true" size={18} /></button>
      </div>

      {snapshot.tracksInventory ? <dl className="mt-4 grid grid-cols-3 gap-2 rounded-lg bg-slate-50 p-3 text-center text-xs">
        <div><dt className="text-black/55">Existencia física</dt><dd className="mt-1 whitespace-nowrap font-semibold">{snapshot.physicalStock}</dd></div>
        <div><dt className="text-black/55">Reservado</dt><dd className="mt-1 whitespace-nowrap font-semibold text-amber-800">{snapshot.reservedStock}</dd></div>
        <div><dt className="text-black/55">Disponible</dt><dd className="mt-1 whitespace-nowrap font-semibold text-emerald-700">{snapshot.availableStock}</dd></div>
      </dl> : <p className="mt-4 rounded-lg bg-blue-50 p-3 text-sm font-semibold text-blue-800">Sin control de inventario</p>}

      {message ? <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert"><p>{message}</p><button type="button" onClick={() => void load(0)} className="mt-2 min-h-11 font-semibold underline">Reintentar</button></div> : null}
      {!message && !reservations.length && loading ? <div className="mt-5 flex min-h-24 items-center justify-center gap-2 text-sm text-black/60"><LoaderCircle className="animate-spin motion-reduce:animate-none" size={18} /> Consultando pedidos…</div> : null}
      {!message && !loading && !reservations.length ? <p className="mt-4 rounded-lg bg-slate-50 p-4 text-sm text-black/65">Ya no hay reservas activas para este producto. La disponibilidad puede haber cambiado mientras el POS estaba abierto.</p> : null}

      {reservations.length ? <div className="mt-4 space-y-2" aria-label={`${total} pedidos relacionados`}>
        {reservations.map((reservation) => <article key={reservation.reservationId} data-testid="pos-reservation-row" className="rounded-lg border border-black/10 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div><h3 className="font-semibold">Pedido #{reservation.orderNumber}</h3><p className="text-xs text-black/55">{orderStatusLabel(reservation.orderStatus)}</p></div>
            <span className="rounded-full bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">{reservation.reservedQuantity} reservada{reservation.reservedQuantity === 1 ? "" : "s"}</span>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-black/60">
            <span className="inline-flex items-center gap-1"><CalendarClock aria-hidden="true" size={14} /> {reservation.reviewRequired ? "Requiere revisión" : `Vence ${formatDate(reservation.expiresAt)}`}</span>
            <a href={`/admin/pedidos?orderId=${encodeURIComponent(reservation.orderId)}`} className="inline-flex min-h-11 items-center gap-1 font-semibold text-[#b91c25] underline underline-offset-4">Ver pedido <ExternalLink aria-hidden="true" size={14} /></a>
          </div>
        </article>)}
        {nextOffset !== null ? <button type="button" disabled={loading} onClick={() => void load(nextOffset)} className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-black/15 px-4 text-sm font-semibold disabled:opacity-50">{loading ? <LoaderCircle className="animate-spin motion-reduce:animate-none" size={17} /> : null} Cargar más</button> : null}
      </div> : null}
    </div>
  </div>;
}
