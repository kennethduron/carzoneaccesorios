"use client";

import { Clock3, FolderOpen } from "lucide-react";
import type { PosActiveDraftSummary } from "@/types/pos-drafts";
import { formatCurrency } from "@/utils/pricing";

export function PosActiveDrafts({ drafts, currentDraftId, loading, onOpen }: { drafts: PosActiveDraftSummary[]; currentDraftId?: string; loading: boolean; onOpen: (draftId: string) => void }) {
  if (loading) return <p className="rounded-lg bg-slate-100 p-3 text-sm text-black/55">Cargando borradores activos...</p>;
  if (!drafts.length) return null;
  return <section className="rounded-xl border border-black/10 bg-white p-4 shadow-sm" aria-labelledby="active-drafts-title"><div className="flex items-center gap-2"><FolderOpen size={18} className="text-[#e4252c]" /><h2 id="active-drafts-title" className="font-semibold">Borradores activos</h2></div><div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{drafts.map((draft) => <button key={draft.draftId} type="button" disabled={draft.draftId === currentDraftId} onClick={() => onOpen(draft.draftId)} className="min-h-16 rounded-lg border border-black/10 p-3 text-left hover:border-[#e4252c] disabled:bg-red-50 disabled:opacity-70"><span className="flex items-start justify-between gap-2"><span className="min-w-0 truncate text-sm font-semibold">{draft.customerName}</span><span className="shrink-0 text-sm font-semibold">{formatCurrency(draft.total)}</span></span><span className="mt-1 flex items-center gap-1 text-xs text-black/50"><Clock3 size={13} /> {draft.itemCount} lineas · {new Date(draft.updatedAt).toLocaleString("es-HN")}</span></button>)}</div></section>;
}
