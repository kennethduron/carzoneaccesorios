import Link from "next/link";
import { ArrowLeft, Calculator, CheckCircle2, FileText, RefreshCw, RotateCcw } from "lucide-react";
import { buildJournalEntryViewerHref } from "@/lib/accounting-navigation";
import type { AccountingTaxAccountingStatus, AccountingTaxReportDocumentType, AccountingTaxReportPage, AccountingTaxReportSummary } from "@/types/accounting-tax-report";
import { formatSqlDateHn } from "@/utils/honduras-date";
import { formatCurrency } from "@/utils/pricing";

type ReportQuery = {
  from: string;
  to: string;
  saleSearch: string;
  purchaseSearch: string;
  salePage: number;
  purchasePage: number;
  pageSize: 20 | 50;
};

const documentStatusLabels: Record<string, string> = {
  emitida: "Emitida",
  issued: "Emitida",
  paid: "Pagada",
  received: "Recibida",
  posted_to_ap: "Registrada en CxP",
};

const accountingLabels: Record<AccountingTaxAccountingStatus, string> = {
  accounted: "Contabilizada",
  pending: "Pendiente",
  reversed: "Reversada",
};

function queryHref(query: ReportQuery, changes: Partial<ReportQuery>) {
  const next = { ...query, ...changes };
  const params = new URLSearchParams({
    from: next.from,
    to: next.to,
    pageSize: String(next.pageSize),
  });
  if (next.saleSearch) params.set("saleSearch", next.saleSearch);
  if (next.purchaseSearch) params.set("purchaseSearch", next.purchaseSearch);
  if (next.salePage > 1) params.set("salePage", String(next.salePage));
  if (next.purchasePage > 1) params.set("purchasePage", String(next.purchasePage));
  return `/admin/contabilidad/impuestos?${params.toString()}`;
}

function Metric({ label, value, prominent = false, negative = false }: { label: string; value: number; prominent?: boolean; negative?: boolean }) {
  return (
    <article className={`rounded-xl border p-4 shadow-sm ${prominent ? "border-[#e4252c]/30 bg-[#fff5f5]" : "border-black/10 bg-white"}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-black/50">{label}</p>
      <p className={`mt-2 font-semibold tabular-nums ${prominent ? "text-2xl text-[#d71920]" : negative ? "text-xl text-[#b91c25]" : "text-xl text-[#080808]"}`}>
        {formatCurrency(value)}
      </p>
    </article>
  );
}

function AccountingBadge({ status }: { status: AccountingTaxAccountingStatus }) {
  const styles = status === "accounted"
    ? "bg-emerald-50 text-emerald-700"
    : status === "reversed"
      ? "bg-rose-50 text-rose-700"
      : "bg-amber-50 text-amber-800";
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${styles}`}>{accountingLabels[status]}</span>;
}

function Pagination({ type, pageData, query }: { type: AccountingTaxReportDocumentType; pageData: AccountingTaxReportPage; query: ReportQuery }) {
  const totalPages = Math.max(1, Math.ceil(pageData.total / pageData.pageSize));
  const pageKey = type === "sale" ? "salePage" : "purchasePage";
  const previous = queryHref(query, { [pageKey]: Math.max(1, pageData.page - 1) });
  const next = queryHref(query, { [pageKey]: Math.min(totalPages, pageData.page + 1) });
  return (
    <div className="flex flex-col gap-3 border-t border-black/10 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
      <p className="text-black/55">{pageData.total.toLocaleString("es-HN")} documentos · Página {pageData.page} de {totalPages}</p>
      <div className="flex gap-2">
        <Link aria-disabled={pageData.page <= 1} tabIndex={pageData.page <= 1 ? -1 : undefined} className={`inline-flex min-h-11 items-center rounded-lg border px-4 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2 ${pageData.page <= 1 ? "pointer-events-none border-black/5 bg-black/[0.03] text-black/30" : "border-black/10 hover:bg-black/[0.03]"}`} href={previous}>Anterior</Link>
        <Link aria-disabled={pageData.page >= totalPages} tabIndex={pageData.page >= totalPages ? -1 : undefined} className={`inline-flex min-h-11 items-center rounded-lg border px-4 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2 ${pageData.page >= totalPages ? "pointer-events-none border-black/5 bg-black/[0.03] text-black/30" : "border-black/10 hover:bg-black/[0.03]"}`} href={next}>Siguiente</Link>
      </div>
    </div>
  );
}

function DocumentSection({ type, pageData, query }: { type: AccountingTaxReportDocumentType; pageData: AccountingTaxReportPage; query: ReportQuery }) {
  const sale = type === "sale";
  const searchName = sale ? "saleSearch" : "purchaseSearch";
  const title = sale ? "Facturas de venta" : "Facturas de proveedores";
  const empty = sale ? "No hay facturas de venta registradas en este período." : "No hay facturas de proveedor registradas en este período.";
  return (
    <section className="overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-black/10 p-4 sm:flex-row sm:items-end sm:justify-between">
        <div><h2 className="text-lg font-semibold">{title}</h2><p className="mt-1 text-sm text-black/50">Documentos vigentes que componen el cálculo.</p></div>
        <form className="flex w-full flex-col gap-2 sm:max-w-xl sm:flex-row" method="get">
          <input type="hidden" name="from" value={query.from} /><input type="hidden" name="to" value={query.to} />
          <input type="hidden" name={sale ? "purchaseSearch" : "saleSearch"} value={sale ? query.purchaseSearch : query.saleSearch} />
          <label className="sr-only" htmlFor={`${type}-search`}>Buscar en {title.toLowerCase()}</label>
          <input id={`${type}-search`} name={searchName} defaultValue={pageData.search} maxLength={100} placeholder={sale ? "Buscar factura o cliente" : "Buscar factura o proveedor"} className="min-h-11 min-w-0 flex-1 rounded-lg border border-black/15 px-3 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15" />
          <label className="sr-only" htmlFor={`${type}-page-size`}>Documentos por página</label>
          <select id={`${type}-page-size`} name="pageSize" defaultValue={query.pageSize} className="min-h-11 rounded-lg border border-black/15 bg-white px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2"><option value="20">20</option><option value="50">50</option></select>
          <button className="min-h-11 rounded-lg bg-[#111] px-4 text-sm font-semibold text-white hover:bg-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2" type="submit">Buscar</button>
        </form>
      </div>
      {pageData.rows.length === 0 ? <p className="p-8 text-center text-sm text-black/50">{empty}</p> : (
        <>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="bg-black/[0.03] text-xs uppercase tracking-wide text-black/50"><tr><th className="px-4 py-3">Factura</th><th className="px-4 py-3">Fecha</th><th className="px-4 py-3">{sale ? "Cliente" : "Proveedor"}</th><th className="px-4 py-3 text-right">ISV</th><th className="px-4 py-3 text-right">Total</th><th className="px-4 py-3">Estado</th><th className="px-4 py-3">Contabilidad</th></tr></thead>
              <tbody className="divide-y divide-black/10">{pageData.rows.map((row) => <tr key={row.documentId} className="align-middle"><td className="px-4 py-3 font-semibold">{row.documentNumber}</td><td className="px-4 py-3 whitespace-nowrap">{formatSqlDateHn(row.documentDate)}</td><td className="max-w-64 px-4 py-3 break-words">{row.counterpartyName}</td><td className="px-4 py-3 text-right tabular-nums">{formatCurrency(row.taxAmount)}</td><td className="px-4 py-3 text-right font-semibold tabular-nums">{formatCurrency(row.totalAmount)}</td><td className="px-4 py-3">{documentStatusLabels[row.status] ?? "Vigente"}</td><td className="px-4 py-3"><div className="flex items-center gap-2"><AccountingBadge status={row.accountingStatus} />{row.journalEntryId ? <Link className="rounded-sm font-semibold text-[#b91c25] underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2" href={buildJournalEntryViewerHref(row.journalEntryId)}>Ver partida</Link> : null}</div></td></tr>)}</tbody>
            </table>
          </div>
          <div className="divide-y divide-black/10 md:hidden">{pageData.rows.map((row) => <article key={row.documentId} className="space-y-3 p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-semibold break-words">{row.documentNumber}</p><p className="text-sm text-black/50">{formatSqlDateHn(row.documentDate)}</p></div><AccountingBadge status={row.accountingStatus} /></div><p className="break-words text-sm">{row.counterpartyName}</p><dl className="grid grid-cols-2 gap-3 rounded-lg bg-black/[0.03] p-3 text-sm"><div><dt className="text-black/50">ISV</dt><dd className="font-semibold tabular-nums">{formatCurrency(row.taxAmount)}</dd></div><div className="text-right"><dt className="text-black/50">Total</dt><dd className="font-semibold tabular-nums">{formatCurrency(row.totalAmount)}</dd></div></dl><div className="flex min-h-11 items-center justify-between gap-2 text-sm"><span>{documentStatusLabels[row.status] ?? "Vigente"}</span>{row.journalEntryId ? <Link className="rounded-sm font-semibold text-[#b91c25] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2" href={buildJournalEntryViewerHref(row.journalEntryId)}>Ver partida</Link> : null}</div></article>)}</div>
          <Pagination type={type} pageData={pageData} query={query} />
        </>
      )}
    </section>
  );
}

export function AccountingTaxReport({ summary, sales, purchases, query }: { summary: AccountingTaxReportSummary; sales: AccountingTaxReportPage; purchases: AccountingTaxReportPage; query: ReportQuery }) {
  const noPayment = summary.amountToPay === 0;
  return (
    <main className="min-h-screen overflow-x-hidden bg-[#f7f7f8] px-4 py-5 text-[#080808] sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1400px] space-y-4">
        <header className="rounded-xl border border-black/10 bg-white p-4 shadow-sm sm:p-5">
          <Link href="/admin/contabilidad" className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-black/10 px-3 text-sm font-semibold hover:bg-black/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2"><ArrowLeft size={17} /> Centro financiero</Link>
          <div className="mt-4"><p className="text-xs font-semibold uppercase tracking-wide text-[#b91c25]">Contabilidad</p><h1 className="mt-1 text-2xl font-semibold sm:text-3xl">Reporte de impuestos</h1><p className="mt-1 max-w-3xl text-sm leading-6 text-black/55">Consulte los impuestos registrados en ventas y compras para el período seleccionado.</p></div>
        </header>

        <section className="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
          <form className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end" method="get">
            <label className="text-sm font-semibold">Desde<input className="mt-1 block min-h-11 w-full rounded-lg border border-black/15 px-3 font-normal outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15" type="date" name="from" required defaultValue={query.from} /></label>
            <label className="text-sm font-semibold">Hasta<input className="mt-1 block min-h-11 w-full rounded-lg border border-black/15 px-3 font-normal outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15" type="date" name="to" required defaultValue={query.to} /></label>
            <button className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#e4252c] px-5 font-semibold text-white hover:bg-[#c91d24] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e4252c] focus-visible:ring-offset-2" type="submit"><Calculator size={18} />Calcular</button>
          </form>
        </section>

        <section aria-label="Resumen de impuestos" aria-live="polite" className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Metric label="ISV en ventas" value={summary.salesTax} /><Metric label="ISV en compras" value={summary.purchaseTax} /><Metric label="Diferencia" value={summary.taxDifference} negative={summary.taxDifference < 0} /><Metric label="Total a pagar" value={summary.amountToPay} prominent /></div>
          <div className="rounded-xl border border-black/10 bg-white p-4 shadow-sm"><p className="font-semibold tabular-nums">{formatCurrency(summary.salesTax)} − {formatCurrency(summary.purchaseTax)} = {formatCurrency(summary.taxDifference)}</p><p className="mt-1 text-sm text-black/55">Calculado con la información registrada en Car Zone para el período seleccionado.</p>{noPayment ? <p className="mt-2 text-sm font-medium text-emerald-700">No hay un monto a pagar para este período según los registros del sistema.</p> : null}</div>
        </section>

        <section className="grid gap-3 rounded-xl border border-black/10 bg-white p-4 shadow-sm sm:grid-cols-2 lg:grid-cols-4" aria-label="Estado contable">
          <p className="flex items-center gap-2 text-sm"><CheckCircle2 className="text-emerald-600" size={18} /> Ventas contabilizadas: <strong>{summary.salesAccountedCount}</strong></p>
          <p className="flex items-center gap-2 text-sm"><RefreshCw className="text-amber-600" size={18} /> Ventas pendientes: <strong>{summary.salesPendingAccountingCount}</strong></p>
          <p className="flex items-center gap-2 text-sm"><CheckCircle2 className="text-emerald-600" size={18} /> Compras contabilizadas: <strong>{summary.purchaseAccountedCount}</strong></p>
          <p className="flex items-center gap-2 text-sm"><RefreshCw className="text-amber-600" size={18} /> Compras pendientes: <strong>{summary.purchasePendingAccountingCount}</strong></p>
          {(summary.salesReversedAccountingCount + summary.purchaseReversedAccountingCount) > 0 ? <p className="flex items-center gap-2 text-sm"><RotateCcw size={18} /> Referencias reversadas: <strong>{summary.salesReversedAccountingCount + summary.purchaseReversedAccountingCount}</strong></p> : null}
          {summary.purchasesWithoutSupplierInvoiceCount > 0 ? <p className="flex items-center gap-2 text-sm text-black/60"><FileText size={18} /> Compras sin factura de proveedor registrada: <strong>{summary.purchasesWithoutSupplierInvoiceCount}</strong></p> : null}
          {summary.excludedCurrencyCount > 0 ? <p className="text-sm text-amber-800">Documentos en otra moneda no incluidos: <strong>{summary.excludedCurrencyCount}</strong></p> : null}
        </section>

        <DocumentSection type="sale" pageData={sales} query={query} />
        <DocumentSection type="purchase" pageData={purchases} query={query} />
      </div>
    </main>
  );
}
