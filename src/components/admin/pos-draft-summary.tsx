"use client";

import { Save, ShieldCheck } from "lucide-react";
import type { PosSaleDraft } from "@/types/pos-drafts";
import { formatCurrency } from "@/utils/pricing";

function SummaryBreakdown({ merchandiseGross, taxableGross, exemptGross, taxableBase, taxAmount }: { merchandiseGross: number; taxableGross: number; exemptGross: number; taxableBase: number; taxAmount: number }) {
  return <dl className="mt-3 space-y-2 text-sm">
    <div className="flex justify-between"><dt>Mercadería</dt><dd className="font-semibold">{formatCurrency(merchandiseGross)}</dd></div>
    <div className="flex justify-between"><dt>Gravado</dt><dd>{formatCurrency(taxableGross)}</dd></div>
    <div className="flex justify-between"><dt>Exento</dt><dd>{formatCurrency(exemptGross)}</dd></div>
    <div className="flex justify-between"><dt>Base imponible</dt><dd>{formatCurrency(taxableBase)}</dd></div>
    <div className="flex justify-between"><dt>ISV incluido</dt><dd>{formatCurrency(taxAmount)}</dd></div>
    <div className="flex justify-between text-black/45"><dt>Entrega / otros cargos</dt><dd>{formatCurrency(0)}</dd></div>
  </dl>;
}

export function PosDraftSummary({ draft, pending, merchandiseGross, taxableGross, taxableBase, taxAmount, exemptGross, disabled, onSave }: { draft: PosSaleDraft; pending: boolean; merchandiseGross: number; taxableGross: number; taxableBase: number; taxAmount: number; exemptGross: number; disabled: boolean; onSave: () => void }) {
  const officialTax = pending ? taxAmount : draft.taxAmount;
  const officialBase = pending ? taxableBase : draft.taxableBase;
  return <section className="sticky bottom-2 z-20 rounded-xl border border-black/10 bg-white/95 p-4 shadow-lg backdrop-blur lg:static lg:shrink-0 lg:bg-white" aria-labelledby="draft-summary-title">
    <div className="flex items-center justify-between gap-3"><h2 id="draft-summary-title" className="font-semibold">Resumen del borrador</h2>{pending ? <span className="text-xs font-semibold text-amber-700">Pendiente de guardar</span> : null}</div>
    <div className="hidden sm:block"><SummaryBreakdown merchandiseGross={merchandiseGross} taxableGross={taxableGross} exemptGross={exemptGross} taxableBase={officialBase} taxAmount={officialTax} /></div>
    <details className="mt-2 sm:hidden"><summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-[#e4252c]">Ver desglose fiscal</summary><SummaryBreakdown merchandiseGross={merchandiseGross} taxableGross={taxableGross} exemptGross={exemptGross} taxableBase={officialBase} taxAmount={officialTax} /></details>
    <div className="flex justify-between border-t pt-3 text-lg"><span className="font-semibold">Total</span><strong>{formatCurrency(merchandiseGross)}</strong></div>
    <div className="mt-3 flex items-start gap-2 rounded-lg bg-emerald-50 p-3 text-xs text-emerald-900"><ShieldCheck className="shrink-0" size={17} /><span>Borrador de venta — aún no afecta inventario, facturación ni contabilidad.</span></div>
    <button type="button" disabled={disabled} onClick={onSave} className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-[#e4252c] px-4 text-sm font-semibold text-white disabled:opacity-50"><Save size={17} /> Guardar borrador</button>
  </section>;
}
