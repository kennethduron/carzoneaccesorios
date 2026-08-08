"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { BadgeDollarSign, Minus, Package, Plus, RotateCcw, Trash2 } from "lucide-react";
import { PosConfirmationDialog } from "@/components/admin/pos-confirmation-dialog";
import { PriceOverrideDialog } from "@/components/admin/price-override-dialog";
import { isPosDraftItemStockInsufficient } from "@/lib/pos/inventory-mode";
import { getPosMaximumQuantity, validatePosQuantity } from "@/lib/pos/cart-quantity";
import type { PosDraftItem } from "@/types/pos-drafts";
import { formatCurrency } from "@/utils/pricing";
import styles from "./pos-cart.module.css";

type PendingRemoval = { kind: "line"; item: PosDraftItem; index: number } | { kind: "clear" };

function priceLabel(item: PosDraftItem) {
  if (item.priceOverridden) return "Precio autorizado";
  return item.pricingSource === "wholesale" ? "Precio mayorista" : "Precio al detalle";
}

function QuantityInput({ item, onCommit, onError }: {
  item: PosDraftItem;
  onCommit: (quantity: number) => void;
  onError: (message: string) => void;
}) {
  const [value, setValue] = useState(String(item.quantity));
  const maximum = getPosMaximumQuantity(item);

  function commit() {
    const requested = Number(value);
    const result = validatePosQuantity(item, requested);
    if (!result.ok) {
      onError(result.code === "POS_QUANTITY_INVALID"
        ? "La cantidad debe ser un número entero mayor que cero."
        : `Solo hay ${item.availableStock} unidades disponibles de ${item.productName}.`);
      setValue(String(item.quantity));
      return;
    }
    setValue(String(result.quantity));
    onCommit(result.quantity);
  }

  return (
    <input
      aria-label={`Cantidad de ${item.productName}`}
      type="number"
      inputMode="numeric"
      min="1"
      max={maximum}
      step="1"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setValue(String(item.quantity));
          event.currentTarget.blur();
        }
      }}
      className="h-11 w-16 border-y border-black/15 text-center outline-none focus:ring-2 focus:ring-[#e4252c]/20"
    />
  );
}

export function PosCart({ items, onChange, onClear }: { items: PosDraftItem[]; onChange: (items: PosDraftItem[]) => void; onClear: () => void }) {
  const [editing, setEditing] = useState<PosDraftItem | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null);
  const [lastRemoved, setLastRemoved] = useState<{ item: PosDraftItem; index: number } | null>(null);
  const [cartMessage, setCartMessage] = useState("");
  const returnFocus = useRef<HTMLElement | null>(null);
  const linesRef = useRef<HTMLDivElement | null>(null);
  const previousLineCount = useRef(items.length);
  const update = (productId: string, values: Partial<PosDraftItem>) => onChange(items.map((item) => item.productId === productId ? { ...item, ...values } : item));

  const setQuantity = (item: PosDraftItem, requested: number) => {
    const result = validatePosQuantity(item, requested);
    if (!result.ok) {
      setCartMessage(result.code === "POS_QUANTITY_INVALID"
        ? "La cantidad debe ser un número entero mayor que cero."
        : `Solo hay ${item.availableStock} unidades disponibles de ${item.productName}.`);
      return;
    }
    setCartMessage("");
    update(item.productId, { quantity: result.quantity });
  };

  function confirmRemoval() {
    if (!pendingRemoval) return;
    if (pendingRemoval.kind === "clear") {
      setLastRemoved(null);
      setCartMessage("El carrito quedó vacío.");
      onClear();
    } else {
      setLastRemoved({ item: pendingRemoval.item, index: pendingRemoval.index });
      setCartMessage(`${pendingRemoval.item.productName} se eliminó del carrito.`);
      onChange(items.filter((current) => current.productId !== pendingRemoval.item.productId));
    }
    setPendingRemoval(null);
  }

  const undoRemove = () => {
    if (!lastRemoved || items.some((item) => item.productId === lastRemoved.item.productId)) return;
    const next = [...items];
    next.splice(Math.min(lastRemoved.index, next.length), 0, lastRemoved.item);
    onChange(next);
    setLastRemoved(null);
    setCartMessage("Producto restaurado.");
  };
  const unitCount = items.reduce((sum, item) => sum + item.quantity, 0);

  useEffect(() => {
    const lines = linesRef.current;
    if (lines && items.length > previousLineCount.current) {
      lines.scrollTo({ top: lines.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }
    previousLineCount.current = items.length;
  }, [items.length]);

  return <section data-testid="pos-cart" className="min-w-0 rounded-xl border border-black/10 bg-white p-4 shadow-sm" aria-labelledby="pos-cart-title">
    <div data-testid="pos-cart-header" className="flex items-center justify-between gap-3">
      <div>
        <p className="text-sm font-semibold text-[#e4252c]">Productos agregados</p>
        <h2 id="pos-cart-title" className="text-lg font-semibold">{items.length} línea{items.length === 1 ? "" : "s"} · {unitCount} unidad{unitCount === 1 ? "" : "es"}</h2>
      </div>
      {items.length ? <button type="button" onClick={() => setPendingRemoval({ kind: "clear" })} className="min-h-11 rounded-lg border border-black/15 px-3 text-sm font-semibold hover:border-red-500 hover:text-red-700">Vaciar</button> : null}
    </div>
    {cartMessage ? <div className="mt-3 flex min-h-11 items-center justify-between gap-3 rounded-lg bg-slate-100 px-3 py-2 text-sm" role="status"><span>{cartMessage}</span>{lastRemoved ? <button type="button" onClick={undoRemove} className="min-h-11 shrink-0 font-semibold text-[#e4252c]">Deshacer</button> : null}</div> : null}
    {!items.length ? <div className="mt-3 rounded-lg border border-dashed border-black/15 p-6 text-center"><p className="font-semibold">Aún no hay productos agregados</p><p className="mt-1 text-sm text-black/50">Busque un producto por nombre, SKU o código y agréguelo a la venta.</p></div> : <div ref={linesRef} role="region" aria-label="Lista desplazable de productos agregados" tabIndex={0} className={`mt-3 space-y-2 ${styles.lines}`} data-testid="pos-cart-lines">{items.map((item, index) => {
      const insufficient = isPosDraftItemStockInsufficient(item);
      const maximum = getPosMaximumQuantity(item);
      return <article key={item.productId} data-testid="pos-cart-line" className={`rounded-lg border p-2 ${insufficient ? "border-red-300 bg-red-50/30" : "border-black/10"}`}>
        <div className="grid grid-cols-[56px_minmax(0,1fr)_44px] items-start gap-3">
          <div className="relative flex size-14 items-center justify-center overflow-hidden rounded-lg bg-slate-100 text-black/25">
            {item.imageUrl ? <Image src={item.imageUrl} alt="" fill sizes="56px" className="object-contain p-1" /> : <Package aria-hidden="true" size={24} />}
          </div>
          <div className="min-w-0"><h3 className="truncate font-semibold">{item.productName}</h3><p className="truncate text-xs text-black/50">{[item.sku, item.internalCode].filter(Boolean).join(" · ")} · {item.taxCategory === "exempt" ? "Exento" : "ISV incluido"}</p></div>
          <button type="button" aria-label={`Eliminar ${item.productName}`} title="Quitar producto" onClick={() => setPendingRemoval({ kind: "line", item, index })} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-red-700 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e4252c]"><Trash2 size={18} /></button>
        </div>
        <div className="mt-2 grid gap-2 sm:grid-cols-[auto_minmax(0,1fr)]">
          <div className="flex items-center">
            <button type="button" disabled={item.quantity <= 1} aria-label={`Reducir cantidad de ${item.productName}`} onClick={() => setQuantity(item, item.quantity - 1)} className="inline-flex size-11 items-center justify-center rounded-l-lg border border-black/15 disabled:opacity-40"><Minus size={16} /></button>
            <QuantityInput key={item.quantity} item={item} onCommit={(quantity) => setQuantity(item, quantity)} onError={setCartMessage} />
            <button type="button" disabled={item.quantity >= maximum} aria-label={`Aumentar cantidad de ${item.productName}`} onClick={() => setQuantity(item, item.quantity + 1)} className="inline-flex size-11 items-center justify-center rounded-r-lg border border-black/15 disabled:opacity-40"><Plus size={16} /></button>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2"><div className="min-w-0"><p className="text-xs font-semibold text-black/60">{priceLabel(item)}</p><p className="font-semibold">{formatCurrency(item.finalUnitPrice)} c/u</p>{item.priceOverridden ? <p className="text-[11px] text-black/45">Precio habitual: {formatCurrency(item.baseUnitPrice)}</p> : null}</div><button type="button" onClick={(event) => { returnFocus.current = event.currentTarget; setEditing(item); }} className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-black/15 px-2 text-xs font-semibold"><BadgeDollarSign size={16} /> Ajustar</button></div>
        </div>
        {item.priceOverridden ? <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-950"><span className="min-w-0 truncate">Motivo: {item.priceOverrideReason}</span><button type="button" onClick={() => update(item.productId, { finalUnitPrice: item.baseUnitPrice, priceOverridden: false, priceOverrideReason: null })} className="inline-flex min-h-11 shrink-0 items-center gap-1 font-semibold"><RotateCcw size={14} /> Restaurar</button></div> : null}
        <div className="mt-1 flex items-end justify-between gap-3"><p className={`text-xs font-semibold ${insufficient ? "text-red-700" : item.stockStatus === "low" && item.tracksInventory !== false ? "text-amber-700" : "text-emerald-700"}`}>{item.tracksInventory === false ? "Sin control de inventario" : `Existencia disponible: ${item.availableStock}${insufficient ? " · Revise la cantidad" : ""}`}</p><div className="text-right"><p className="text-[11px] text-black/45">Subtotal</p><p className="shrink-0 font-semibold">{formatCurrency(item.quantity * item.finalUnitPrice)}</p></div></div>
      </article>;
    })}</div>}
    {editing ? <PriceOverrideDialog item={editing} returnFocus={returnFocus} onCancel={() => setEditing(null)} onApply={(price, reason) => { update(editing.productId, { finalUnitPrice: price, priceOverridden: price !== editing.baseUnitPrice, priceOverrideReason: price === editing.baseUnitPrice ? null : reason }); setEditing(null); }} /> : null}
    {pendingRemoval ? <PosConfirmationDialog
      title={pendingRemoval.kind === "clear" ? "Vaciar carrito" : "Eliminar producto"}
      description={pendingRemoval.kind === "clear" ? "Se quitarán todos los productos de esta venta en preparación." : "¿Desea quitar este producto del carrito?"}
      confirmLabel={pendingRemoval.kind === "clear" ? "Vaciar carrito" : "Eliminar producto"}
      cancelLabel="Volver"
      onCancel={() => setPendingRemoval(null)}
      onConfirm={confirmRemoval}
    /> : null}
  </section>;
}
