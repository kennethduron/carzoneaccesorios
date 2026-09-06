import Link from "next/link";
import { AlertTriangle, CalendarDays, FileText, TrendingUp, Users } from "lucide-react";
import type { ReceivablesSummary } from "@/types/credit";
import { formatCurrency } from "@/utils/pricing";

function date(value: string) {
  return new Intl.DateTimeFormat("es-HN", { day: "2-digit", month: "short", year: "numeric", timeZone: "America/Tegucigalpa" })
    .format(new Date(`${value}T12:00:00-06:00`));
}

export function AccountsReceivableSummary({ summary, compact = false }: { summary: ReceivablesSummary; compact?: boolean }) {
  const metrics = [
    ["Cartera total pendiente", formatCurrency(summary.totalPending), FileText, "red"],
    ["Cartera vencida", formatCurrency(summary.overdueBalance), AlertTriangle, "red"],
    ["Cobrado hoy", formatCurrency(summary.collectedToday), TrendingUp, "green"],
    ["Cobrado este mes", formatCurrency(summary.collectedThisMonth), TrendingUp, "blue"],
    ["Clientes con deuda", String(summary.customersWithDebt), Users, "blue"],
    ["Cuentas vencidas", String(summary.overdue), FileText, "red"],
    ["Vencen en 7 días", String(summary.dueInSevenDays), CalendarDays, "red"],
  ] as const;
  return (
    <section aria-labelledby="cxc-summary-title" className="space-y-3">
      <h2 id="cxc-summary-title" className="sr-only">Resumen de cuentas por cobrar</h2>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
        {metrics.map(([label, value, Icon, tone], index) => (
          <article key={label} className={`${compact && index > 4 ? "hidden md:block" : ""} min-w-0 rounded-xl border border-black/10 bg-white p-3 shadow-sm`}>
            <div className="flex items-center gap-3">
              <span className={`grid size-10 shrink-0 place-items-center rounded-full ${tone === "red" ? "bg-red-50 text-[#e30613]" : tone === "green" ? "bg-emerald-50 text-emerald-600" : "bg-blue-50 text-blue-600"}`}><Icon size={19}/></span>
              <div className="min-w-0"><p className="text-xs leading-4 text-black/55">{label}</p><p className="mt-0.5 truncate text-lg font-bold tabular-nums">{value}</p></div>
            </div>
          </article>
        ))}
      </div>
      {compact ? <Link href="/admin/cuentas-por-cobrar?section=summary" className="flex min-h-11 items-center justify-end rounded-xl border border-black/10 bg-white px-4 text-sm font-medium text-[#d5000b] underline md:hidden">Ver resumen completo</Link> : null}
      <div className="grid gap-3 lg:grid-cols-2">
        <article className="rounded-xl border border-black/10 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-black/10 px-4 py-3 font-semibold"><CalendarDays size={18} className="text-[#e30613]"/> Próximos vencimientos</div>
          <div className="divide-y divide-black/5 px-4">
            {summary.upcomingReceivables.length ? summary.upcomingReceivables.map((row) => <div key={row.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 py-2 text-sm"><div className="min-w-0"><p className="truncate font-medium">{row.customerName}</p><p className="truncate text-xs text-black/50">{row.orderNumber ?? "Sin pedido"} · {date(row.dueDate)}</p></div><strong className="tabular-nums">{formatCurrency(row.balanceDue)}</strong></div>) : <p className="py-4 text-sm text-black/50">No hay vencimientos próximos.</p>}
          </div>
        </article>
        <article className="rounded-xl border border-black/10 bg-white shadow-sm">
          <div className="flex items-center gap-2 border-b border-black/10 px-4 py-3 font-semibold"><TrendingUp size={18} className="text-[#e30613]"/> Clientes con mayor saldo pendiente</div>
          <ol className="divide-y divide-black/5 px-4">
            {summary.topDebtors.length ? summary.topDebtors.map((row, index) => <li key={row.customerId} className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-2 py-2 text-sm"><span className="grid size-6 place-items-center rounded-full bg-[#e30613] text-xs font-bold text-white">{index + 1}</span><span className="truncate">{row.customerName}</span><strong className="tabular-nums">{formatCurrency(row.balanceDue)}</strong></li>) : <li className="py-4 text-sm text-black/50">No hay saldos pendientes.</li>}
          </ol>
        </article>
      </div>
    </section>
  );
}
