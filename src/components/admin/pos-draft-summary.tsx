'use client';

import { Save, ShieldCheck } from 'lucide-react';
import type { PosSaleDraft } from '@/types/pos-drafts';
import { formatCurrency } from '@/utils/pricing';

type SummaryValues = {
  merchandiseGross: number;
  taxableGross: number;
  exemptGross: number;
  taxableBase: number;
  taxAmount: number;
  shippingFee: number;
  codFee: number;
  additionalCharge: number;
  additionalChargeDescription: string;
  otherCharge: number;
  otherChargeDescription: string;
};

function SummaryBreakdown(values: SummaryValues) {
  const charges = [
    ['Entrega', values.shippingFee],
    ['Contra entrega', values.codFee],
    [values.additionalChargeDescription.trim() || 'Cargo adicional', values.additionalCharge],
    [values.otherChargeDescription.trim() || 'Otro cargo', values.otherCharge],
  ] as const;
  return <dl className="mt-3 space-y-2 text-sm">
    <div className="flex justify-between"><dt>Mercadería</dt><dd className="font-semibold">{formatCurrency(values.merchandiseGross)}</dd></div>
    <div className="flex justify-between"><dt>Gravado</dt><dd>{formatCurrency(values.taxableGross)}</dd></div>
    <div className="flex justify-between"><dt>Exento</dt><dd>{formatCurrency(values.exemptGross)}</dd></div>
    <div className="flex justify-between"><dt>Base imponible</dt><dd>{formatCurrency(values.taxableBase)}</dd></div>
    <div className="flex justify-between"><dt>ISV incluido</dt><dd>{formatCurrency(values.taxAmount)}</dd></div>
    {charges.filter(([, amount]) => amount > 0).map(([label, amount]) => <div key={label} className="flex justify-between"><dt>{label}</dt><dd>{formatCurrency(amount)}</dd></div>)}
  </dl>;
}

export function PosDraftSummary({ draft, pending, disabled, onSave, total, ...values }: {
  draft: PosSaleDraft;
  pending: boolean;
  disabled: boolean;
  onSave: () => void;
  total: number;
} & SummaryValues) {
  const officialValues = pending ? values : {
    ...values,
    taxableBase: draft.taxableBase,
    taxAmount: draft.taxAmount,
    shippingFee: draft.shippingFee,
    codFee: draft.codFee,
    additionalCharge: draft.additionalCharge,
    additionalChargeDescription: draft.additionalChargeDescription ?? 'Cargo adicional',
    otherCharge: draft.otherCharge,
    otherChargeDescription: draft.otherChargeDescription ?? 'Otro cargo',
  };
  return <section className="rounded-xl border border-black/10 bg-white p-4 shadow-sm" aria-labelledby="draft-summary-title">
    <div className="flex items-center justify-between gap-3"><h2 id="draft-summary-title" className="font-semibold">Resumen del borrador</h2>{pending ? <span className="text-xs font-semibold text-amber-700">Pendiente de guardar</span> : null}</div>
    <div className="hidden sm:block"><SummaryBreakdown {...officialValues} /></div>
    <details className="mt-2 sm:hidden"><summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-[#e4252c]">Ver desglose fiscal</summary><SummaryBreakdown {...officialValues} /></details>
    <div className="mt-3 flex justify-between border-t border-black/15 pt-3 text-lg"><span className="font-semibold">Total</span><strong className="text-[#e4252c]">{formatCurrency(pending ? total : draft.grandTotal)}</strong></div>
    <div className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-900"><ShieldCheck className="shrink-0" size={17} /><span>El servidor validará y devolverá el total definitivo antes de confirmar.</span></div>
    <button type="button" disabled={disabled} onClick={onSave} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#e4252c] px-4 text-sm font-semibold text-white disabled:opacity-50"><Save size={17} /> Guardar borrador</button>
  </section>;
}
