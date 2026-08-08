'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Truck } from 'lucide-react';
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
  additionalChargeDescription: string;
  otherCharge: string;
  otherChargeDescription: string;
};

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

function validDescription(amount: string, description: string) {
  return Number(amount || 0) <= 0
    || (description.trim().length >= 2
      && description.trim().length <= 120
      && !/[<>\r\n\t]/.test(description));
}

function MoneyField({ id, label, value, enabled, onChange }: {
  id: string;
  label: string;
  value: string;
  enabled: boolean;
  onChange: (value: string) => void;
}) {
  const valid = validMoney(value);
  return <label htmlFor={id} className="grid gap-1 text-xs font-semibold text-black/65">
    {label}
    <span className="relative">
      <span className="pointer-events-none absolute left-3 top-3 text-sm text-black/45">L</span>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min="0"
        max="999999999999.99"
        step="0.01"
        disabled={!enabled}
        value={value}
        aria-invalid={!valid}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => onChange(normalizeMoney(event.target.value))}
        className={`min-h-11 w-full rounded-lg border bg-white pl-8 pr-3 text-sm disabled:bg-slate-100 disabled:text-black/45 ${valid ? 'border-black/15' : 'border-red-500'}`}
      />
    </span>
    {!valid ? <span className="text-red-700">Use un monto no negativo con máximo dos decimales.</span> : null}
  </label>;
}

function DescribedCharge({ id, title, placeholder, amount, description, enabled, onAmount, onDescription }: {
  id: 'additional' | 'other';
  title: string;
  placeholder: string;
  amount: string;
  description: string;
  enabled: boolean;
  onAmount: (value: string) => void;
  onDescription: (value: string) => void;
}) {
  const descriptionIsValid = validDescription(amount, description);
  const helpId = `${id}-charge-description-help`;
  return <div className={`rounded-xl border p-3 ${descriptionIsValid ? 'border-black/10' : 'border-red-400 bg-red-50/30'}`}>
    <h3 className="text-sm font-semibold">{title}</h3>
    <label htmlFor={`${id}-charge-description`} className="mt-3 grid gap-1 text-xs font-semibold text-black/65">
      Descripción
      <input
        id={`${id}-charge-description`}
        maxLength={120}
        disabled={!enabled}
        value={description}
        aria-invalid={!descriptionIsValid}
        aria-describedby={helpId}
        onChange={(event) => onDescription(event.target.value)}
        placeholder={placeholder}
        className="min-h-11 rounded-lg border border-black/15 bg-white px-3 text-sm text-black disabled:bg-slate-100 disabled:text-black/45"
      />
    </label>
    <div className="mt-3">
      <MoneyField id={`${id}-charge-amount`} label="Monto" value={amount} enabled={enabled} onChange={onAmount} />
    </div>
    <p id={helpId} className={`mt-2 text-xs ${descriptionIsValid ? 'text-black/50' : 'font-semibold text-red-700'}`}>
      {Number(amount || 0) > 0 ? 'La descripción es obligatoria (2–120 caracteres).' : 'Opcional mientras el monto sea L 0.00.'}
    </p>
  </div>;
}

export function PosDeliveryFields({ value, capabilities, onChange }: {
  value: PosDeliveryState;
  capabilities: PosChargeCapabilities | null;
  onChange: (value: PosDeliveryState) => void;
}) {
  const [open, setOpen] = useState(false);
  const userChanged = useRef(false);

  useEffect(() => {
    const query = window.matchMedia('(min-width: 800px)');
    const sync = () => { if (!userChanged.current) setOpen(query.matches); };
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  return <details data-testid="pos-delivery-disclosure" open={open} onToggle={(event) => { if (event.nativeEvent.isTrusted) userChanged.current = true; setOpen(event.currentTarget.open); }} className="group rounded-xl border border-black/10 bg-white shadow-sm">
    <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e4252c]">
      <span className="flex min-w-0 items-center gap-2"><Truck size={18} className="shrink-0 text-[#e4252c]" /><span><span id="pos-delivery-title" className="block font-semibold">Entrega y cargos</span><span className="block truncate text-xs font-normal text-black/50">Modalidad, instrucciones y conceptos adicionales</span></span></span>
      <ChevronDown size={18} className="shrink-0 transition group-open:rotate-180 motion-reduce:transition-none" />
    </summary>
    <div className="border-t border-black/10 p-3">
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-semibold">Modalidad<select value={value.mode} onChange={(event) => onChange({ ...value, mode: event.target.value as PosDeliveryMode })} className="h-11 rounded-lg border border-black/15 bg-white px-3"><option value="store_immediate">Entrega inmediata en tienda</option><option value="home_delivery">Entrega a domicilio</option><option value="cash_on_delivery">Contra entrega</option></select></label>
      <label className="grid gap-1 text-sm font-semibold">Dirección<input maxLength={500} value={value.address} onChange={(event) => onChange({ ...value, address: event.target.value })} placeholder="Dirección de entrega (opcional)" className="h-11 rounded-lg border border-black/15 px-3" /></label>
      <label className="grid gap-1 text-sm font-semibold">Instrucciones de entrega<textarea maxLength={1000} value={value.notes} onChange={(event) => onChange({ ...value, notes: event.target.value })} placeholder="Indicaciones para la entrega (opcional)" className="min-h-20 rounded-lg border border-black/15 p-3" /></label>
      <label className="grid gap-1 text-sm font-semibold">Notas internas no sensibles<textarea maxLength={1000} value={value.internalNotes} onChange={(event) => onChange({ ...value, internalNotes: event.target.value })} placeholder="Notas para el equipo (no visibles para el cliente)" className="min-h-20 rounded-lg border border-black/15 p-3" /></label>
    </div>
    <section className="mt-3 rounded-xl border border-black/10 p-3" aria-labelledby="pos-optional-charges-title">
      <h3 id="pos-optional-charges-title" className="text-sm font-semibold">Cargos opcionales</h3>
      <div className="mt-2 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-black/10 p-3"><MoneyField id="shipping-fee" label="Entrega" value={value.shippingFee} enabled={Boolean(capabilities?.shippingFeeEnabled)} onChange={(shippingFee) => onChange({ ...value, shippingFee })} /></div>
        <div className="rounded-xl border border-black/10 p-3"><MoneyField id="cod-fee" label="Contra entrega" value={value.codFee} enabled={Boolean(capabilities?.codFeeEnabled)} onChange={(codFee) => onChange({ ...value, codFee })} /></div>
        <DescribedCharge id="additional" title="Cargo adicional" placeholder="Ej. Instalación del accesorio" amount={value.additionalCharge} description={value.additionalChargeDescription} enabled={Boolean(capabilities?.additionalChargeEnabled)} onAmount={(additionalCharge) => onChange({ ...value, additionalCharge })} onDescription={(additionalChargeDescription) => onChange({ ...value, additionalChargeDescription })} />
        <DescribedCharge id="other" title="Otro cargo" placeholder="Ej. Material especial" amount={value.otherCharge} description={value.otherChargeDescription} enabled={Boolean(capabilities?.otherChargeEnabled)} onAmount={(otherCharge) => onChange({ ...value, otherCharge })} onDescription={(otherChargeDescription) => onChange({ ...value, otherChargeDescription })} />
      </div>
      <p className="mt-3 text-xs leading-5 text-black/55">Solo los cargos mayores que cero aparecerán en el pedido, la factura y el total. Las descripciones son documentales: no cambian impuestos ni cuentas contables.</p>
      {capabilities && (!capabilities.shippingFeeEnabled || !capabilities.codFeeEnabled || !capabilities.additionalChargeEnabled || !capabilities.otherChargeEnabled) ? <p className="mt-1 text-xs text-amber-800">Los cargos sin mapping contable activo permanecen bloqueados.</p> : null}
    </section>
    </div>
  </details>;
}
