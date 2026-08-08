import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  AccountingTaxAccountingStatus,
  AccountingTaxReportDocument,
  AccountingTaxReportDocumentType,
  AccountingTaxReportPage,
  AccountingTaxReportSummary,
} from "@/types/accounting-tax-report";

type SummaryRow = Record<string, unknown>;
type DocumentRow = Record<string, unknown>;

const numberValue = (value: unknown) => Number(value ?? 0);
const textValue = (value: unknown) => (typeof value === "string" ? value : "");

export function normalizeTaxReportPage(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

export function normalizeTaxReportPageSize(value: unknown): 20 | 50 {
  return Number(value) === 50 ? 50 : 20;
}

export function normalizeTaxReportSearch(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
}

function mapSummary(row: SummaryRow): AccountingTaxReportSummary {
  return {
    dateFrom: textValue(row.date_from),
    dateTo: textValue(row.date_to),
    currency: "HNL",
    salesInvoiceCount: numberValue(row.sales_invoice_count),
    salesTax: numberValue(row.sales_tax),
    salesTotal: numberValue(row.sales_total),
    purchaseInvoiceCount: numberValue(row.purchase_invoice_count),
    purchaseTax: numberValue(row.purchase_tax),
    purchaseTotal: numberValue(row.purchase_total),
    taxDifference: numberValue(row.tax_difference),
    amountToPay: numberValue(row.amount_to_pay),
    salesAccountedCount: numberValue(row.sales_accounted_count),
    salesPendingAccountingCount: numberValue(row.sales_pending_accounting_count),
    purchaseAccountedCount: numberValue(row.purchase_accounted_count),
    purchasePendingAccountingCount: numberValue(row.purchase_pending_accounting_count),
    salesReversedAccountingCount: numberValue(row.sales_reversed_accounting_count),
    purchaseReversedAccountingCount: numberValue(row.purchase_reversed_accounting_count),
    purchasesWithoutSupplierInvoiceCount: numberValue(row.purchases_without_supplier_invoice_count),
    excludedCurrencyCount: numberValue(row.excluded_currency_count),
    calculatedAt: textValue(row.calculated_at),
  };
}

function mapDocument(row: DocumentRow): AccountingTaxReportDocument {
  const accountingStatus = textValue(row.accounting_status);
  return {
    documentId: textValue(row.document_id),
    documentNumber: textValue(row.document_number),
    documentDate: textValue(row.document_date),
    counterpartyName: textValue(row.counterparty_name),
    taxAmount: numberValue(row.tax_amount),
    totalAmount: numberValue(row.total_amount),
    status: textValue(row.status),
    accountingStatus: (["accounted", "pending", "reversed"].includes(accountingStatus)
      ? accountingStatus
      : "pending") as AccountingTaxAccountingStatus,
    journalEntryId: typeof row.journal_entry_id === "string" ? row.journal_entry_id : null,
    currency: textValue(row.currency) || "HNL",
  };
}

export async function getAccountingTaxReportSummary(dateFrom: string, dateTo: string) {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_accounting_tax_report_summary_v1", {
    p_date_from: dateFrom,
    p_date_to: dateTo,
  });
  if (error) throw new Error("No fue posible calcular el reporte en este momento. Intente nuevamente.");
  return mapSummary(((data ?? [])[0] ?? {}) as SummaryRow);
}

export async function getAccountingTaxReportDocuments(args: {
  type: AccountingTaxReportDocumentType;
  dateFrom: string;
  dateTo: string;
  search?: string;
  page?: number;
  pageSize?: 20 | 50;
}): Promise<AccountingTaxReportPage> {
  const page = normalizeTaxReportPage(args.page);
  const pageSize = normalizeTaxReportPageSize(args.pageSize);
  const search = normalizeTaxReportSearch(args.search);
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_accounting_tax_report_documents_v1", {
    p_document_type: args.type,
    p_date_from: args.dateFrom,
    p_date_to: args.dateTo,
    p_search: search || null,
    p_limit: pageSize,
    p_offset: (page - 1) * pageSize,
  });
  if (error) throw new Error("No fue posible cargar los documentos del reporte.");
  const rows = ((data ?? []) as DocumentRow[]).map(mapDocument);
  return { rows, total: numberValue(data?.[0]?.total_count), page, pageSize, search };
}
