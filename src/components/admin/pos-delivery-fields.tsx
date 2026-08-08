'use client';

import type { PosDeliveryMode } from '@/types/point-of-sale';
import type { PosChargeCapabilities } from '@/types/pos-drafts';

export type PosDeliveryState = {
  mode: PosDeliveryMode;
  address: string;
  notes: string;
  internalNotes: string;
  shippingFee: string;
  codFee: string;
  additionalCharge: string;
  otherCharge: string;
};

const chargeDefinitions: Array<{
  key: 'shippingFee' | 'codFee' | 'additionalCharge' | 'otherCharge';
  label: string;
  enabled: keyof PosChargeCapabilities;
}> = [
  { key: 'shippingFee', label: 'Entrega', enabled: 'shippingFeeEnabled' },
  { key: 'codFee', label: 'Contra entrega', enabled: 'codFeeEnabled' },
  { key: 'additionalCharge', label: 'Cargo adicional', enabled: 'additionalChargeEnabled' },
  { key: 'otherCharge', label: 'Otro cargo', enabled: 'otherChargeEnabled' },
];

function validMoney(value: string) {
  if (!value.trim()) return true;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 999_999_999_999.99
    && /^\d+(?:\.\d{0,2})?$/.test(value.trim());
}

function normalizeMoney(value: string) {
  if (!value.trim()) return '0.00';
  const number = Number(value);
  return validMoney(value) && Number.isFinite(number) ? number.toFixed(2) : value;
}

export function PosDeliveryFields({ value, capabilities, onChange }: {
  value: PosDeliveryState;
  capabilities: PosChargeCapabilities | null;
  onChange: (value: PosDeliveryState) => void;
}) {
  return <section className="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
    <p className="text-sm font-semibold text-[#e4252c]">Entrega y notas</p>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-semibold">Modalidad<select value={value.mode} onChange={(event) => onChange({ ...value, mode: event.target.value as PosDeliveryMode })} className="h-11 rounded-lg border border-black/15 bg-white px-3"><option value="store_immediate">Entrega inmediata en tienda</option><option value="home_delivery">Entrega a domicilio</option><option value="cash_on_delivery">Contra entrega</option></select></label>
      <label className="grid gap-1 text-sm font-semibold">Dirección<input maxLength={500} value={value.address} onChange={(event) => onChange({ ...value, address: event.target.value })} className="h-11 rounded-lg border border-black/15 px-3" /></label>
      <label className="grid gap-1 text-sm font-semibold">Instrucciones de entrega<textarea maxLength={1000} value={value.notes} onChange={(event) => onChange({ ...value, notes: event.target.value })} className="min-h-20 rounded-lg border border-black/15 p-3" /></label>
      <label className="grid gap-1 text-sm font-semibold">Notas internas no sensibles<textarea maxLength={1000} value={value.internalNotes} onChange={(event) => onChange({ ...value, internalNotes: event.target.value })} className="min-h-20 rounded-lg border border-black/15 p-3" /></label>
    </div>
    <details className="mt-4 rounded-lg border border-black/10 p-3" open>
      <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold">Cargos opcionales</summary>
      <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {chargeDefinitions.map((definition) => {
          const enabled = Boolean(capabilities?.[definition.enabled]);
          const valid = validMoney(value[definition.key]);
          return <label key={definition.key} className="grid gap-1 text-xs font-semibold text-black/65">
            {definition.label}
            <span className="relative"><span className="pointer-events-none absolute left-3 top-3 text-sm text-black/45">L</span><input type="number" inputMode="decimal" min="0" max="999999999999.99" step="0.01" disabled={!enabled} value={value[definition.key]} aria-invalid={!valid} onChange={(event) => onChange({ ...value, [definition.key]: event.target.value })} onBlur={(event) => onChange({ ...value, [definition.key]: normalizeMoney(event.target.value) })} className={`min-h-11 w-full rounded-lg border bg-white pl-8 pr-3 text-sm disabled:bg-slate-100 disabled:text-black/45 ${valid ? 'border-black/15' : 'border-red-500'}`} /></span>
            {!valid ? <span className="text-red-700">Use un monto no negativo con máximo dos decimales.</span> : null}
          </label>;
        })}
      </div>
      <p className="mt-3 text-xs leading-5 text-black/55">Los cargos con valor mayor que cero se incluirán en el pedido, la factura y el total de la venta.</p>
      {capabilities && chargeDefinitions.some((definition) => !capabilities[definition.enabled]) ? <p className="mt-1 text-xs text-amber-800">Los cargos sin mapping contable activo permanecen bloqueados.</p> : null}
    </details>
  </section>;
}
