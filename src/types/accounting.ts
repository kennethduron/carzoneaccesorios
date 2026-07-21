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

export type AccountingAccountHierarchyOption = Pick<
  AccountingAccount,
  "id" | "code" | "name" | "parent_id" | "is_active"
>;

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
  version: number;
  updated_by: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  lines: JournalEntryLine[];
  total_debit: number;
  total_credit: number;
};

export type JournalEntryViewerData = {
  entry: JournalEntry;
  creatorName: string;
  postedByName: string | null;
};

export type JournalEntryViewerStatus = "idle" | "loaded" | "invalid" | "not_found" | "load_error";

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

export type JournalDraftUpdateInput = {
  id: string;
  expected_version: number;
  entry_date: string;
  description: string;
  edit_reason: string;
  lines: JournalEntryLineInput[];
};

export type JournalEntrySourceContext = {
  financial_event_id: string;
  event_status: string;
  event_purpose: string;
  source_type: string;
  source_id: string;
  source_snapshot: Record<string, unknown>;
  accounts_payable: {
    id: string;
    total_amount: number;
    balance: number;
    currency: string;
    status: string;
    due_date: string | null;
  } | null;
  purchase: {
    id: string;
    purchase_number: string;
    subtotal: number;
    tax_amount: number;
    discount_amount: number;
    shipping_amount: number;
    total: number;
    status: string;
  } | null;
  supplier_invoice: {
    id: string;
    invoice_number: string;
    subtotal: number;
    tax_amount: number;
    discount_amount: number;
    total: number;
    status: string;
  } | null;
};

export type JournalEntryEditData = {
  entry: JournalEntry;
  activeAccounts: AccountingAccount[];
  creatorName: string;
  sourceContext: JournalEntrySourceContext | null;
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
  accountHierarchyOptions: AccountingAccountHierarchyOption[];
  journalEntries: JournalEntry[];
  accountPage: number;
  accountPageSize: number;
  accountTotal: number;
  journalPage: number;
  journalPageSize: number;
  journalTotal: number;
};
