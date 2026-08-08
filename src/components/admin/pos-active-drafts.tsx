"use client";

import { Clock3, FolderOpen } from "lucide-react";
import type { PosActiveDraftSummary } from "@/types/pos-drafts";
import { formatCurrency } from "@/utils/pricing";

function lineCountLabel(count: number) {
  return `${count} ${count === 1 ? "línea" : "líneas"}`;
}

export function PosActiveDrafts({ drafts, currentDraftId, loading, onOpen }: { drafts: PosActiveDraftSummary[]; currentDraftId?: string; loading: boolean; onOpen: (draftId: string) => void }) {
  if (loading) return <p className="rounded-lg border border-black/10 bg-white px-3 py-2 text-sm text-black/55">Cargando borradores...</p>;
  if (!drafts.length) return null;
  return <details data-testid="pos-active-drafts" className="group rounded-xl border border-black/10 bg-white shadow-sm">
    <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e4252c]">
      <span className="flex min-w-0 items-center gap-2"><FolderOpen size={18} className="shrink-0 text-[#e4252c]" /><span className="truncate text-sm font-semibold">Borradores ({drafts.length})</span></span>
      <span className="text-xs font-medium text-black/50 group-open:hidden">Ver ventas guardadas</span>
      <span className="hidden text-xs font-medium text-black/50 group-open:inline">Ocultar</span>
    </summary>
    <section className="border-t border-black/10 p-3" aria-label="Borradores activos">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{drafts.map((draft) => <button key={draft.draftId} type="button" disabled={draft.draftId === currentDraftId} onClick={() => onOpen(draft.draftId)} className="min-h-16 rounded-lg border border-black/10 p-3 text-left hover:border-[#e4252c] disabled:bg-red-50 disabled:opacity-70"><span className="flex items-start justify-between gap-2"><span className="min-w-0 truncate text-sm font-semibold">{draft.customerName}</span><span className="shrink-0 text-sm font-semibold">{formatCurrency(draft.total)}</span></span><span className="mt-1 flex items-center gap-1 text-xs text-black/50"><Clock3 size={13} /> {lineCountLabel(draft.itemCount)} · {new Date(draft.updatedAt).toLocaleString("es-HN")}</span></button>)}</div>
    </section>
  </details>;
}
