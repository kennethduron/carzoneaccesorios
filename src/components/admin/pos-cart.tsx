"use client";

import { useRef, useState } from "react";
import { BadgeDollarSign, Minus, Plus, RotateCcw, Trash2 } from "lucide-react";
import { PriceOverrideDialog } from "@/components/admin/price-override-dialog";
import { isPosDraftItemStockInsufficient } from "@/lib/pos/inventory-mode";
import type { PosDraftItem } from "@/types/pos-drafts";
import { formatCurrency } from "@/utils/pricing";

export function PosCart({ items, onChange, onClear }: { items: PosDraftItem[]; onChange: (items: PosDraftItem[]) => void; onClear: () => void }) {
  const [editing, setEditing] = useState<PosDraftItem | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const update = (productId: string, values: Partial<PosDraftItem>) => onChange(items.map((item) => item.productId === productId ? { ...item, ...values } : item));
  const clear = () => { if (window.confirm("Vaciar el carrito? El cambio se guardara en el borrador.")) onClear(); };

  return <section className="min-w-0 rounded-xl border border-black/10 bg-white p-4 shadow-sm" aria-labelledby="pos-cart-title">
    <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-[#e4252c]">Carrito</p><h2 id="pos-cart-title" className="text-lg font-semibold">{items.length} producto{items.length === 1 ? "" : "s"}</h2></div>{items.length ? <button type="button" onClick={clear} className="min-h-11 rounded-lg border border-black/15 px-3 text-sm font-semibold hover:border-red-500 hover:text-red-700">Vaciar</button> : null}</div>
    {!items.length ? <div className="mt-3 rounded-lg border border-dashed border-black/15 p-6 text-center text-sm text-black/50">Busca un producto para preparar la venta.</div> : <div className="mt-3 space-y-3">{items.map((item) => {
      const insufficient = isPosDraftItemStockInsufficient(item);
      return <article key={item.productId} className={`rounded-lg border p-3 ${insufficient ? "border-red-300 bg-red-50/30" : "border-black/10"}`}>
        <div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="truncate font-semibold">{item.productName}</h3><p className="truncate text-xs text-black/50">{item.sku} · {item.taxCategory === "exempt" ? "Exento" : "ISV incluido"}</p></div><button type="button" aria-label={`Eliminar ${item.productName}`} onClick={() => onChange(items.filter((current) => current.productId !== item.productId))} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-red-700 hover:bg-red-50"><Trash2 size={18} /></button></div>
        <div className="mt-3 grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]"><div className="flex items-center"><button type="button" aria-label={`Reducir cantidad de ${item.productName}`} onClick={() => update(item.productId, { quantity: Math.max(1, item.quantity - 1) })} className="inline-flex size-11 items-center justify-center rounded-l-lg border border-black/15"><Minus size={16} /></button><input aria-label={`Cantidad de ${item.productName}`} type="number" min="1" max="9999" value={item.quantity} onChange={(event) => update(item.productId, { quantity: Math.min(9999, Math.max(1, Math.trunc(Number(event.target.value) || 1))) })} className="h-11 w-16 border-y border-black/15 text-center" /><button type="button" aria-label={`Aumentar cantidad de ${item.productName}`} onClick={() => update(item.productId, { quantity: Math.min(9999, item.quantity + 1) })} className="inline-flex size-11 items-center justify-center rounded-r-lg border border-black/15"><Plus size={16} /></button></div><div className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2"><div className="min-w-0"><p className="text-xs text-black/50">{item.pricingSource === "wholesale" ? "Mayorista" : "Minorista"}</p><p className="font-semibold">{formatCurrency(item.finalUnitPrice)} c/u</p></div><button type="button" onClick={(event) => { returnFocus.current = event.currentTarget; setEditing(item); }} className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-black/15 px-2 text-xs font-semibold"><BadgeDollarSign size={16} /> Ajustar</button></div></div>
        {item.priceOverridden ? <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-950"><span className="min-w-0 truncate">Ajuste: {item.priceOverrideReason}</span><button type="button" onClick={() => update(item.productId, { finalUnitPrice: item.baseUnitPrice, priceOverridden: false, priceOverrideReason: null })} className="inline-flex min-h-11 shrink-0 items-center gap-1 font-semibold"><RotateCcw size={14} /> Restaurar</button></div> : null}
        <div className="mt-2 flex items-end justify-between gap-3"><p className={`text-xs font-semibold ${insufficient ? "text-red-700" : item.stockStatus === "low" && item.tracksInventory !== false ? "text-amber-700" : "text-emerald-700"}`}>{item.tracksInventory === false ? "Sin control de inventario" : `Disponible: ${item.availableStock}${insufficient ? " · Cantidad superior a disponibilidad" : ""}`}</p><p className="shrink-0 font-semibold">{formatCurrency(item.quantity * item.finalUnitPrice)}</p></div>
      </article>;
    })}</div>}
    {editing ? <PriceOverrideDialog item={editing} returnFocus={returnFocus} onCancel={() => setEditing(null)} onApply={(price, reason) => { update(editing.productId, { finalUnitPrice: price, priceOverridden: price !== editing.baseUnitPrice, priceOverrideReason: price === editing.baseUnitPrice ? null : reason }); setEditing(null); }} /> : null}
  </section>;
}
