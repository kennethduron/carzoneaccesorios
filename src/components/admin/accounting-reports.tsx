import Link from "next/link";
import { ArrowLeft, FileSpreadsheet, FileText, Printer, Search } from "lucide-react";
import { PaginationControls } from "@/components/admin/pagination-controls";
import { Input } from "@/components/ui";
import { buildAccountingReportParams } from "@/services/supabase/accounting-reports.service";
import type { AccountingAccountType } from "@/types/accounting";
import type { AccountingReportFilters, BalanceSheetReportData, FinancialStatementSection, GeneralLedgerReportData, IncomeStatementReportData, TrialBalanceReportData } from "@/types/accounting-reports";
import { formatHnDate, formatHnDateTime } from "@/utils/format";
import { formatCurrency } from "@/utils/pricing";

const accountTypeLabels: Record<AccountingAccountType | "all", string> = {
  all: "Todos",
  asset: "Activo",
  liability: "Pasivo",
  equity: "Patrimonio",
  revenue: "Ingresos",
  cost: "Costos",
  expense: "Gastos",
};

const normalBalanceLabels = {
  debit: "Deudor",
  credit: "Acreedor",
};

function filterParams(filters: AccountingReportFilters) {
  return {
    period: filters.periodId,
    startDate: filters.startDate,
    endDate: filters.endDate,
    account: filters.accountId,
    accountType: filters.accountType,
    search: filters.search,
    pageSize: filters.pageSize,
  };
}

function exportHref(basePath: string, filters: AccountingReportFilters, format: "pdf" | "excel") {
  const params = buildAccountingReportParams(filters);
  return `${basePath}/${format}${params ? `?${params}` : ""}`;
}

function ReportHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <header className="mb-6 flex flex-col gap-4 rounded-lg border border-black/10 bg-white p-5 shadow-sm sm:p-6 lg:flex-row lg:items-center lg:justify-between">
      <div className="min-w-0">
        <div className="mb-3">
          <Link href="/admin" className="inline-flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-semibold text-black/70 transition-colors hover:border-[#e4252c]/35 hover:bg-[#fff1f2] hover:text-[#b91c25]">
            <ArrowLeft size={16} />
            Panel administrativo
          </Link>
        </div>
        <p className="text-sm font-semibold uppercase text-[#b91c25]">{eyebrow}</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-normal sm:text-4xl">{title}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-black/55">{description}</p>
      </div>
      <div className="rounded-lg border border-black/10 bg-[#fafafa] px-4 py-3 text-sm text-black/60">
        <span className="font-semibold text-black">Base:</span> partidas publicadas
      </div>
    </header>
  );
}

function ReportFilters({ data, basePath }: { data: Pick<GeneralLedgerReportData | TrialBalanceReportData, "filters" | "options">; basePath: string }) {
  const { filters, options } = data;
  return (
    <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <Search size={18} />
        <h2 className="font-semibold">Filtros</h2>
      </div>
      <form action={basePath} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <Field label="Período contable">
          <select name="period" defaultValue={filters.periodId} className="h-10 w-full rounded-md border border-black/10 bg-white px-3 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15">
            <option value="">Rango manual</option>
            {options.periods.map((period) => (
              <option key={period.id} value={period.id}>{period.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Fecha inicial">
          <Input name="startDate" type="date" defaultValue={filters.startDate} />
        </Field>
        <Field label="Fecha final">
          <Input name="endDate" type="date" defaultValue={filters.endDate} />
        </Field>
        <Field label="Tipo de cuenta">
          <select name="accountType" defaultValue={filters.accountType} className="h-10 w-full rounded-md border border-black/10 bg-white px-3 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15">
            {Object.entries(accountTypeLabels).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </Field>
        <Field label="Cuenta">
          <select name="account" defaultValue={filters.accountId} className="h-10 w-full rounded-md border border-black/10 bg-white px-3 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15">
            <option value="">Primera cuenta disponible</option>
            {options.accounts.map((account) => (
              <option key={account.id} value={account.id}>{account.code} - {account.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Estado">
          <select name="status" defaultValue="publicada" disabled className="h-10 w-full rounded-md border border-black/10 bg-[#f4f4f5] px-3 text-sm text-black/60 outline-none">
            <option value="publicada">Solo publicadas</option>
          </select>
        </Field>
        <Field label="Búsqueda">
          <Input name="search" defaultValue={filters.search} placeholder="Cuenta o descripción" />
        </Field>
        <div className="grid gap-2 sm:flex sm:items-end xl:col-span-2">
          <button type="submit" className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#080808] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#1f1f1f]">
            <Search size={16} />
            Filtrar
          </button>
          <Link href={basePath} className="inline-flex h-10 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm font-semibold text-[#080808] transition-colors hover:bg-[#f4f4f5]">
            Limpiar
          </Link>
        </div>
      </form>
    </section>
  );
}

function ExportPanel({ canExport, pdfHref, excelHref }: { canExport: boolean; pdfHref: string; excelHref: string }) {
  return (
    <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="font-semibold">Exportaciones</p>
          <p className="mt-1 text-sm leading-6 text-black/55">PDF y Excel se generan desde los mismos datos contables publicados del reporte filtrado. No se exporta CSV en esta fase.</p>
        </div>
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <a href={excelHref} aria-disabled={!canExport} className={`inline-flex items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-semibold ${canExport ? "border-black/10 bg-white text-[#080808] hover:border-[#e4252c]/35 hover:bg-[#fff1f2]" : "pointer-events-none border-black/10 bg-[#f4f4f5] text-black/35"}`}>
            <FileSpreadsheet size={16} />
            Exportar Excel
          </a>
          <a href={pdfHref} aria-disabled={!canExport} className={`inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold ${canExport ? "bg-[#080808] text-white hover:bg-[#1f1f1f]" : "pointer-events-none bg-[#f4f4f5] text-black/35"}`}>
            <Printer size={16} />
            Exportar PDF
          </a>
        </div>
      </div>
      {!canExport ? <p className="mt-3 text-sm text-[#7c2d12]">Tu rol puede revisar reportes contables, pero no exportarlos.</p> : null}
    </section>
  );
}

export function GeneralLedgerReport({ data, canExport }: { data: GeneralLedgerReportData; canExport: boolean }) {
  const section = data.section;
  const totalPages = Math.max(1, Math.ceil(data.totalMovements / data.pageSize));
  return (
    <main className="min-h-screen bg-[#f7f7f8] px-4 py-5 text-[#080808] sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1500px] space-y-5">
        <ReportHeader eyebrow="Finanzas" title="Libro Mayor" description="Consulta read-only de movimientos contables por cuenta, calculada exclusivamente desde partidas publicadas y sus líneas contables." />
        <ReportFilters data={data} basePath="/admin/libro-mayor" />
        <ExportPanel canExport={canExport} pdfHref={exportHref("/api/admin/contabilidad/libro-mayor", data.filters, "pdf")} excelHref={exportHref("/api/admin/contabilidad/libro-mayor", data.filters, "excel")} />

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Metric label="Período" value={data.periodLabel} />
          <Metric label="Cuenta" value={data.account ? `${data.account.code} - ${data.account.name}` : "Sin cuenta"} />
          <Metric label="Movimientos" value={data.totalMovements.toLocaleString("es-HN")} />
          <Metric label="Generado" value={formatHnDateTime(data.generatedAt)} />
        </section>

        {section ? (
          <section className="overflow-hidden rounded-lg border border-black/10 bg-white shadow-sm">
            <div className="border-b border-black/10 p-4 sm:p-5">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <p className="text-sm text-black/50">{accountTypeLabels[section.account.type]} · saldo normal {normalBalanceLabels[section.account.normal_balance]}</p>
                  <h2 className="mt-1 break-words text-xl font-semibold">{section.account.code} - {section.account.name}</h2>
                </div>
                <div className="grid gap-2 text-sm sm:grid-cols-3 lg:min-w-[520px]">
                  <SmallTotal label="Saldo inicial" value={formatCurrency(section.openingBalance)} />
                  <SmallTotal label="Débitos" value={formatCurrency(section.totalDebit)} />
                  <SmallTotal label="Créditos" value={formatCurrency(section.totalCredit)} />
                </div>
              </div>
            </div>

            <div className="grid gap-3 p-3 md:hidden">
              {section.movements.map((movement) => (
                <article key={movement.id} className="rounded-md border border-black/10 bg-white p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold">{movement.journalNumber}</p>
                      <p className="text-xs text-black/50">{formatHnDate(movement.date)} · {movement.reference}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-[#f4f4f5] px-2 py-1 text-xs font-semibold">{formatCurrency(movement.runningBalance)}</span>
                  </div>
                  <p className="mt-2 text-sm text-black/65">{movement.description}</p>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                    <InfoBox label="Débito" value={formatCurrency(movement.debit)} />
                    <InfoBox label="Crédito" value={formatCurrency(movement.credit)} />
                  </dl>
                </article>
              ))}
              {section.movements.length === 0 ? <EmptyState text="No hay movimientos publicados para este filtro." /> : null}
            </div>

            <div className="hidden max-w-full overflow-x-auto md:block">
              <table className="w-full min-w-[1180px] text-left text-sm">
                <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
                  <tr>
                    <th className="px-3 py-3">Fecha</th>
                    <th className="px-3 py-3">Partida</th>
                    <th className="px-3 py-3">Referencia</th>
                    <th className="px-3 py-3">Descripción</th>
                    <th className="px-3 py-3 text-right">Débito</th>
                    <th className="px-3 py-3 text-right">Crédito</th>
                    <th className="px-3 py-3 text-right">Saldo</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/10">
                  {section.movements.map((movement) => (
                    <tr key={movement.id}>
                      <td className="px-3 py-3">{formatHnDate(movement.date)}</td>
                      <td className="px-3 py-3 font-semibold">{movement.journalNumber}</td>
                      <td className="px-3 py-3">{movement.reference}</td>
                      <td className="px-3 py-3">{movement.description}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(movement.debit)}</td>
                      <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(movement.credit)}</td>
                      <td className="px-3 py-3 text-right font-semibold tabular-nums">{formatCurrency(movement.runningBalance)}</td>
                    </tr>
                  ))}
                  {section.movements.length === 0 ? (
                    <tr><td colSpan={7} className="px-3 py-6 text-center text-black/55">No hay movimientos publicados para este filtro.</td></tr>
                  ) : null}
                </tbody>
                <tfoot className="border-t border-black/10 bg-[#fafafa] font-semibold">
                  <tr>
                    <td colSpan={4} className="px-3 py-3">Totales y saldo final de la página</td>
                    <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(section.totalDebit)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(section.totalCredit)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(section.closingBalance)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        ) : <EmptyState text="No hay cuentas contables disponibles para los filtros seleccionados." />}

        <PaginationControls basePath="/admin/libro-mayor" page={data.page} pageSize={data.pageSize} total={data.totalMovements} label="movimientos publicados" params={filterParams(data.filters)} />
        <p className="text-center text-xs text-black/45">Página {data.page.toLocaleString("es-HN")} de {totalPages.toLocaleString("es-HN")}. Vista de borradores deshabilitada en 2H-1.</p>
      </div>
    </main>
  );
}

export function TrialBalanceReport({ data, canExport }: { data: TrialBalanceReportData; canExport: boolean }) {
  return (
    <main className="min-h-screen bg-[#f7f7f8] px-4 py-5 text-[#080808] sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1500px] space-y-5">
        <ReportHeader eyebrow="Finanzas" title="Balance de Comprobación" description="Resumen read-only de débitos, créditos y saldos finales por cuenta, calculado exclusivamente desde partidas publicadas." />
        <ReportFilters data={data} basePath="/admin/balance-comprobacion" />
        <ExportPanel canExport={canExport} pdfHref={exportHref("/api/admin/contabilidad/balance-comprobacion", data.filters, "pdf")} excelHref={exportHref("/api/admin/contabilidad/balance-comprobacion", data.filters, "excel")} />

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Metric label="Período" value={data.periodLabel} />
          <Metric label="Cuentas" value={data.rows.length.toLocaleString("es-HN")} />
          <Metric label="Débitos" value={formatCurrency(data.totalDebit)} />
          <Metric label="Créditos" value={formatCurrency(data.totalCredit)} />
          <div className={`rounded-lg border p-4 shadow-sm ${data.balanced ? "border-[#2f6f3e]/20 bg-[#edf7ed] text-[#2f6f3e]" : "border-[#e4252c]/20 bg-[#fff1f2] text-[#b91c25]"}`}>
            <p className="text-sm opacity-80">Validación</p>
            <p className="mt-1 text-xl font-semibold">{data.balanced ? "Balance correcto" : "Descuadre contable"}</p>
            <p className="mt-1 text-sm">Diferencia {formatCurrency(data.difference)}</p>
          </div>
        </section>

        <section className="overflow-hidden rounded-lg border border-black/10 bg-white shadow-sm">
          <div className="flex flex-col gap-2 border-b border-black/10 p-4 sm:p-5 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="flex items-center gap-2"><FileText size={18} /><h2 className="font-semibold">Cuentas contables</h2></div>
              <p className="mt-1 text-sm text-black/55">Ordenado por código de cuenta.</p>
            </div>
            <p className="text-sm font-semibold text-black/55">Generado {formatHnDateTime(data.generatedAt)}</p>
          </div>

          <div className="grid gap-3 p-3 md:hidden">
            {data.rows.map((row) => (
              <article key={row.account.id} className="rounded-md border border-black/10 bg-white p-3">
                <p className="font-semibold">{row.account.code} - {row.account.name}</p>
                <p className="mt-1 text-xs text-black/50">{accountTypeLabels[row.account.type]} · saldo {normalBalanceLabels[row.normalBalance]}</p>
                <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <InfoBox label="Débito" value={formatCurrency(row.debit)} />
                  <InfoBox label="Crédito" value={formatCurrency(row.credit)} />
                  <InfoBox label="Saldo final" value={formatCurrency(row.endingBalance)} wide />
                </dl>
              </article>
            ))}
            {data.rows.length === 0 ? <EmptyState text="No hay cuentas con saldo o movimientos para este filtro." /> : null}
          </div>

          <div className="hidden max-w-full overflow-x-auto md:block">
            <table className="w-full min-w-[920px] text-left text-sm">
              <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
                <tr>
                  <th className="px-3 py-3">Código</th>
                  <th className="px-3 py-3">Cuenta</th>
                  <th className="px-3 py-3">Tipo</th>
                  <th className="px-3 py-3 text-right">Débito</th>
                  <th className="px-3 py-3 text-right">Crédito</th>
                  <th className="px-3 py-3 text-right">Saldo final</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-black/10">
                {data.rows.map((row) => (
                  <tr key={row.account.id}>
                    <td className="px-3 py-3 font-semibold">{row.account.code}</td>
                    <td className="px-3 py-3">{row.account.name}</td>
                    <td className="px-3 py-3">{accountTypeLabels[row.account.type]}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(row.debit)}</td>
                    <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(row.credit)}</td>
                    <td className="px-3 py-3 text-right font-semibold tabular-nums">{formatCurrency(row.endingBalance)}</td>
                  </tr>
                ))}
                {data.rows.length === 0 ? <tr><td colSpan={6} className="px-3 py-6 text-center text-black/55">No hay cuentas con saldo o movimientos para este filtro.</td></tr> : null}
              </tbody>
              <tfoot className="border-t border-black/10 bg-[#fafafa] font-semibold">
                <tr>
                  <td colSpan={3} className="px-3 py-3">Totales</td>
                  <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(data.totalDebit)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(data.totalCredit)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(data.totalEndingBalance)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

function StatementFilters({ data, basePath }: { data: Pick<BalanceSheetReportData | IncomeStatementReportData, "filters" | "options">; basePath: string }) {
  const { filters, options } = data;
  return (
    <section className="rounded-lg border border-black/10 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-4 flex items-center gap-2">
        <Search size={18} />
        <h2 className="font-semibold">Filtros</h2>
      </div>
      <form action={basePath} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
        <Field label="Período contable">
          <select name="period" defaultValue={filters.periodId} className="h-10 w-full rounded-md border border-black/10 bg-white px-3 text-sm outline-none focus:border-[#e4252c] focus:ring-2 focus:ring-[#e4252c]/15">
            <option value="">Rango manual</option>
            {options.periods.map((period) => (
              <option key={period.id} value={period.id}>{period.name}</option>
            ))}
          </select>
        </Field>
        <Field label="Fecha inicial">
          <Input name="startDate" type="date" defaultValue={filters.startDate} />
        </Field>
        <Field label="Fecha final">
          <Input name="endDate" type="date" defaultValue={filters.endDate} />
        </Field>
        <Field label="Estado">
          <select name="status" defaultValue="publicada" disabled className="h-10 w-full rounded-md border border-black/10 bg-[#f4f4f5] px-3 text-sm text-black/60 outline-none">
            <option value="publicada">Solo publicadas</option>
          </select>
        </Field>
        <div className="grid gap-2 sm:flex sm:items-end xl:col-span-2">
          <button type="submit" className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#080808] px-4 text-sm font-semibold text-white transition-colors hover:bg-[#1f1f1f]">
            <Search size={16} />
            Filtrar
          </button>
          <Link href={basePath} className="inline-flex h-10 items-center justify-center rounded-md border border-black/10 bg-white px-4 text-sm font-semibold text-[#080808] transition-colors hover:bg-[#f4f4f5]">
            Limpiar
          </Link>
        </div>
      </form>
    </section>
  );
}

function StatementSectionTable({ section, extraRows = [] }: { section: FinancialStatementSection; extraRows?: Array<{ label: string; amount: number }> }) {
  const rows = section.rows;
  return (
    <section className="overflow-hidden rounded-lg border border-black/10 bg-white shadow-sm">
      <div className="border-b border-black/10 p-4 sm:p-5">
        <div className="flex items-center gap-2"><FileText size={18} /><h2 className="font-semibold">{section.title}</h2></div>
      </div>

      <div className="grid gap-3 p-3 md:hidden">
        {rows.map((row) => (
          <article key={row.account.id} className="rounded-md border border-black/10 bg-white p-3">
            <p className="break-words font-semibold">{row.account.code} - {row.account.name}</p>
            <p className="mt-2 text-lg font-semibold tabular-nums">{formatCurrency(row.amount)}</p>
          </article>
        ))}
        {extraRows.map((row) => (
          <article key={row.label} className="rounded-md border border-black/10 bg-[#fafafa] p-3">
            <p className="font-semibold">{row.label}</p>
            <p className="mt-2 text-lg font-semibold tabular-nums">{formatCurrency(row.amount)}</p>
          </article>
        ))}
        {rows.length === 0 && extraRows.length === 0 ? <EmptyState text="No hay partidas publicadas para el período seleccionado." /> : null}
        <div className="rounded-md bg-[#080808] p-3 text-white">
          <p className="text-xs uppercase text-white/65">Subtotal</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{formatCurrency(section.total)}</p>
        </div>
      </div>

      <div className="hidden max-w-full overflow-x-auto md:block">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="bg-[#e7e5e4] text-xs uppercase text-black/55">
            <tr>
              <th className="px-3 py-3">Código</th>
              <th className="px-3 py-3">Cuenta</th>
              <th className="px-3 py-3 text-right">Saldo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/10">
            {rows.map((row) => (
              <tr key={row.account.id}>
                <td className="px-3 py-3 font-semibold">{row.account.code}</td>
                <td className="px-3 py-3 break-words">{row.account.name}</td>
                <td className="px-3 py-3 text-right font-semibold tabular-nums">{formatCurrency(row.amount)}</td>
              </tr>
            ))}
            {extraRows.map((row) => (
              <tr key={row.label} className="bg-[#fafafa]">
                <td className="px-3 py-3 font-semibold">-</td>
                <td className="px-3 py-3 font-semibold">{row.label}</td>
                <td className="px-3 py-3 text-right font-semibold tabular-nums">{formatCurrency(row.amount)}</td>
              </tr>
            ))}
            {rows.length === 0 && extraRows.length === 0 ? <tr><td colSpan={3} className="px-3 py-6 text-center text-black/55">No hay partidas publicadas para el período seleccionado.</td></tr> : null}
          </tbody>
          <tfoot className="border-t border-black/10 bg-[#fafafa] font-semibold">
            <tr>
              <td colSpan={2} className="px-3 py-3">Subtotal {section.title}</td>
              <td className="px-3 py-3 text-right tabular-nums">{formatCurrency(section.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

export function BalanceSheetReport({ data, canExport }: { data: BalanceSheetReportData; canExport: boolean }) {
  return (
    <main className="min-h-screen bg-[#f7f7f8] px-4 py-5 text-[#080808] sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1500px] space-y-5">
        <ReportHeader eyebrow="Finanzas" title="Balance General" description="Estado financiero read-only calculado exclusivamente desde partidas contables publicadas y sus líneas." />
        <StatementFilters data={data} basePath="/admin/balance-general" />
        <ExportPanel canExport={canExport} pdfHref={exportHref("/api/admin/contabilidad/balance-general", data.filters, "pdf")} excelHref={exportHref("/api/admin/contabilidad/balance-general", data.filters, "excel")} />

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Metric label="Período" value={data.periodLabel} />
          <Metric label="Activos" value={formatCurrency(data.totalAssets)} />
          <Metric label="Pasivos" value={formatCurrency(data.totalLiabilities)} />
          <Metric label="Patrimonio" value={formatCurrency(data.totalEquity)} />
          <div className={`rounded-lg border p-4 shadow-sm ${data.balanced ? "border-[#2f6f3e]/20 bg-[#edf7ed] text-[#2f6f3e]" : "border-[#e4252c]/20 bg-[#fff1f2] text-[#b91c25]"}`}>
            <p className="text-sm opacity-80">Validación</p>
            <p className="mt-1 text-xl font-semibold">{data.balanced ? "Balance correcto" : "Descuadre contable"}</p>
            <p className="mt-1 text-sm">Diferencia {formatCurrency(data.difference)}</p>
          </div>
        </section>

        {!data.hasPublishedEntries && data.totalAssets === 0 && data.totalLiabilitiesAndEquity === 0 ? <EmptyState text="No hay partidas publicadas para el período seleccionado." /> : null}

        <StatementSectionTable section={data.assets} />
        <StatementSectionTable section={data.liabilities} />
        <StatementSectionTable section={data.equity} extraRows={[{ label: "Resultado del período", amount: data.periodResult }]} />

        <section className="grid gap-3 md:grid-cols-3">
          <SmallTotal label="Total activos" value={formatCurrency(data.totalAssets)} />
          <SmallTotal label="Pasivos + patrimonio" value={formatCurrency(data.totalLiabilitiesAndEquity)} />
          <SmallTotal label="Generado" value={formatHnDateTime(data.generatedAt)} />
        </section>
      </div>
    </main>
  );
}

export function IncomeStatementReport({ data, canExport }: { data: IncomeStatementReportData; canExport: boolean }) {
  return (
    <main className="min-h-screen bg-[#f7f7f8] px-4 py-5 text-[#080808] sm:px-6 lg:px-8">
      <div className="mx-auto w-full max-w-[1500px] space-y-5">
        <ReportHeader eyebrow="Finanzas" title="Estado de Resultados" description="Ingresos, costos y gastos read-only calculados exclusivamente desde partidas contables publicadas." />
        <StatementFilters data={data} basePath="/admin/estado-resultados" />
        <ExportPanel canExport={canExport} pdfHref={exportHref("/api/admin/contabilidad/estado-resultados", data.filters, "pdf")} excelHref={exportHref("/api/admin/contabilidad/estado-resultados", data.filters, "excel")} />

        <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <Metric label="Período" value={data.periodLabel} />
          <Metric label="Ingresos" value={formatCurrency(data.totalRevenue)} />
          <Metric label="Costos" value={formatCurrency(data.totalCost)} />
          <Metric label="Utilidad bruta" value={formatCurrency(data.grossProfit)} />
          <div className={`rounded-lg border p-4 shadow-sm ${data.netIncome >= 0 ? "border-[#2f6f3e]/20 bg-[#edf7ed] text-[#2f6f3e]" : "border-[#e4252c]/20 bg-[#fff1f2] text-[#b91c25]"}`}>
            <p className="text-sm opacity-80">Resultado</p>
            <p className="mt-1 text-xl font-semibold">{data.resultLabel}</p>
            <p className="mt-1 text-sm tabular-nums">{formatCurrency(data.netIncome)}</p>
          </div>
        </section>

        {!data.hasPublishedEntries ? <EmptyState text="No hay partidas publicadas para el período seleccionado." /> : null}

        <StatementSectionTable section={data.revenues} />
        <StatementSectionTable section={data.costs} />
        <StatementSectionTable section={data.expenses} />

        <section className="grid gap-3 md:grid-cols-4">
          <SmallTotal label="Ingresos" value={formatCurrency(data.totalRevenue)} />
          <SmallTotal label="Costos" value={formatCurrency(data.totalCost)} />
          <SmallTotal label="Gastos" value={formatCurrency(data.totalExpense)} />
          <SmallTotal label={data.resultLabel} value={formatCurrency(data.netIncome)} />
        </section>
      </div>
    </main>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-xs font-medium uppercase text-black/50">{label}</span>{children}</label>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-black/10 bg-white p-4 shadow-sm"><p className="text-sm text-black/50">{label}</p><p className="mt-1 break-words text-xl font-semibold leading-tight">{value}</p></div>;
}

function SmallTotal({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md border border-black/10 bg-[#fafafa] px-3 py-2"><p className="text-xs uppercase text-black/45">{label}</p><p className="mt-1 font-semibold tabular-nums">{value}</p></div>;
}

function InfoBox({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return <div className={`rounded-md bg-[#f8fafc] p-2 ${wide ? "col-span-2" : ""}`}><dt className="text-xs uppercase text-black/45">{label}</dt><dd className="mt-1 font-semibold tabular-nums">{value}</dd></div>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-black/15 bg-white p-6 text-center text-sm text-black/55">{text}</div>;
}