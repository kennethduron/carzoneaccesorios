export type AccountingAccountType = "asset" | "liability" | "equity" | "revenue" | "cost" | "expense";
export type AccountingNormalBalance = "debit" | "credit";
export type JournalEntryStatus = "borrador" | "publicada" | "reversada" | "anulada";
export type AccountingPeriodStatus = "open" | "closed" | "reopened";
export type AccountingPeriodType = "monthly" | "annual" | "custom";

export type AccountingPeriod = {
  id: string;
  name: string;
  period_type: AccountingPeriodType;
  start_date: string;
  end_date: string;
  status: AccountingPeriodStatus;
  fiscal_year: number;
  closed_at: string | null;
  closed_by: string | null;
  reopened_at: string | null;
  reopened_by: string | null;
  reopen_reason: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  closed_by_name?: string | null;
  reopened_by_name?: string | null;
};

export type AccountingPeriodInput = {
  id?: string;
  name: string;
  period_type: AccountingPeriodType;
  start_date: string;
  end_date: string;
  status?: AccountingPeriodStatus;
  fiscal_year: number;
  notes?: string | null;
};

export type AccountingPeriodsPageData = {
  periods: AccountingPeriod[];
  currentPeriod: AccountingPeriod | null;
  openPeriods: number;
  closedPeriods: number;
};

export type AccountingPeriodCloseValidationSummary = {
  draft_entries: number;
  unbalanced_entries: number;
  entries_missing_lines: number;
  invalid_account_lines: number;
  pending_financial_events: number;
  trial_balance_debit: number;
  trial_balance_credit: number;
  active_mappings: number;
};

export type AccountingPeriodCloseValidation = {
  ok: boolean;
  ready: boolean;
  period_id: string | null;
  period_name: string | null;
  blockers: string[];
  warnings: string[];
  summary: AccountingPeriodCloseValidationSummary;
  closed?: boolean;
  message?: string;
};

export type AccountingAccount = {
  id: string;
  code: string;
  name: string;
  type: AccountingAccountType;
  parent_id: string | null;
  normal_balance: AccountingNormalBalance;
  is_active: boolean;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AccountingAccountInput = {
  id?: string;
  code: string;
  name: string;
  type: AccountingAccountType;
  parent_id?: string | null;
  normal_balance: AccountingNormalBalance;
  is_active?: boolean;
  description?: string | null;
};

export type JournalEntryLine = {
  id: string;
  journal_entry_id: string;
  account_id: string;
  debit: number;
  credit: number;
  description: string | null;
  customer_id: string | null;
  vendor_id: string | null;
  product_id: string | null;
  created_at: string;
  account?: Pick<AccountingAccount, "id" | "code" | "name" | "type" | "is_active"> | null;
};

export type JournalEntry = {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  status: JournalEntryStatus;
  source_type: string | null;
  source_id: string | null;
  created_by: string;
  posted_by: string | null;
  posted_at: string | null;
  reversed_entry_id: string | null;
  created_at: string;
  updated_at: string;
  lines: JournalEntryLine[];
  total_debit: number;
  total_credit: number;
};

export type JournalEntryLineInput = {
  id?: string;
  account_id: string;
  debit: number;
  credit: number;
  description?: string | null;
  customer_id?: string | null;
  vendor_id?: string | null;
  product_id?: string | null;
};

export type JournalEntryInput = {
  id?: string;
  entry_date: string;
  description: string;
  source_type?: string | null;
  source_id?: string | null;
  lines: JournalEntryLineInput[];
};

export type AccountingDashboardSummary = {
  totalAccounts: number;
  activeAccounts: number;
  journalEntriesThisMonth: number;
  draftEntries: number;
  latestEntry: JournalEntry | null;
};

export type AccountingPageData = {
  summary: AccountingDashboardSummary;
  accounts: AccountingAccount[];
  activeAccounts: AccountingAccount[];
  journalEntries: JournalEntry[];
  accountPage: number;
  accountPageSize: number;
  accountTotal: number;
  journalPage: number;
  journalPageSize: number;
  journalTotal: number;
};
