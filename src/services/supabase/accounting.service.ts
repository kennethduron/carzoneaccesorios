import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type {
  AccountingAccount,
  AccountingDashboardSummary,
  AccountingPageData,
  JournalEntry,
  JournalEntryLine,
} from "@/types/accounting";

type AccountingPageInput = {
  accountPage?: number;
  accountPageSize?: number;
  journalPage?: number;
  journalPageSize?: number;
};

type JournalEntryRow = Omit<JournalEntry, "lines" | "total_debit" | "total_credit">;

type JournalLineRow = Omit<JournalEntryLine, "debit" | "credit" | "account"> & {
  debit: unknown;
  credit: unknown;
  accounting_accounts: JournalEntryLine["account"] | null;
};

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

function normalizePage(value: unknown) {
  const page = Number(value);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizePageSize(value: unknown) {
  const pageSize = Number(value);
  if (!Number.isFinite(pageSize) || pageSize <= 0) {
    return 50;
  }

  return Math.min(Math.floor(pageSize), 100);
}

function currentMonthStart() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .slice(0, 8)
    .concat("01");
}

function normalizeLine(row: JournalLineRow): JournalEntryLine {
  return {
    ...row,
    debit: toNumber(row.debit),
    credit: toNumber(row.credit),
    account: row.accounting_accounts,
  };
}

function normalizeEntry(row: JournalEntryRow, lines: JournalEntryLine[] = []): JournalEntry {
  const totalDebit = lines.reduce((sum, line) => sum + line.debit, 0);
  const totalCredit = lines.reduce((sum, line) => sum + line.credit, 0);

  return {
    ...row,
    lines,
    total_debit: Math.round(totalDebit * 100) / 100,
    total_credit: Math.round(totalCredit * 100) / 100,
  };
}

async function getLinesByEntryIds(entryIds: string[]) {
  if (entryIds.length === 0) {
    return new Map<string, JournalEntryLine[]>();
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("journal_entry_lines")
    .select(
      `
      id,
      journal_entry_id,
      account_id,
      debit,
      credit,
      description,
      customer_id,
      vendor_id,
      product_id,
      created_at,
      accounting_accounts(id, code, name, type, is_active)
    `,
    )
    .in("journal_entry_id", entryIds)
    .order("created_at", { ascending: true })
    .returns<JournalLineRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  const byEntry = new Map<string, JournalEntryLine[]>();
  for (const row of data ?? []) {
    const line = normalizeLine(row);
    byEntry.set(line.journal_entry_id, [...(byEntry.get(line.journal_entry_id) ?? []), line]);
  }

  return byEntry;
}

async function getLatestEntry(): Promise<JournalEntry | null> {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("journal_entries")
    .select("id, entry_number, entry_date, description, status, source_type, source_id, created_by, posted_by, posted_at, reversed_entry_id, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(1)
    .returns<JournalEntryRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  const latest = data?.[0] ?? null;
  if (!latest) {
    return null;
  }

  const lines = await getLinesByEntryIds([latest.id]);
  return normalizeEntry(latest, lines.get(latest.id) ?? []);
}

export async function getAccountingPageData(input: AccountingPageInput = {}): Promise<AccountingPageData> {
  const supabase = await getSupabaseServerClient();
  const accountPage = normalizePage(input.accountPage);
  const accountPageSize = normalizePageSize(input.accountPageSize);
  const journalPage = normalizePage(input.journalPage);
  const journalPageSize = normalizePageSize(input.journalPageSize);
  const accountFrom = (accountPage - 1) * accountPageSize;
  const journalFrom = (journalPage - 1) * journalPageSize;

  const [
    { data: accounts, error: accountsError, count: accountTotal },
    { data: activeAccounts, error: activeAccountsError, count: activeAccountsTotal },
    { data: journalRows, error: journalError, count: journalTotal },
    { count: journalEntriesThisMonth, error: monthError },
    { count: draftEntries, error: draftError },
    latestEntry,
  ] = await Promise.all([
    supabase
      .from("accounting_accounts")
      .select("id, code, name, type, parent_id, normal_balance, is_active, description, created_by, created_at, updated_at", { count: "exact" })
      .order("code", { ascending: true })
      .range(accountFrom, accountFrom + accountPageSize - 1)
      .returns<AccountingAccount[]>(),
    supabase
      .from("accounting_accounts")
      .select("id, code, name, type, parent_id, normal_balance, is_active, description, created_by, created_at, updated_at", { count: "exact" })
      .eq("is_active", true)
      .order("code", { ascending: true })
      .limit(500)
      .returns<AccountingAccount[]>(),
    supabase
      .from("journal_entries")
      .select("id, entry_number, entry_date, description, status, source_type, source_id, created_by, posted_by, posted_at, reversed_entry_id, created_at, updated_at", { count: "exact" })
      .order("entry_date", { ascending: false })
      .order("created_at", { ascending: false })
      .range(journalFrom, journalFrom + journalPageSize - 1)
      .returns<JournalEntryRow[]>(),
    supabase
      .from("journal_entries")
      .select("id", { count: "exact", head: true })
      .gte("entry_date", currentMonthStart()),
    supabase
      .from("journal_entries")
      .select("id", { count: "exact", head: true })
      .eq("status", "borrador"),
    getLatestEntry(),
  ]);

  if (accountsError) throw new Error(accountsError.message);
  if (activeAccountsError) throw new Error(activeAccountsError.message);
  if (journalError) throw new Error(journalError.message);
  if (monthError) throw new Error(monthError.message);
  if (draftError) throw new Error(draftError.message);

  const entryIds = (journalRows ?? []).map((entry) => entry.id);
  const linesByEntry = await getLinesByEntryIds(entryIds);
  const journalEntries = (journalRows ?? []).map((entry) => normalizeEntry(entry, linesByEntry.get(entry.id) ?? []));

  const summary: AccountingDashboardSummary = {
    totalAccounts: accountTotal ?? 0,
    activeAccounts: activeAccountsTotal ?? activeAccounts?.length ?? 0,
    journalEntriesThisMonth: journalEntriesThisMonth ?? 0,
    draftEntries: draftEntries ?? 0,
    latestEntry,
  };

  return {
    summary,
    accounts: accounts ?? [],
    activeAccounts: activeAccounts ?? [],
    journalEntries,
    accountPage,
    accountPageSize,
    accountTotal: accountTotal ?? 0,
    journalPage,
    journalPageSize,
    journalTotal: journalTotal ?? 0,
  };
}
