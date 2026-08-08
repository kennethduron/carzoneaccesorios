export type AccountingTaxReportDocumentType = "sale" | "purchase";
export type AccountingTaxAccountingStatus = "accounted" | "pending" | "reversed";

export type AccountingTaxReportSummary = {
  dateFrom: string;
  dateTo: string;
  currency: "HNL";
  salesInvoiceCount: number;
  salesTax: number;
  salesTotal: number;
  purchaseInvoiceCount: number;
  purchaseTax: number;
  purchaseTotal: number;
  taxDifference: number;
  amountToPay: number;
  salesAccountedCount: number;
  salesPendingAccountingCount: number;
  purchaseAccountedCount: number;
  purchasePendingAccountingCount: number;
  salesReversedAccountingCount: number;
  purchaseReversedAccountingCount: number;
  purchasesWithoutSupplierInvoiceCount: number;
  excludedCurrencyCount: number;
  calculatedAt: string;
};

export type AccountingTaxReportDocument = {
  documentId: string;
  documentNumber: string;
  documentDate: string;
  counterpartyName: string;
  taxAmount: number;
  totalAmount: number;
  status: string;
  accountingStatus: AccountingTaxAccountingStatus;
  journalEntryId: string | null;
  currency: string;
};

export type AccountingTaxReportPage = {
  rows: AccountingTaxReportDocument[];
  total: number;
  page: number;
  pageSize: 20 | 50;
  search: string;
};
