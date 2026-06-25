export type AccountingAccountType = "asset" | "liability" | "equity" | "revenue" | "cost" | "expense";
export type AccountingNormalBalance = "debit" | "credit";
export type JournalEntryStatus = "borrador" | "publicada" | "reversada" | "anulada";

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
