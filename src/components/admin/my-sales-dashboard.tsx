"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleDollarSign, Clock3, LoaderCircle, Plus, ReceiptText, Search, ShoppingCart, XCircle } from "lucide-react";
import type { MyPosSale, MyPosSaleDetail, MyPosSalesPage } from "@/types/sales-commercial";
import { formatCurrency } from "@/utils/pricing";

function localDate(date: Date) { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa", year: "numeric", month: "2-digit", day: "2-digit" }).format(date); }
function startOfMonth() { const now = new Date(); return localDate(new Date(now.getFullYear(), now.getMonth(), 1)); }
function statusLabel(status: string) { return ["entregado", "delivered"].includes(status) ? "Entregada" : ["cancelado", "cancelled"].includes(status) ? "Cancelada" : "Pendiente"; }
function paymentLabel(method: string) { return ({ cash: "Efectivo", card: "Tarjeta", bank_transfer: "Transferencia", commercial_credit: "Crédito comercial" } as Record<string,string>)[method] ?? method; }

export function MySalesDashboard() {
  const [from, setFrom] = useState(startOfMonth);
  const [to, setTo] = useState(() => localDate(new Date()));
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [method, setMethod] = useState("");
  const [offset, setOffset] = useState(0);
  const [page, setPage] = useState<MyPosSalesPage | null>(null);
  const [selected, setSelected] = useState<MyPosSaleDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setMessage("");
    const params = new URLSearchParams({ from, to, limit: "20", offset: String(offset) });
    if (query.trim()) params.set("q", query.trim()); if (status) params.set("status", status); if (method) params.set("method", method);
    try { const response = await fetch(`/api/admin/pos/my-sales?${params}`, { headers: { Accept: "application/json" }, cache: "no-store" }); const payload = await response.json() as MyPosSalesPage & { message?: string }; if (!response.ok) throw new Error(payload.message); setPage(payload); }
    catch (error) { setMessage(error instanceof Error ? error.message : "No se pudieron cargar tus ventas."); }
    finally { setLoading(false); }
  }, [from, method, offset, query, status, to]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), 250); return () => window.clearTimeout(timer); }, [load]);
  async function openSale(sale: MyPosSale) { setMessage(""); const response = await fetch(`/api/admin/pos/my-sales/${sale.orderId}`, { headers: { Accept: "application/json" }, cache: "no-store" }); const payload = await response.json() as MyPosSaleDetail & { message?: string }; if (!response.ok) { setMessage(payload.message ?? "No se pudo cargar la venta."); return; } setSelected(payload); }
  const pages = Math.max(1, Math.ceil((page?.total ?? 0) / 20)); const activePage = Math.floor(offset / 20) + 1;
  const stats = useMemo(() => page?.summary, [page]);
  return <div className="min-w-0 space-y-4">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-2xl font-semibold">Mis ventas</h2><p className="text-sm text-black/55">Solo se muestran las ventas asignadas a tu usuario.</p></div><a href="/admin/pos" className="inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#e4252c] px-4 font-semibold text-white"><Plus size={18} /> Nueva venta</a></header>
    <section className="grid gap-2 rounded-xl border border-black/10 bg-white p-3 shadow-sm sm:grid-cols-2 lg:grid-cols-6">
      <button onClick={() => { setFrom(localDate(new Date())); setTo(localDate(new Date())); setOffset(0); }} className="min-h-11 rounded-lg border border-black/10 font-semibold">Hoy</button>
      <button onClick={() => { const d = new Date(); d.setDate(d.getDate()-6); setFrom(localDate(d)); setTo(localDate(new Date())); setOffset(0); }} className="min-h-11 rounded-lg border border-black/10 font-semibold">Esta semana</button>
      <button onClick={() => { setFrom(startOfMonth()); setTo(localDate(new Date())); setOffset(0); }} className="min-h-11 rounded-lg border border-red-200 bg-red-50 font-semibold text-red-700">Este mes</button>
      <label className="text-xs font-semibold">Desde<input type="date" value={from} onChange={(e) => { setFrom(e.target.value); setOffset(0); }} className="mt-1 min-h-9 w-full rounded-lg border border-black/15 px-2" /></label>
      <label className="text-xs font-semibold">Hasta<input type="date" value={to} onChange={(e) => { setTo(e.target.value); setOffset(0); }} className="mt-1 min-h-9 w-full rounded-lg border border-black/15 px-2" /></label>
      <span className="self-center rounded-lg bg-blue-50 p-2 text-center text-xs font-semibold text-blue-700">Consulta privada</span>
    </section>
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Metric icon={ShoppingCart} label="Ventas realizadas" value={String(stats?.salesCount ?? 0)} detail="Excluye canceladas" tone="emerald" />
      <Metric icon={CircleDollarSign} label="Monto vendido" value={formatCurrency(stats?.soldAmount ?? 0)} detail="Total del período" tone="blue" />
      <Metric icon={CheckCircle2} label="Cobrado" value={formatCurrency(stats?.collectedAmount ?? 0)} detail="Pagos confirmados" tone="emerald" />
      <Metric icon={Clock3} label="Pendiente" value={formatCurrency(stats?.pendingAmount ?? 0)} detail="Saldo por cobrar" tone="amber" />
    </section>
    <section className="grid gap-2 rounded-xl border border-black/10 bg-white p-3 shadow-sm md:grid-cols-[minmax(220px,1fr)_180px_190px]">
      <label className="relative"><Search className="absolute left-3 top-3 text-black/35" size={18} /><span className="sr-only">Buscar</span><input value={query} onChange={(e) => { setQuery(e.target.value); setOffset(0); }} placeholder="Buscar cliente, factura o venta" className="min-h-11 w-full rounded-lg border border-black/15 pl-10 pr-3" /></label>
      <select aria-label="Estado" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} className="min-h-11 rounded-lg border border-black/15 px-3"><option value="">Todos los estados</option><option value="entregado">Entregadas</option><option value="confirmado">Pendientes</option><option value="cancelado">Canceladas</option></select>
      <select aria-label="Método de pago" value={method} onChange={(e) => { setMethod(e.target.value); setOffset(0); }} className="min-h-11 rounded-lg border border-black/15 px-3"><option value="">Todos los métodos</option><option value="cash">Efectivo</option><option value="card">Tarjeta</option><option value="bank_transfer">Transferencia</option><option value="commercial_credit">Crédito comercial</option></select>
    </section>
    {message ? <p role="alert" className="rounded-xl bg-red-50 p-3 text-red-800">{message}</p> : null}
    <section className="overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm">
      {loading ? <div className="flex min-h-48 items-center justify-center gap-2 text-black/55"><LoaderCircle className="animate-spin" /> Cargando ventas…</div> : !page?.results.length ? <div className="min-h-48 p-8 text-center"><ShoppingCart className="mx-auto text-black/20" size={40}/><h3 className="mt-3 font-semibold">No hay ventas en este período</h3><p className="mt-1 text-sm text-black/50">Prueba otro rango o inicia una nueva venta.</p></div> : <><div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[860px] text-sm"><thead className="bg-slate-50 text-left text-xs text-black/55"><tr>{["Fecha","Venta","Cliente","Total","Método","Estado","Factura","Cobro",""] .map((h) => <th key={h} className="px-3 py-3">{h}</th>)}</tr></thead><tbody>{page.results.map((sale) => <tr key={sale.orderId} className="border-t border-black/10 hover:bg-red-50/30"><td className="px-3 py-3">{new Date(sale.createdAt).toLocaleDateString("es-HN")}</td><td className="px-3 font-semibold">{sale.orderNumber}</td><td className="px-3">{sale.customerName}</td><td className="px-3 font-semibold">{formatCurrency(sale.total)}</td><td className="px-3">{paymentLabel(sale.paymentMethod)}</td><td className="px-3"><Badge text={statusLabel(sale.status)} good={!["cancelado","cancelled"].includes(sale.status)} /></td><td className="px-3">{sale.invoiceNumber ?? "—"}</td><td className="px-3"><Badge text={sale.balanceDue > 0 ? "Pendiente" : "Cobrado"} good={sale.balanceDue <= 0} /></td><td className="px-3"><button onClick={() => void openSale(sale)} className="min-h-11 font-semibold text-blue-700">Ver</button></td></tr>)}</tbody></table></div><div className="divide-y divide-black/10 md:hidden">{page.results.map((sale) => <button key={sale.orderId} onClick={() => void openSale(sale)} className="block w-full p-4 text-left"><div className="flex justify-between gap-3"><strong>{sale.orderNumber}</strong><strong className="text-red-700">{formatCurrency(sale.total)}</strong></div><p className="mt-1 text-sm">{sale.customerName}</p><div className="mt-2 flex flex-wrap gap-2"><Badge text={statusLabel(sale.status)} good={!["cancelado","cancelled"].includes(sale.status)} /><Badge text={sale.balanceDue > 0 ? "Pendiente" : "Cobrado"} good={sale.balanceDue <= 0} /></div></button>)}</div></>}
    </section>
    <footer className="flex items-center justify-between gap-3 text-sm"><span>Mostrando {page?.results.length ?? 0} de {page?.total ?? 0}</span><div className="flex gap-2"><button disabled={activePage<=1} onClick={() => setOffset(Math.max(0,offset-20))} className="min-h-11 rounded-lg border px-3 disabled:opacity-40">Anterior</button><span className="grid min-h-11 min-w-11 place-items-center rounded-lg bg-red-600 font-semibold text-white">{activePage}/{pages}</span><button disabled={activePage>=pages} onClick={() => setOffset(offset+20)} className="min-h-11 rounded-lg border px-3 disabled:opacity-40">Siguiente</button></div></footer>
    {selected ? <SaleDetail sale={selected} onClose={() => setSelected(null)} /> : null}
  </div>;
}

function Metric({ icon: Icon, label, value, detail, tone }: { icon: typeof ShoppingCart; label: string; value: string; detail: string; tone: string }) { const toneClass=tone==="blue"?"bg-blue-50 text-blue-700":tone==="amber"?"bg-amber-50 text-amber-700":"bg-emerald-50 text-emerald-700";return <article className="rounded-xl border border-black/10 bg-white p-4 shadow-sm"><div className="flex items-center gap-3"><span className={`grid size-11 place-items-center rounded-full ${toneClass}`}><Icon size={21}/></span><div><p className="text-sm text-black/55">{label}</p><strong className="text-xl">{value}</strong></div></div><p className="mt-3 text-xs text-black/45">{detail}</p></article>; }
function Badge({ text, good }: { text: string; good: boolean }) { return <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${good ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-800"}`}>{text}</span>; }
function SaleDetail({ sale, onClose }: { sale: MyPosSaleDetail; onClose: () => void }) { return <div className="fixed inset-0 z-50 flex justify-end bg-black/45" role="dialog" aria-modal="true" aria-label="Detalle de venta"><section className="h-full w-full max-w-lg overflow-y-auto bg-white p-4 shadow-2xl sm:p-6"><header className="flex justify-between gap-3"><div><p className="text-sm text-black/50">Detalle de venta</p><h2 className="text-xl font-semibold text-red-700">{sale.orderNumber}</h2></div><button onClick={onClose} className="grid size-11 place-items-center rounded-lg hover:bg-black/5" aria-label="Cerrar"><XCircle /></button></header><dl className="mt-5 grid grid-cols-2 gap-3 text-sm"><div><dt className="text-black/50">Estado</dt><dd className="font-semibold">{statusLabel(sale.status)}</dd></div><div><dt className="text-black/50">Fecha</dt><dd className="font-semibold">{new Date(sale.createdAt).toLocaleString("es-HN")}</dd></div><div><dt className="text-black/50">Cliente</dt><dd className="font-semibold">{sale.customerName}</dd></div><div><dt className="text-black/50">Total</dt><dd className="font-semibold text-red-700">{formatCurrency(sale.total)}</dd></div></dl><h3 className="mt-6 font-semibold">Productos</h3><div className="mt-2 divide-y rounded-xl border">{sale.items.map((item) => <div key={item.itemId} className="p-3"><div className="flex justify-between gap-2"><strong>{item.productName}</strong><span>{item.quantity} × {formatCurrency(item.unitPrice)}</span></div><p className="text-xs text-black/50">{item.sku}{item.priceAuthorized ? " · Precio autorizado" : ""}</p></div>)}</div><section className="mt-5 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-950"><div className="flex justify-between"><span>Cobrado</span><strong>{formatCurrency(sale.collection.collectedAmount)}</strong></div><div className="mt-2 flex justify-between"><span>Saldo</span><strong>{formatCurrency(sale.collection.balanceDue)}</strong></div></section>{sale.invoice ? <a href={`/api/admin/facturas/${sale.invoice.invoiceId}/pdf`} target="_blank" className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border font-semibold"><ReceiptText size={18}/> Ver factura</a> : null}<p className="mt-5 rounded-lg bg-blue-50 p-3 text-xs text-blue-800">Esta vista permite consultar únicamente su venta, factura y cobro. Las ventas canceladas permanecen visibles.</p></section></div>; }
