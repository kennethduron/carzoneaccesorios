import { AccountingTaxReport } from "@/components/admin/accounting-tax-report";
import { requirePermission } from "@/lib/auth/session";
import { getAccountingTaxReportDocuments, getAccountingTaxReportSummary, normalizeTaxReportPage, normalizeTaxReportPageSize, normalizeTaxReportSearch } from "@/services/supabase/accounting-tax-report.service";
import { isSqlDate, todayInHonduras } from "@/utils/honduras-date";

export const dynamic = "force-dynamic";

const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

export default async function AccountingTaxReportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requirePermission("tax:read");
  const params = await searchParams;
  const today = todayInHonduras();
  const defaultFrom = `${today.slice(0, 8)}01`;
  const requestedFrom = first(params.from);
  const requestedTo = first(params.to);
  const from = requestedFrom && isSqlDate(requestedFrom) ? requestedFrom : defaultFrom;
  const to = requestedTo && isSqlDate(requestedTo) ? requestedTo : today;
  const dateFrom = from <= to ? from : to;
  const dateTo = to >= from ? to : from;
  const saleSearch = normalizeTaxReportSearch(first(params.saleSearch));
  const purchaseSearch = normalizeTaxReportSearch(first(params.purchaseSearch));
  const salePage = normalizeTaxReportPage(first(params.salePage));
  const purchasePage = normalizeTaxReportPage(first(params.purchasePage));
  const pageSize = normalizeTaxReportPageSize(first(params.pageSize));

  const [summary, sales, purchases] = await Promise.all([
    getAccountingTaxReportSummary(dateFrom, dateTo),
    getAccountingTaxReportDocuments({ type: "sale", dateFrom, dateTo, search: saleSearch, page: salePage, pageSize }),
    getAccountingTaxReportDocuments({ type: "purchase", dateFrom, dateTo, search: purchaseSearch, page: purchasePage, pageSize }),
  ]);

  return <AccountingTaxReport summary={summary} sales={sales} purchases={purchases} query={{ from: dateFrom, to: dateTo, saleSearch, purchaseSearch, salePage, purchasePage, pageSize }} />;
}
