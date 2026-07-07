import type { AccountingAccountType, AccountingNormalBalance } from "./accounting";

export type ChartOfAccountsImportRow = {
  rowNumber: number;
  code: string;
  name: string;
  type: AccountingAccountType;
  normal_balance: AccountingNormalBalance;
  parent_code: string | null;
  is_active: boolean;
  description: string | null;
};

export type ChartOfAccountsImportSummary = {
  processed: number;
  created: number;
  updated: number;
  skipped: number;
};

export type ChartOfAccountsImportActionState = {
  ok: boolean;
  message: string;
  errors: string[];
  summary?: ChartOfAccountsImportSummary;
};

export type ChartOfAccountsExportRow = {
  code: string;
  name: string;
  type: AccountingAccountType;
  normal_balance: AccountingNormalBalance;
  parent_code: string;
  is_active: boolean;
  description: string;
};

export type ChartOfAccountsExportData = {
  generatedAt: string;
  rows: ChartOfAccountsExportRow[];
};
