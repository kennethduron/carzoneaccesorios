"use client";

import { ChevronRight, ShoppingCart } from "lucide-react";
import { formatCurrency } from "@/utils/pricing";

export function PosMobileTotalBar({ unitCount, total, hidden = false, onReview }: {
  unitCount: number;
  total: number;
  hidden?: boolean;
  onReview: () => void;
}) {
  const unitsLabel = `${unitCount} ${unitCount === 1 ? "unidad" : "unidades"}`;
  return <button
    type="button"
    data-testid="pos-mobile-total-bar"
    onClick={onReview}
    className={`${hidden ? "hidden" : "flex"} fixed inset-x-3 bottom-3 z-40 min-h-14 items-center justify-between gap-3 rounded-xl bg-black px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 text-sm font-semibold text-white shadow-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e4252c] min-[800px]:hidden`}
    aria-label={`Revisar total de ${unitsLabel}: ${formatCurrency(total)}`}
  >
    <span className="inline-flex min-w-0 items-center gap-2"><ShoppingCart size={19} className="shrink-0" /><span className="truncate">Revisar total ({unitCount})</span></span>
    <span className="inline-flex shrink-0 items-center gap-2"><span className="text-base">{formatCurrency(total)}</span><ChevronRight size={18} /></span>
  </button>;
}
