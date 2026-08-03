"use client";

import type { PosDeliveryMode } from "@/types/point-of-sale";
import type { PosChargeCapabilities } from "@/types/pos-drafts";

export type PosDeliveryState = { mode: PosDeliveryMode; address: string; notes: string; internalNotes: string };

export function PosDeliveryFields({ value, onChange }: {
  value: PosDeliveryState;
  capabilities: PosChargeCapabilities | null;
  onChange: (value: PosDeliveryState) => void;
}) {
  const reason = "Los cargos adicionales no están disponibles para esta venta.";
  return <section className="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
    <p className="text-sm font-semibold text-[#e4252c]">Entrega y notas</p>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-semibold">Modalidad<select value={value.mode} onChange={(event) => onChange({ ...value, mode: event.target.value as PosDeliveryMode })} className="h-11 rounded-lg border border-black/15 bg-white px-3"><option value="store_immediate">Entrega inmediata en tienda</option><option value="home_delivery">Entrega a domicilio</option><option value="cash_on_delivery">Contra entrega (sin cargo)</option></select></label>
      <label className="grid gap-1 text-sm font-semibold">Dirección<input maxLength={500} value={value.address} onChange={(event) => onChange({ ...value, address: event.target.value })} className="h-11 rounded-lg border border-black/15 px-3" /></label>
      <label className="grid gap-1 text-sm font-semibold">Instrucciones de entrega<textarea maxLength={1000} value={value.notes} onChange={(event) => onChange({ ...value, notes: event.target.value })} className="min-h-20 rounded-lg border border-black/15 p-3" /></label>
      <label className="grid gap-1 text-sm font-semibold">Notas internas no sensibles<textarea maxLength={1000} value={value.internalNotes} onChange={(event) => onChange({ ...value, internalNotes: event.target.value })} className="min-h-20 rounded-lg border border-black/15 p-3" /></label>
    </div>
    <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {["Entrega", "Contra entrega", "Cargo adicional", "Otro cargo"].map((label) => <label key={label} className="grid gap-1 text-xs font-semibold text-black/55">{label}<input disabled value="L 0.00" aria-describedby="pos-charge-disabled-help" className="h-11 rounded-lg border border-black/10 bg-slate-100 px-3 text-black/45" /></label>)}
    </div>
    <p id="pos-charge-disabled-help" className="mt-2 text-xs text-black/50">{reason} No es posible agregar importes mientras esta opción permanezca deshabilitada.</p>
  </section>;
}
