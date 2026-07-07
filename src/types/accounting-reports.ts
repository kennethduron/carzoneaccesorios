import type { AccountingAccount, AccountingAccountType, AccountingNormalBalance } from "./accounting";

export type AccountingReportStatus = "publicada";

export type AccountingPeriodOption = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: "open" | "closed";
};

export type AccountingReportAccount = Pick<AccountingAccount, "id" | "code" | "name" | "type" | "normal_balance" | "is_active">;

export type AccountingReportFilters = {
  periodId: string;
  startDate: string;
  endDate: string;
  accountId: string;
  accountType: AccountingAccountType | "all";
  status: AccountingReportStatus;
  search: string;
  page: number;
  pageSize: number;
};

export type AccountingReportOptions = {
  periods: AccountingPeriodOption[];
  accounts: AccountingReportAccount[];
};

export type GeneralLedgerMovement = {
  id: string;
  date: string;
  journalNumber: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  runningBalance: number;
};

export type GeneralLedgerAccountSection = {
  account: AccountingReportAccount;
  openingBalance: number;
  closingBalance: number;
  totalDebit: number;
  totalCredit: number;
  movements: GeneralLedgerMovement[];
};

export type GeneralLedgerReportData = {
  filters: AccountingReportFilters;
  options: AccountingReportOptions;
  periodLabel: string;
  generatedAt: string;
  account: AccountingReportAccount | null;
  section: GeneralLedgerAccountSection | null;
  totalMovements: number;
  page: number;
  pageSize: number;
};

export type TrialBalanceRow = {
  account: AccountingReportAccount;
  debit: number;
  credit: number;
  endingBalance: number;
  normalBalance: AccountingNormalBalance;
};

export type TrialBalanceReportData = {
  filters: AccountingReportFilters;
  options: AccountingReportOptions;
  periodLabel: string;
  generatedAt: string;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  totalEndingBalance: number;
  difference: number;
  balanced: boolean;
};