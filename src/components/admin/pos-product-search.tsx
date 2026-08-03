"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LoaderCircle, PackagePlus, Search } from "lucide-react";
import type { PosProductSearchPage, PosProductSearchResult } from "@/types/pos-drafts";
import { formatCurrency } from "@/utils/pricing";

type Props = {
  disabled: boolean;
  customerId: string;
  customerCommercialVersion: number;
  onAdd: (product: PosProductSearchResult) => void;
};

function productAvailability(product: PosProductSearchResult) {
  if (!product.active || product.productStatus !== "active") {
    const label = product.productStatus === "inactive" ? "Inactivo" : product.productStatus === "archived" ? "Archivado" : "Borrador";
    return { label, className: "text-slate-600", available: false };
  }
  if (product.tracksInventory === false) {
    return { label: "Servicio · sin control de inventario", className: "text-blue-700", available: true };
  }
  if (product.autoDisabledByStock || product.availableStock <= 0) return { label: "Agotado", className: "text-red-700", available: false };
  if (product.availableStock <= product.lowStockThreshold) return { label: `Stock bajo · ${product.availableStock} disponible`, className: "text-amber-700", available: true };
  return { label: `Disponible ${product.availableStock}`, className: "text-emerald-700", available: true };
}

export function PosProductSearch({ disabled, customerId, customerCommercialVersion, onAdd }: Props) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PosProductSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [announcement, setAnnouncement] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listboxId = useId();

  const closeResults = useCallback(() => { setResults([]); setActiveIndex(-1); }, []);
  const addProduct = useCallback((product: PosProductSearchResult) => {
    const availability = productAvailability(product);
    if (!availability.available) {
      setMessage(availability.label === "Agotado" ? "Producto agotado; no se puede agregar al borrador." : `Producto ${availability.label.toLowerCase()}; no se puede agregar al borrador.`);
      setAnnouncement(`${product.productName} no se puede agregar.`);
      return;
    }
    onAdd(product);
    setAnnouncement(`${product.productName} agregado al carrito.`);
    setQuery("");
    closeResults();
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, [closeResults, onAdd]);

  const search = useCallback(async (value: string) => {
    const normalized = value.trim();
    if (disabled || !normalized) { abortRef.current?.abort(); closeResults(); setMessage(""); setLoading(false); return; }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true); setMessage("");
    try {
      const params = new URLSearchParams({ q: normalized, customerId, expectedCustomerCommercialVersion: String(customerCommercialVersion), includeUnavailable: "true", limit: "25", offset: "0" });
      const response = await fetch(`/api/admin/pos/products/search?${params}`, { signal: controller.signal, headers: { Accept: "application/json" }, cache: "no-store" });
      const payload = await response.json() as PosProductSearchPage & { message?: string };
      if (!response.ok) throw new Error(payload.message || "No se pudo buscar.");
      setResults(payload.results); setActiveIndex(payload.results.length ? 0 : -1);
      setMessage(payload.results.length ? "" : normalized.length === 1 ? "Escribe dos caracteres o un SKU/código exacto." : "No se encontraron productos activos.");
    } catch (error) {
      if (!controller.signal.aborted) { closeResults(); setMessage(error instanceof Error ? error.message : "No se pudo buscar."); }
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, [closeResults, customerCommercialVersion, customerId, disabled]);

  useEffect(() => { const timer = window.setTimeout(() => void search(query), 275); return () => window.clearTimeout(timer); }, [query, search]);
  useEffect(() => () => abortRef.current?.abort(), []);

  function keyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((value) => Math.min(Math.max(value + 1, 0), results.length - 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((value) => Math.max(value - 1, 0)); }
    else if (event.key === "Enter") { event.preventDefault(); const selected = results[activeIndex]; if (selected) addProduct(selected); else void search(query); }
    else if (event.key === "Escape") { event.preventDefault(); closeResults(); }
  }

  return <section className="min-w-0 rounded-xl border border-black/10 bg-white p-4 shadow-sm" aria-labelledby="pos-product-search-title">
    <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-semibold text-[#e4252c]">Productos</p><h2 id="pos-product-search-title" className="text-lg font-semibold">Buscar y agregar</h2></div><span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold">Precios actualizados</span></div>
    <div className="relative mt-3"><Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3 text-black/40" size={18} /><input ref={inputRef} autoFocus disabled={disabled} role="combobox" aria-autocomplete="list" aria-expanded={results.length > 0} aria-controls={listboxId} aria-activedescendant={activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined} aria-describedby="pos-product-search-help" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={keyDown} placeholder={disabled ? "Selecciona el cliente del borrador" : "Nombre, SKU, código, marca o categoría"} className="min-h-11 w-full rounded-lg border border-black/15 pl-10 pr-10 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15 disabled:bg-slate-100" />{loading ? <LoaderCircle aria-label="Buscando productos" className="absolute right-3 top-3 animate-spin motion-reduce:animate-none text-[#e4252c]" size={18} /> : null}</div>
    <p id="pos-product-search-help" className="mt-2 text-xs text-black/50">Mínimo 2 caracteres; un SKU o código exacto puede ser más corto. Usa flechas, Enter o Escape.</p>
    {message ? <p className="mt-2 text-sm text-black/60" role="status">{message}</p> : null}<div className="sr-only" aria-live="polite">{announcement}</div>
    {results.length ? <div id={listboxId} role="listbox" aria-label="Resultados de productos" className="mt-3 max-h-96 space-y-2 overflow-y-auto rounded-lg border border-black/10 p-2">{results.map((product, index) => { const availability = productAvailability(product); return <button key={product.productId} id={`${listboxId}-option-${index}`} type="button" role="option" aria-selected={activeIndex === index} aria-disabled={!availability.available} onMouseEnter={() => setActiveIndex(index)} onClick={() => addProduct(product)} className={`grid min-h-16 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] ${activeIndex === index ? "border-[#e4252c] bg-red-50" : "border-black/5 hover:bg-slate-50"} ${availability.available ? "" : "opacity-70"}`}><span className="min-w-0"><span className="block truncate text-sm font-semibold">{product.productName}</span><span className="block truncate text-xs text-black/55">{product.sku} · {product.brand}</span><span className={`mt-1 block text-xs font-semibold ${availability.className}`}>{availability.label}</span></span><span className="text-right"><span className="block font-semibold">{formatCurrency(product.baseUnitPrice)}</span><span className={`inline-flex min-h-11 items-center gap-1 text-xs font-semibold ${availability.available ? "text-[#e4252c]" : "text-slate-500"}`}><PackagePlus size={14} /> {availability.available ? "Agregar" : "No disponible"}</span></span></button>; })}</div> : null}
  </section>;
}
