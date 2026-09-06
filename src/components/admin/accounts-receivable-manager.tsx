"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Download, Filter, PlusCircle, Search, X } from "lucide-react";
import { markCreditReceivablePaidAction, registerCreditReceivablePaymentAction } from "@/app/admin/pedidos/actions";
import { AccountsReceivableSummary } from "@/components/admin/accounts-receivable-summary";
import { AccessibleSheet } from "@/components/admin/accessible-sheet";
import { Button } from "@/components/ui";
import { useToast } from "@/contexts/toast-context";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { AdminAccountsReceivablePage, AdminAccountsReceivableRow, CommercialCreditPaymentReceivedMethod } from "@/types/credit";
import { formatHnDateTime } from "@/utils/format";
import { formatCurrency } from "@/utils/pricing";
import { formatReceivableInvoice } from "@/utils/receivable-invoice";

const statusLabels: Record<string, string> = { open: "Pendiente", partial: "Pago parcial", paid: "Pagado", overdue: "Vencido", cancelled: "Cancelado" };
const methodLabels: Record<string, string> = { bank_transfer: "Transferencia bancaria", card: "Tarjeta", cash: "Efectivo" };
type ActionMode = "payment" | "mark-paid" | null;
type Draft = { amount: string; method: CommercialCreditPaymentReceivedMethod | ""; reference: string; receivedAt: string; note: string; receiptUrl: string; idempotencyKey: string };

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
function newIdempotencyKey(id: string) {
  const value = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `credit-payment:${id}:${value}`;
}
function pendingIdempotencyStorageKey(id: string) { return `credit-payment:pending:${id}`; }
function recoverIdempotencyKey(id: string) {
  if (typeof sessionStorage === "undefined") return newIdempotencyKey(id);
  return sessionStorage.getItem(pendingIdempotencyStorageKey(id)) ?? newIdempotencyKey(id);
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-HN", { dateStyle: "medium", timeZone: "America/Tegucigalpa" }).format(new Date(`${value}T12:00:00-06:00`));
}
function remaining(value: string) {
  const due = new Date(`${value}T12:00:00-06:00`).getTime();
  const now = new Date(`${today()}T12:00:00-06:00`).getTime();
  return Math.ceil((due - now) / 86_400_000);
}
function statusClass(status: string) {
  if (status === "paid") return "bg-emerald-50 text-emerald-700";
  if (status === "partial") return "bg-amber-50 text-amber-700";
  return "bg-red-50 text-[#c7000b]";
}

export function AccountsReceivableManager({ data, canMarkPaid, canExport }: { data: AdminAccountsReceivablePage; canMarkPaid: boolean; canExport: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const toast = useToast();
  const [query, setQuery] = useState(data.query);
  const debouncedQuery = useDebouncedValue(query, 300);
  const [selectedId, setSelectedId] = useState<string | null>(data.rows[0]?.id ?? null);
  const [actionMode, setActionMode] = useState<ActionMode>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [detailMobile, setDetailMobile] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [isPending, startTransition] = useTransition();
  const submitting = useRef(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 1279px)");
    const update = () => { setIsMobile(media.matches); if (media.matches) setSelectedId(null); };
    update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (debouncedQuery === data.query) return;
    const params = new URLSearchParams(searchParams.toString());
    if (debouncedQuery) params.set("q", debouncedQuery); else params.delete("q");
    params.set("page", "1");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [data.query, debouncedQuery, pathname, router, searchParams]);
  const selected = useMemo(() => {
    if (selectedId === null) return null;
    return data.rows.find((row) => row.id === selectedId) ?? data.rows[0] ?? null;
  }, [data.rows, selectedId]);
  const setParams = (updates: Record<string, string | null>) => {
    const params = new URLSearchParams(searchParams.toString());
    Object.entries(updates).forEach(([key, value]) => value ? params.set(key, value) : params.delete(key));
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  };
  const openDetail = (row: AdminAccountsReceivableRow) => { setSelectedId(row.id); if (isMobile) setDetailMobile(true); };
  const closeDesktopDetail = () => {
    if (selected) document.getElementById(`cxc-detail-${selected.id}`)?.focus();
    setSelectedId(null);
  };
  const closeMobileDetail = () => { setDetailMobile(false); setSelectedId(null); };
  const canCollect = (row: AdminAccountsReceivableRow) => canMarkPaid && row.status !== "paid" && row.status !== "cancelled" && row.balance_due > 0;
  const openAction = (mode: Exclude<ActionMode, null>) => {
    if (!selected) return;
    submitting.current = false;
    setDetailMobile(false);
    setDraft({ amount: "", method: "", reference: "", receivedAt: today(), note: "", receiptUrl: "", idempotencyKey: recoverIdempotencyKey(selected.id) });
    setActionMode(mode);
  };
  const closeAction = () => { if (!isPending) { setActionMode(null); setDraft(null); if (isMobile) setDetailMobile(true); } };
  const submitAction = () => {
    if (!selected || !draft || submitting.current || !draft.method) { toast.error("Selecciona el método de pago."); return; }
    if (actionMode === "payment") {
      const amount = Math.round(Number(draft.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount <= 0) { toast.error("El abono debe ser mayor que cero."); return; }
      if (amount > selected.balance_due) { toast.error("El abono no puede ser mayor que el saldo pendiente de esta cuenta por cobrar."); return; }
    }
    submitting.current = true;
    if (actionMode === "payment") sessionStorage.setItem(pendingIdempotencyStorageKey(selected.id), draft.idempotencyKey);
    startTransition(async () => {
      const result = actionMode === "payment"
        ? await registerCreditReceivablePaymentAction({ receivableId: selected.id, amount: draft.amount, paymentMethod: draft.method as CommercialCreditPaymentReceivedMethod, paymentReference: draft.reference, receivedAt: draft.receivedAt, note: draft.note, receiptUrl: draft.receiptUrl, idempotencyKey: draft.idempotencyKey })
        : await markCreditReceivablePaidAction({ receivableId: selected.id, paymentMethod: draft.method as CommercialCreditPaymentReceivedMethod, paymentReference: draft.reference });
      submitting.current = false;
      if (result.ok) { if(actionMode === "payment")sessionStorage.removeItem(pendingIdempotencyStorageKey(selected.id)); toast.success(result.message); closeAction(); setDetailMobile(false); router.refresh(); }
      else toast.error(result.message);
    });
  };

  return <div className="space-y-3">
    <AccountsReceivableSummary summary={data.summary} compact />
    {data.truncated ? <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">El universo supera 5,000 cuentas. Acota la búsqueda antes de exportar.</p> : null}
    <section aria-labelledby="accounts-title">
      <div className="mb-2"><h2 id="accounts-title" className="text-2xl font-bold">Cuentas</h2><p className="text-sm text-black/50">Gestiona saldos, vencimientos y abonos.</p></div>
      <div className={`grid min-w-0 gap-3 ${selected ? "xl:grid-cols-[minmax(0,1fr)_clamp(320px,26vw,360px)]" : "grid-cols-1"}`}>
        <div className="min-w-0 rounded-xl border border-black/10 bg-white shadow-sm">
          <div className="space-y-2 border-b border-black/10 p-3">
            <label className="relative block"><span className="sr-only">Buscar cuentas por cobrar</span><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-black/40" size={18}/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar cliente, pedido, factura o referencia" className="min-h-11 w-full rounded-lg border border-black/10 pl-10 pr-3 text-sm focus:border-[#e30613] focus:outline-none"/></label>
            <div className="flex flex-wrap items-center gap-2">
              {(["pending", "partial", "overdue", "paid", "all"] as const).map((filter) => <button key={filter} type="button" onClick={() => setParams({ status: filter, page: "1" })} aria-pressed={data.filter === filter} className={`min-h-11 rounded-lg border px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-[#e30613] ${data.filter === filter ? "border-[#e30613] bg-red-50 text-[#e30613]" : "border-black/10"}`}>{filter === "pending" ? "Pendientes" : filter === "partial" ? "Pago parcial" : filter === "overdue" ? "Vencidos" : filter === "paid" ? "Pagados" : "Todos"}</button>)}
              <label className="ml-auto flex min-h-11 items-center gap-2 rounded-lg border border-black/10 px-3 text-sm"><Filter size={17}/><span className="sr-only">Ordenar cuentas por cobrar</span><select value={`${data.sort}:${data.direction}`} onChange={(event) => { const [sort, direction] = event.target.value.split(":"); setParams({ sort, direction, page: "1" }); }} className="bg-transparent outline-none"><option value="created:desc">Más recientes</option><option value="due:asc">Vencimiento</option><option value="balance:desc">Mayor saldo</option></select></label>
              {canExport ? <details className="relative"><summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg border border-black/10 px-3 text-sm font-semibold"><Download size={17}/> Exportar <ChevronDown size={15}/></summary><div className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-black/10 bg-white p-1 shadow-xl"><ExportLink format="csv" data={data}>CSV para Excel</ExportLink><ExportLink format="xlsx" data={data}>Libro Excel (.xlsx)</ExportLink></div></details> : null}
            </div>
            <p className="text-xs text-black/50">{data.total.toLocaleString("es-HN")} cuentas encontradas</p>
          </div>
          <div role="table" aria-label="Cuentas por cobrar" className="min-w-0">
            <div role="row" className="hidden grid-cols-[minmax(0,1.2fr)_minmax(0,.95fr)_minmax(0,1.1fr)_minmax(112px,1fr)_minmax(0,.9fr)_minmax(0,.8fr)_minmax(0,.8fr)_minmax(94px,.9fr)] gap-2 border-b border-black/10 bg-black/[.025] px-3 py-2 text-xs font-semibold lg:grid"><span role="columnheader" className="min-w-0 truncate">Cliente</span><span role="columnheader" className="min-w-0 truncate">Factura</span><span role="columnheader" className="min-w-0 truncate">Pedido</span><span role="columnheader" className="min-w-0 truncate">Saldo</span><span role="columnheader" className="min-w-0 truncate">Vencimiento</span><span role="columnheader" className="min-w-0 truncate">Estado</span><span role="columnheader" className="min-w-0 truncate">Último abono</span><span role="columnheader" className="min-w-0 truncate">Acción</span></div>
            {data.rows.length ? data.rows.map((row) => {
              const latest = row.payments.filter((payment) => !payment.voided_at).sort((a,b) => b.received_at.localeCompare(a.received_at))[0];
              const active = selected?.id === row.id;
              return <article role="row" key={row.id} className={`relative grid min-h-[170px] grid-cols-2 gap-x-3 gap-y-1 border-b border-black/5 p-3 last:border-0 lg:min-h-0 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,.95fr)_minmax(0,1.1fr)_minmax(112px,1fr)_minmax(0,.9fr)_minmax(0,.8fr)_minmax(0,.8fr)_minmax(94px,.9fr)] lg:items-center lg:gap-2 ${active ? "bg-red-50/80 before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-[#e30613]" : ""}`}>
                <div role="cell" className="col-span-2 min-w-0 overflow-hidden lg:col-span-1"><div className="flex min-w-0 items-center justify-between gap-2 lg:block"><strong className="block min-w-0 truncate" title={row.customer_name}>{row.customer_name}</strong><span className={`shrink-0 rounded-full px-2 py-1 text-xs lg:hidden ${statusClass(row.status)}`}>{statusLabels[row.status]}</span></div></div>
                <div role="cell" className="min-w-0 overflow-hidden break-all text-sm leading-5" title={formatReceivableInvoice(row.invoice_number, row.invoice_status)}><span className="text-xs text-black/45 lg:hidden">Factura </span>{formatReceivableInvoice(row.invoice_number, row.invoice_status)}</div>
                <div role="cell" className="min-w-0 overflow-hidden text-sm"><span className="text-xs text-black/45 lg:hidden">Pedido </span><span className="block min-w-0 truncate" title={row.order_number ?? "Cuenta histórica"}>{row.order_number ?? "Cuenta histórica"}</span></div>
                <div role="cell" className="min-w-0 overflow-hidden whitespace-nowrap"><span className="text-xs text-black/45 lg:hidden">Saldo </span><strong className="tabular-nums">{formatCurrency(row.balance_due)}</strong></div>
                <div role="cell" className="min-w-0 overflow-hidden text-sm"><span className="text-xs text-black/45 lg:hidden">Vence </span>{formatDate(row.due_date)}<p className="text-xs text-black/45">{remaining(row.due_date)} días</p></div>
                <div role="cell" className="hidden min-w-0 overflow-hidden lg:block"><span className={`inline-block max-w-full truncate rounded-full px-2 py-1 align-middle text-xs ${statusClass(row.status)}`} title={statusLabels[row.status]}>{statusLabels[row.status]}</span></div>
                <div role="cell" className="min-w-0 overflow-hidden text-xs text-black/55"><span className="lg:hidden">Último: </span>{latest ? <><strong className="tabular-nums text-black/75">{formatCurrency(latest.amount)}</strong><span className="block truncate" title={methodLabels[latest.payment_method]}>{methodLabels[latest.payment_method]}</span></> : "Sin abonos"}</div>
                <div role="cell" className="flex min-w-0 items-end justify-end overflow-hidden lg:block"><button id={`cxc-detail-${row.id}`} type="button" onClick={() => openDetail(row)} aria-label={`Ver detalle de ${row.customer_name}`} className="inline-flex min-h-11 max-w-full min-w-0 items-center gap-1 font-medium text-[#d5000b] underline underline-offset-2"><span className="truncate">Ver detalle</span><ChevronRight className="shrink-0" size={17}/></button></div>
              </article>;
            }) : <p className="p-8 text-center text-sm text-black/50">No hay cuentas que coincidan con los filtros.</p>}
          </div>
          <Pagination page={data.page} totalPages={data.totalPages} pageSize={data.pageSize} onPage={(page) => setParams({ page: String(page) })} onSize={(size) => setParams({ pageSize: String(size), page: "1" })}/>
        </div>
        {!isMobile && selected ? <ReceivableDetail row={selected} canCollect={canCollect(selected)} onClose={closeDesktopDetail} onPayment={() => openAction("payment")} onMarkPaid={() => openAction("mark-paid")}/> : null}
      </div>
    </section>
    {isMobile && detailMobile && selected ? <AccessibleSheet title="Detalle de cuenta" description={selected.customer_name} onClose={closeMobileDetail} returnFocusId={`cxc-detail-${selected.id}`} footer={<DetailActions rowId={selected.id} canCollect={canCollect(selected)} onPayment={() => openAction("payment")} onMarkPaid={() => openAction("mark-paid")}/>}><ReceivableDetailContent row={selected}/></AccessibleSheet> : null}
    {actionMode && draft && selected ? <AccessibleSheet title={actionMode === "payment" ? "Registrar abono" : "Marcar como pagado"} description={`${selected.customer_name} · Saldo ${formatCurrency(selected.balance_due)}`} onClose={closeAction} returnFocusId={`cxc-${actionMode}-${selected.id}`} footer={<div className="flex gap-2"><Button variant="ghost" onClick={closeAction} disabled={isPending} className="min-h-11 flex-1">Cancelar</Button><Button onClick={submitAction} disabled={isPending} className="min-h-11 flex-1">{isPending ? "Procesando…" : actionMode === "payment" ? "Registrar abono" : "Confirmar pago total"}</Button></div>}><PaymentFields mode={actionMode} draft={draft} setDraft={setDraft}/></AccessibleSheet> : null}
  </div>;
}

function ExportLink({ format, data, children }: { format: "csv"|"xlsx"; data: AdminAccountsReceivablePage; children: React.ReactNode }) {
  const params = new URLSearchParams({ format, status: data.filter, q: data.query, sort: data.sort, direction: data.direction });
  return <a href={`/api/admin/cuentas-por-cobrar/export?${params}`} className="block min-h-11 rounded-md px-3 py-3 text-sm hover:bg-red-50 focus-visible:outline-2 focus-visible:outline-[#e30613]">{children}</a>;
}
function Pagination({ page, totalPages, pageSize, onPage, onSize }: { page:number; totalPages:number; pageSize:number; onPage:(v:number)=>void; onSize:(v:number)=>void }) {
  return <div aria-label="Paginación de cuentas" className="flex flex-wrap items-center justify-between gap-2 border-t border-black/10 p-3"><label className="text-sm"><span className="sr-only">Filas por página</span><select value={pageSize} onChange={(e)=>onSize(Number(e.target.value))} className="min-h-11 rounded-lg border border-black/10 px-2"><option value={10}>10 por página</option><option value={20}>20 por página</option><option value={50}>50 por página</option></select></label><div className="flex items-center gap-1"><button className="min-h-11 rounded-lg border px-3 disabled:opacity-40" disabled={page<=1} onClick={()=>onPage(page-1)}>Anterior</button><span className="px-2 text-sm">{page} de {totalPages}</span><button className="min-h-11 rounded-lg border px-3 disabled:opacity-40" disabled={page>=totalPages} onClick={()=>onPage(page+1)}>Siguiente</button></div></div>;
}
function ReceivableDetail({ row, canCollect, onClose, onPayment, onMarkPaid }: { row:AdminAccountsReceivableRow; canCollect:boolean; onClose:()=>void; onPayment:()=>void; onMarkPaid:()=>void }) {
  return <aside aria-label={`Detalle de ${row.customer_name}`} className="h-fit min-w-0 rounded-xl border border-black/10 bg-white p-4 shadow-sm"><div className="mb-3 flex min-w-0 items-start justify-between gap-2"><div className="min-w-0"><p className="text-sm font-semibold">Detalle de cuenta</p><h3 className="break-words text-lg font-bold">{row.customer_name}</h3></div><button onClick={onClose} className="grid size-11 shrink-0 place-items-center rounded-lg" aria-label="Cerrar detalle de cuenta"><X size={18}/></button></div><ReceivableDetailContent row={row}/><div className="mt-4"><DetailActions rowId={row.id} canCollect={canCollect} onPayment={onPayment} onMarkPaid={onMarkPaid}/></div></aside>;
}
function ReceivableDetailContent({ row }: { row:AdminAccountsReceivableRow }) {
  const payments = [...row.payments].sort((a,b)=>b.received_at.localeCompare(a.received_at));
  const latest=payments[0]??null;
  return <div className="space-y-4"><div className="grid grid-cols-3 divide-x rounded-lg border border-black/10 p-3"><Info label="Saldo pendiente" value={formatCurrency(row.balance_due)} strong/><Info label="Total original" value={formatCurrency(row.original_amount)}/><Info label="Total abonado" value={formatCurrency(row.total_paid)}/></div><dl className="grid grid-cols-2 gap-3 text-sm"><Info label="Factura" value={formatReceivableInvoice(row.invoice_number,row.invoice_status)}/><Info label="Pedido" value={row.order_number??"—"}/><Info label="Vencimiento" value={formatDate(row.due_date)}/><Info label="Días restantes" value={String(remaining(row.due_date))}/><Info label="Cliente" value={row.customer_name}/><Info label="Teléfono" value={row.customer_phone??"—"}/></dl><div><h4 className="mb-2 font-semibold">Último abono</h4>{latest?<PaymentHistoryRow payment={latest}/>:<p className="rounded-lg border p-3 text-sm text-black/45">Sin abonos.</p>}{payments.length?<details className="mt-2 rounded-lg border"><summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-medium text-[#d5000b] underline">Ver historial completo ({payments.length})</summary><div className="max-h-56 space-y-2 overflow-y-auto border-t p-2" tabIndex={0} aria-label="Historial completo de abonos">{payments.map((payment)=><PaymentHistoryRow key={payment.id} payment={payment}/>)}</div></details>:null}</div>{row.payments.some((p)=>p.accounting_trace)?<Link href={`/admin/contabilidad?tab=events&event_search=${encodeURIComponent(row.id)}`} className="block min-h-11 py-3 text-center text-sm font-medium text-black/55 underline">Ver trazabilidad contable</Link>:null}</div>;
}
function PaymentHistoryRow({payment}:{payment:AdminAccountsReceivableRow["payments"][number]}) { return <article className={`rounded-lg border p-3 text-sm ${payment.voided_at?"bg-black/[.03] text-black/50":""}`}><div className="flex justify-between gap-2"><strong>{formatHnDateTime(payment.received_at)}</strong><strong className={payment.voided_at?"line-through":"text-emerald-700"}>{formatCurrency(payment.amount)}</strong></div><p className="text-xs">{methodLabels[payment.payment_method]}{payment.reference?` · ${payment.reference}`:""}{payment.voided_at?" · Anulado":""}</p>{payment.balance_before!==null&&payment.balance_after!==null?<p className="mt-1 text-xs text-black/55">Saldo: {formatCurrency(payment.balance_before)} → {formatCurrency(payment.balance_after)}</p>:null}<p className="mt-1 text-xs text-black/45">Registrado por {payment.recorded_by_name??payment.recorded_by_email??"No registrado"}</p></article>; }
function Info({label,value,strong=false}:{label:string;value:string;strong?:boolean}) { return <div className="min-w-0 px-2 first:pl-0 last:pr-0"><dt className="text-xs text-black/45">{label}</dt><dd className={`${strong?"text-xl font-bold":"font-medium"} break-words tabular-nums`}>{value}</dd></div>; }
function DetailActions({rowId,canCollect,onPayment,onMarkPaid}:{rowId:string;canCollect:boolean;onPayment:()=>void;onMarkPaid:()=>void}) { return <div className="grid grid-cols-2 gap-2"><Button id={`cxc-payment-${rowId}`} onClick={onPayment} disabled={!canCollect} className="min-h-11"><PlusCircle size={17}/> Registrar abono</Button><Button id={`cxc-mark-paid-${rowId}`} variant="ghost" onClick={onMarkPaid} disabled={!canCollect} className="min-h-11"><CheckCircle2 size={17}/> Marcar como pagado</Button></div>; }
function PaymentFields({mode,draft,setDraft}:{mode:Exclude<ActionMode,null>;draft:Draft;setDraft:(v:Draft)=>void}) { return <div className="space-y-4">{mode==="payment"?<label className="block text-sm font-medium">Monto del abono<input type="number" min="0.01" step="0.01" value={draft.amount} onChange={(e)=>setDraft({...draft,amount:e.target.value})} className="mt-1 min-h-11 w-full rounded-lg border px-3" autoFocus required/></label>:<p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">Esta acción registrará el saldo completo como pagado. Confirma el método y la referencia antes de continuar.</p>}<label className="block text-sm font-medium">Método de pago<select value={draft.method} onChange={(e)=>setDraft({...draft,method:e.target.value as Draft["method"]})} className="mt-1 min-h-11 w-full rounded-lg border px-3" required><option value="">Seleccionar</option><option value="cash">Efectivo</option><option value="bank_transfer">Transferencia bancaria</option><option value="card">Tarjeta</option></select></label><label className="block text-sm font-medium">Referencia<input value={draft.reference} maxLength={200} onChange={(e)=>setDraft({...draft,reference:e.target.value})} className="mt-1 min-h-11 w-full rounded-lg border px-3"/></label>{mode==="payment"?<><label className="block text-sm font-medium">Fecha de recepción<input type="date" value={draft.receivedAt} onChange={(e)=>setDraft({...draft,receivedAt:e.target.value})} className="mt-1 min-h-11 w-full rounded-lg border px-3" required/></label><label className="block text-sm font-medium">Nota<textarea value={draft.note} maxLength={1000} onChange={(e)=>setDraft({...draft,note:e.target.value})} className="mt-1 min-h-24 w-full rounded-lg border p-3"/></label><details className="rounded-lg border p-3"><summary className="cursor-pointer text-sm font-medium">Comprobante opcional</summary><label className="mt-3 block text-sm">URL del comprobante<input type="url" value={draft.receiptUrl} maxLength={1000} onChange={(e)=>setDraft({...draft,receiptUrl:e.target.value})} className="mt-1 min-h-11 w-full rounded-lg border px-3"/></label></details></>:null}</div>; }
