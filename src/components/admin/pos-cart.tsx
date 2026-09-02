"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { BadgeDollarSign, ListOrdered, LoaderCircle, Minus, Package, Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { PosConfirmationDialog } from "@/components/admin/pos-confirmation-dialog";
import { PriceOverrideDialog } from "@/components/admin/price-override-dialog";
import { PosPriceRequestDialog } from "@/components/admin/pos-price-request-dialog";
import { isPosDraftItemStockInsufficient } from "@/lib/pos/inventory-mode";
import { getPosMaximumQuantity, validatePosQuantity } from "@/lib/pos/cart-quantity";
import type { PosDraftItem } from "@/types/pos-drafts";
import type { PosPriceRequest } from "@/types/sales-commercial";
import { formatCurrency } from "@/utils/pricing";
import styles from "./pos-cart.module.css";

type PendingRemoval = { kind: "line"; item: PosDraftItem; index: number } | { kind: "clear" };

type Props = {
  items: PosDraftItem[];
  refreshingInventory: boolean;
  onChange: (items: PosDraftItem[]) => void;
  onClear: () => void;
  onRefreshInventory: () => void;
  onViewReservations: (item: PosDraftItem) => void;
  canOverridePrice?: boolean;
  canRequestPrice?: boolean;
  draftId?: string;
  draftVersion?: number;
  priceRequests?: Record<string, PosPriceRequest>;
  onPriceRequestUpdate?: (request: PosPriceRequest) => void;
};

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
        : `Solo hay ${item.availableStock ?? 0} unidades disponibles de ${item.productName}.`);
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
      className="h-11 w-12 border-y border-black/15 text-center outline-none focus:ring-2 focus:ring-[#e4252c]/20"
    />
  );
}

export function PosCart({ items, refreshingInventory, onChange, onClear, onRefreshInventory, onViewReservations, canOverridePrice = true, canRequestPrice = false, draftId, draftVersion, priceRequests = {}, onPriceRequestUpdate }: Props) {
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
        : `Solo hay ${item.availableStock ?? 0} unidades disponibles de ${item.productName}.`);
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

  return <section data-testid="pos-cart" className={`${styles.cart} min-w-0 rounded-xl border border-black/10 bg-white p-3 shadow-sm`} aria-labelledby="pos-cart-title">
    <div data-testid="pos-cart-header" className="flex items-center justify-between gap-2">
      <div>
        <h2 id="pos-cart-title" className="font-semibold">Productos agregados</h2>
        <p className="text-xs text-black/55">{items.length} línea{items.length === 1 ? "" : "s"} · {unitCount} unidad{unitCount === 1 ? "" : "es"}</p>
      </div>
      {items.length ? <div className="flex shrink-0 items-center gap-1"><button data-testid="pos-refresh-inventory" type="button" disabled={refreshingInventory} onClick={onRefreshInventory} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg border border-black/15 px-2 text-sm font-semibold disabled:opacity-50" title="Actualizar existencias">{refreshingInventory ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" size={16} /> : <RefreshCw aria-hidden="true" size={16} />}<span className="sr-only min-[520px]:not-sr-only">Actualizar existencias</span></button><button type="button" onClick={() => setPendingRemoval({ kind: "clear" })} className="min-h-11 rounded-lg border border-black/15 px-3 text-sm font-semibold hover:border-red-500 hover:text-red-700">Vaciar</button></div> : null}
    </div>
    {cartMessage ? <div className="mt-3 flex min-h-11 items-center justify-between gap-3 rounded-lg bg-slate-100 px-3 py-2 text-sm" role="status"><span>{cartMessage}</span>{lastRemoved ? <button type="button" onClick={undoRemove} className="min-h-11 shrink-0 font-semibold text-[#e4252c]">Deshacer</button> : null}</div> : null}
    {!items.length ? <div className="mt-3 rounded-lg border border-dashed border-black/15 p-6 text-center"><p className="font-semibold">Aún no hay productos agregados</p><p className="mt-1 text-sm text-black/50">Busque un producto por nombre, SKU o código y agréguelo a la venta.</p></div> : <div ref={linesRef} role="region" aria-label="Lista desplazable de productos agregados" tabIndex={0} className={`mt-3 space-y-2 ${styles.lines}`} data-testid="pos-cart-lines">{items.map((item, index) => {
      const insufficient = isPosDraftItemStockInsufficient(item);
      const maximum = getPosMaximumQuantity(item);
      const availableStock = item.availableStock ?? 0;
      const reservedStock = item.reservedStock ?? 0;
      const inventoryTone = insufficient || availableStock <= 0 ? "text-red-700" : item.stockStatus === "low" ? "text-amber-700" : "text-emerald-700";
      return <article key={item.productId} data-testid="pos-cart-line" data-pos-product-id={item.productId} tabIndex={-1} className={`${styles.line} rounded-lg border p-2 outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] ${insufficient ? "border-red-300 bg-red-50/30" : "border-black/10"}`}>
          <div className={`${styles.productImage} relative flex size-14 items-center justify-center overflow-hidden rounded-lg bg-slate-100 text-black/25`}>
            {item.imageUrl ? <Image src={item.imageUrl} alt="" fill sizes="56px" className="object-contain p-1" /> : <Package aria-hidden="true" size={24} />}
          </div>
          <div className={`${styles.identity} min-w-0`}><h3 className="line-clamp-2 font-semibold leading-5">{item.productName}</h3><p className="truncate text-xs text-black/50">{[item.sku, item.internalCode].filter(Boolean).join(" · ")} · {item.taxCategory === "exempt" ? "Exento" : "ISV incluido"}</p><div className="mt-0.5 flex min-h-8 min-w-0 items-center gap-1"><p data-testid="pos-inventory-summary" className={`min-w-0 text-xs font-semibold ${item.tracksInventory === false ? "text-blue-700" : inventoryTone}`}>{item.tracksInventory === false ? "Sin control de inventario" : item.hasActiveReservations ? <><span className="sm:hidden">Físico {item.physicalStock} · Reservado {reservedStock} · Disponible {availableStock}</span><span className="hidden sm:inline">{availableStock <= 0 ? "No disponible" : `Disponible: ${availableStock}`} · {reservedStock} reservada{reservedStock === 1 ? "" : "s"}</span></> : `Disponible: ${availableStock}`}{insufficient ? " · Revise la cantidad" : ""}</p>{item.hasActiveReservations ? <button data-testid="pos-reservations-trigger" type="button" aria-label={`Ver pedidos relacionados con ${item.productName}`} title="Ver pedidos relacionados" onClick={() => onViewReservations(item)} className="inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-amber-800 hover:bg-amber-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-amber-700"><ListOrdered aria-hidden="true" size={17} /></button> : null}</div></div>
          <div className={`${styles.quantity} flex items-center`}>
            <button type="button" disabled={item.quantity <= 1} aria-label={`Reducir cantidad de ${item.productName}`} onClick={() => setQuantity(item, item.quantity - 1)} className="inline-flex size-11 items-center justify-center rounded-l-lg border border-black/15 disabled:opacity-40"><Minus size={16} /></button>
            <QuantityInput key={item.quantity} item={item} onCommit={(quantity) => setQuantity(item, quantity)} onError={setCartMessage} />
            <button type="button" disabled={item.quantity >= maximum} aria-label={`Aumentar cantidad de ${item.productName}`} onClick={() => setQuantity(item, item.quantity + 1)} className="inline-flex size-11 items-center justify-center rounded-r-lg border border-black/15 disabled:opacity-40"><Plus size={16} /></button>
          </div>
          <div className={`${styles.price} flex min-w-0 items-center justify-between gap-2 rounded-lg bg-slate-50 px-2 py-1.5`}><div className="min-w-0"><p className="text-[11px] font-semibold text-black/55">{priceRequests[item.productId]?.status === "approved" ? "Precio autorizado" : priceLabel(item)}</p><p className="whitespace-nowrap text-sm font-semibold">{formatCurrency(priceRequests[item.productId]?.status === "approved" ? priceRequests[item.productId].requestedUnitPrice : item.finalUnitPrice)} c/u</p><p className="whitespace-nowrap text-xs text-black/55">Subtotal: <strong>{formatCurrency(item.quantity * (priceRequests[item.productId]?.status === "approved" ? priceRequests[item.productId].requestedUnitPrice : item.finalUnitPrice))}</strong></p></div>{canOverridePrice || canRequestPrice ? <button type="button" disabled={canRequestPrice && !item.itemId} onClick={(event) => { returnFocus.current = event.currentTarget; setEditing(item); }} className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-black/15 px-2 text-xs font-semibold disabled:opacity-45"><BadgeDollarSign size={15} /> {canRequestPrice ? "Solicitar" : "Ajustar"}</button> : null}</div>
          <button type="button" aria-label={`Eliminar ${item.productName}`} title="Quitar producto" onClick={() => setPendingRemoval({ kind: "line", item, index })} className={`${styles.remove} inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-red-700 hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#e4252c]`}><Trash2 size={18} /></button>
        {priceRequests[item.productId] ? <div className={`${styles.override} rounded-lg px-3 py-2 text-xs ${priceRequests[item.productId].status === "approved" ? "bg-emerald-50 text-emerald-900" : priceRequests[item.productId].status === "pending" ? "bg-amber-50 text-amber-950" : "bg-red-50 text-red-900"}`}><strong>{priceRequests[item.productId].status === "approved" ? "Precio especial aprobado" : priceRequests[item.productId].status === "pending" ? "Autorización pendiente" : `Solicitud ${priceRequests[item.productId].status}`}</strong>{priceRequests[item.productId].expiresAt && priceRequests[item.productId].status === "approved" ? ` · vence ${new Date(priceRequests[item.productId].expiresAt!).toLocaleTimeString("es-HN", { hour: "2-digit", minute: "2-digit" })}` : null}</div> : item.priceOverridden ? <div className={`${styles.override} flex items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-950`}><span className="min-w-0 truncate">Motivo: {item.priceOverrideReason}</span><button type="button" onClick={() => update(item.productId, { finalUnitPrice: item.baseUnitPrice, priceOverridden: false, priceOverrideReason: null })} className="inline-flex min-h-11 shrink-0 items-center gap-1 font-semibold"><RotateCcw size={14} /> Restaurar</button></div> : null}
      </article>;
    })}</div>}
    {editing && canRequestPrice && draftId && draftVersion !== undefined ? <PosPriceRequestDialog item={editing} draftId={draftId} draftVersion={draftVersion} current={priceRequests[editing.productId]} onUpdate={(request) => onPriceRequestUpdate?.(request)} onClose={() => setEditing(null)} /> : editing && canOverridePrice ? <PriceOverrideDialog item={editing} returnFocus={returnFocus} onCancel={() => setEditing(null)} onApply={(price, reason) => { update(editing.productId, { finalUnitPrice: price, priceOverridden: price !== editing.baseUnitPrice, priceOverrideReason: price === editing.baseUnitPrice ? null : reason }); setEditing(null); }} /> : null}
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
