import type { AccountingAccount, AccountingAccountType, AccountingNormalBalance, AccountingPeriodStatus } from "./accounting";

export type AccountingReportStatus = "contabilizada";

export type AccountingPeriodOption = {
  id: string;
  name: string;
  start_date: string;
  end_date: string;
  status: AccountingPeriodStatus;
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
  journalEntryId: string;
  journalStatus: "publicada" | "reversada";
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
  selectedPeriodStatus: AccountingPeriodStatus | null;
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
  selectedPeriodStatus: AccountingPeriodStatus | null;
  generatedAt: string;
  rows: TrialBalanceRow[];
  totalDebit: number;
  totalCredit: number;
  totalEndingBalance: number;
  difference: number;
  balanced: boolean;
};

export type FinancialStatementRow = {
  account: AccountingReportAccount;
  amount: number;
};

export type FinancialStatementSection = {
  title: string;
  rows: FinancialStatementRow[];
  total: number;
};

export type BalanceSheetReportData = {
  filters: AccountingReportFilters;
  options: AccountingReportOptions;
  periodLabel: string;
  selectedPeriodStatus: AccountingPeriodStatus | null;
  generatedAt: string;
  assets: FinancialStatementSection;
  liabilities: FinancialStatementSection;
  equity: FinancialStatementSection;
  periodResult: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  totalLiabilitiesAndEquity: number;
  difference: number;
  balanced: boolean;
  hasAccountedEntries: boolean;
};

export type IncomeStatementReportData = {
  filters: AccountingReportFilters;
  options: AccountingReportOptions;
  periodLabel: string;
  selectedPeriodStatus: AccountingPeriodStatus | null;
  generatedAt: string;
  revenues: FinancialStatementSection;
  costs: FinancialStatementSection;
  expenses: FinancialStatementSection;
  totalRevenue: number;
  totalCost: number;
  totalExpense: number;
  grossProfit: number;
  netIncome: number;
  resultLabel: "Utilidad neta" | "Pérdida neta";
  hasAccountedEntries: boolean;
};
