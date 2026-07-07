import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AccountingAccountType } from "@/types/accounting";
import type {
  AccountingPeriodOption,
  AccountingReportAccount,
  AccountingReportFilters,
  GeneralLedgerMovement,
  GeneralLedgerReportData,
  TrialBalanceReportData,
  TrialBalanceRow,
} from "@/types/accounting-reports";

const hondurasTimeZone = "America/Tegucigalpa";
const defaultPageSize = 50;
const maxPageSize = 100;
export const accountingReportExportLimit = 5000;

const accountTypeValues = new Set<AccountingAccountType>(["asset", "liability", "equity", "revenue", "cost", "expense"]);

const sourceReferenceLabels: Record<string, string> = {
  manual: "Partida manual",
  order: "Venta",
  payment: "Pago recibido",
  invoice: "Factura fiscal",
  commercial_credit: "Crédito comercial",
  accounts_receivable: "Cuenta por cobrar",
  receivable_payment: "Abono recibido",
  inventory_movement: "Movimiento de inventario",
  purchase: "Compra",
  supplier_invoice: "Factura de proveedor",
  accounts_payable: "Cuenta por pagar",
  supplier_payment: "Pago a proveedor",
  purchase_return: "Devolución a proveedor",
  supplier_credit: "Crédito de proveedor",
};

type SearchParamsLike = URLSearchParams | Record<string, string | string[] | undefined>;

type AccountRow = AccountingReportAccount;

type PeriodRow = AccountingPeriodOption;

type JoinedEntry = {
  id: string;
  entry_number: string;
  entry_date: string;
  description: string;
  status: string;
  source_type: string | null;
  source_id: string | null;
  posted_at: string | null;
};

type JoinedAccount = AccountingReportAccount;

type LedgerLineRow = {
  id: string;
  journal_entry_id: string;
  account_id: string;
  debit: unknown;
  credit: unknown;
  description: string | null;
  created_at: string;
  journal_entries: JoinedEntry | JoinedEntry[] | null;
  accounting_accounts: JoinedAccount | JoinedAccount[] | null;
};

type AggregateRow = {
  account_id?: string | null;
  debit?: unknown;
  credit?: unknown;
  sum?: unknown;
  accounting_accounts?: JoinedAccount | JoinedAccount[] | null;
};

function toNumber(value: unknown) {
  const numberValue = Number(value ?? 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function todayKey() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: hondurasTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function currentMonthStart() {
  return `${todayKey().slice(0, 8)}01`;
}

function firstJoined<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function normalizePage(value: string | number | null | undefined) {
  const page = Number(value ?? 1);
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}

function normalizePageSize(value: string | number | null | undefined, fallback = defaultPageSize) {
  const pageSize = Number(value ?? fallback);
  if (!Number.isFinite(pageSize) || pageSize <= 0) return fallback;
  return Math.min(Math.floor(pageSize), maxPageSize);
}

function paramValue(params: SearchParamsLike, key: string) {
  if (params instanceof URLSearchParams) return params.get(key) ?? "";
  const value = params[key];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function cleanText(value: string | null | undefined) {
  return String(value ?? "").trim();
}

function normalizeDate(value: string | null | undefined) {
  const text = cleanText(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function normalizeAccountType(value: string | null | undefined): AccountingAccountType | "all" {
  const text = cleanText(value);
  return accountTypeValues.has(text as AccountingAccountType) ? (text as AccountingAccountType) : "all";
}

function normalizeSearch(value: string | null | undefined) {
  return cleanText(value).replace(/[,%]/g, " ").replace(/\s+/g, " ").slice(0, 80);
}

function normalizeFilters(params: SearchParamsLike, periods: AccountingPeriodOption[]): AccountingReportFilters {
  const periodId = cleanText(paramValue(params, "period"));
  const period = periods.find((item) => item.id === periodId) ?? null;
  const explicitStart = normalizeDate(paramValue(params, "startDate"));
  const explicitEnd = normalizeDate(paramValue(params, "endDate"));
  const startDate = explicitStart || period?.start_date || currentMonthStart();
  const endDate = explicitEnd || period?.end_date || todayKey();

  return {
    periodId: period?.id ?? "",
    startDate: startDate <= endDate ? startDate : endDate,
    endDate: endDate >= startDate ? endDate : startDate,
    accountId: cleanText(paramValue(params, "account")),
    accountType: normalizeAccountType(paramValue(params, "accountType")),
    status: "publicada",
    search: normalizeSearch(paramValue(params, "search")),
    page: normalizePage(paramValue(params, "page")),
    pageSize: normalizePageSize(paramValue(params, "pageSize")),
  };
}

function periodLabel(filters: AccountingReportFilters, periods: AccountingPeriodOption[]) {
  const period = periods.find((item) => item.id === filters.periodId);
  if (period) return `${period.name} (${period.start_date} a ${period.end_date})`;
  return `${filters.startDate} a ${filters.endDate}`;
}

function balanceDelta(account: AccountingReportAccount, debit: number, credit: number) {
  return account.normal_balance === "debit" ? debit - credit : credit - debit;
}

function referenceLabel(entry: JoinedEntry | null) {
  if (!entry?.source_type) return "Partida manual";
  return sourceReferenceLabels[entry.source_type] ?? "Referencia contable";
}

function aggregateDebit(row: AggregateRow) {
  return toNumber(row.debit ?? row.sum);
}

function aggregateCredit(row: AggregateRow) {
  return toNumber(row.credit ?? 0);
}

function exportQueryParams(filters: AccountingReportFilters) {
  const params = new URLSearchParams();
  if (filters.periodId) params.set("period", filters.periodId);
  if (filters.startDate) params.set("startDate", filters.startDate);
  if (filters.endDate) params.set("endDate", filters.endDate);
  if (filters.accountId) params.set("account", filters.accountId);
  if (filters.accountType !== "all") params.set("accountType", filters.accountType);
  if (filters.search) params.set("search", filters.search);
  return params;
}

export function buildAccountingReportParams(filters: AccountingReportFilters) {
  return exportQueryParams(filters).toString();
}

export async function getAccountingReportOptions(filters?: Pick<AccountingReportFilters, "accountType" | "search">) {
  const supabase = await getSupabaseServerClient();
  let accountsQuery = supabase
    .from("accounting_accounts")
    .select("id, code, name, type, normal_balance, is_active")
    .order("code", { ascending: true })
    .limit(500);

  if (filters?.accountType && filters.accountType !== "all") {
    accountsQuery = accountsQuery.eq("type", filters.accountType);
  }

  if (filters?.search) {
    const search = `%${filters.search}%`;
    accountsQuery = accountsQuery.or(`code.ilike.${search},name.ilike.${search}`);
  }

  const [accountsResult, periodsResult] = await Promise.all([
    accountsQuery.returns<AccountRow[]>(),
    supabase
      .from("accounting_periods")
      .select("id, name, start_date, end_date, status")
      .order("start_date", { ascending: false })
      .limit(48)
      .returns<PeriodRow[]>(),
  ]);

  if (accountsResult.error) throw new Error(accountsResult.error.message);
  if (periodsResult.error) throw new Error(periodsResult.error.message);

  return {
    accounts: accountsResult.data ?? [],
    periods: periodsResult.data ?? [],
  };
}

async function getOpeningTotals(accountId: string, startDate: string) {
  if (!accountId || !startDate) return { debit: 0, credit: 0 };

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .from("journal_entry_lines")
    .select("debit.sum(), credit.sum(), journal_entries!inner(entry_date, status)")
    .eq("account_id", accountId)
    .eq("journal_entries.status", "publicada")
    .lt("journal_entries.entry_date", startDate)
    .returns<AggregateRow[]>();

  if (error) throw new Error(error.message);

  const row = data?.[0] ?? null;
  return { debit: aggregateDebit(row ?? {}), credit: aggregateCredit(row ?? {}) };
}

async function getTrialAggregate(filters: AccountingReportFilters, beforeStart: boolean, accountIds: string[]) {
  if (accountIds.length === 0) return [] as AggregateRow[];

  const supabase = await getSupabaseServerClient();
  let query = supabase
    .from("journal_entry_lines")
    .select("account_id, debit.sum(), credit.sum(), accounting_accounts!inner(id, code, name, type, normal_balance, is_active), journal_entries!inner(entry_date, status)")
    .eq("journal_entries.status", "publicada")
    .in("account_id", accountIds);

  if (beforeStart) {
    query = query.lt("journal_entries.entry_date", filters.startDate);
  } else {
    query = query.gte("journal_entries.entry_date", filters.startDate).lte("journal_entries.entry_date", filters.endDate);
  }

  const { data, error } = await query.returns<AggregateRow[]>();
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getGeneralLedgerReport(params: SearchParamsLike, options: { exportMode?: boolean } = {}): Promise<GeneralLedgerReportData> {
  const initialOptions = await getAccountingReportOptions();
  const filters = normalizeFilters(params, initialOptions.periods);
  const filteredOptions = await getAccountingReportOptions({ accountType: filters.accountType, search: filters.search });
  const selectedAccount = filteredOptions.accounts.find((account) => account.id === filters.accountId) ?? filteredOptions.accounts[0] ?? null;
  const pageSize = options.exportMode ? accountingReportExportLimit : filters.pageSize;
  const page = options.exportMode ? 1 : filters.page;
  const offset = (page - 1) * pageSize;
  const fetchThrough = offset + pageSize;

  if (!selectedAccount) {
    return {
      filters: { ...filters, page, pageSize },
      options: filteredOptions,
      periodLabel: periodLabel(filters, filteredOptions.periods),
      generatedAt: new Date().toISOString(),
      account: null,
      section: null,
      totalMovements: 0,
      page,
      pageSize,
    };
  }

  const supabase = await getSupabaseServerClient();
  let query = supabase
    .from("journal_entry_lines")
    .select(
      "id, journal_entry_id, account_id, debit, credit, description, created_at, accounting_accounts!inner(id, code, name, type, normal_balance, is_active), journal_entries!inner(id, entry_number, entry_date, description, status, source_type, source_id, posted_at)",
      { count: "exact" },
    )
    .eq("account_id", selectedAccount.id)
    .eq("journal_entries.status", "publicada")
    .gte("journal_entries.entry_date", filters.startDate)
    .lte("journal_entries.entry_date", filters.endDate)
    .order("entry_date", { referencedTable: "journal_entries", ascending: true })
    .order("entry_number", { referencedTable: "journal_entries", ascending: true })
    .order("created_at", { ascending: true })
    .range(0, fetchThrough - 1);

  if (filters.search) {
    const search = `%${filters.search}%`;
    query = query.or(`description.ilike.${search}`);
  }

  const [{ data, error, count }, opening] = await Promise.all([query.returns<LedgerLineRow[]>(), getOpeningTotals(selectedAccount.id, filters.startDate)]);
  if (error) throw new Error(error.message);

  let runningBalance = roundMoney(balanceDelta(selectedAccount, opening.debit, opening.credit));
  const allFetchedMovements: GeneralLedgerMovement[] = [];

  for (const row of data ?? []) {
    const entry = firstJoined(row.journal_entries);
    const debit = toNumber(row.debit);
    const credit = toNumber(row.credit);
    runningBalance = roundMoney(runningBalance + balanceDelta(selectedAccount, debit, credit));
    allFetchedMovements.push({
      id: row.id,
      date: entry?.entry_date ?? "",
      journalNumber: entry?.entry_number ?? "-",
      reference: referenceLabel(entry),
      description: row.description || entry?.description || "Movimiento contable",
      debit,
      credit,
      runningBalance,
    });
  }

  const pageMovements = options.exportMode ? allFetchedMovements : allFetchedMovements.slice(offset, offset + pageSize);
  const rangeTotals = allFetchedMovements.reduce(
    (totals, movement) => ({ debit: totals.debit + movement.debit, credit: totals.credit + movement.credit }),
    { debit: 0, credit: 0 },
  );

  return {
    filters: { ...filters, accountId: selectedAccount.id, page, pageSize },
    options: filteredOptions,
    periodLabel: periodLabel(filters, filteredOptions.periods),
    generatedAt: new Date().toISOString(),
    account: selectedAccount,
    section: {
      account: selectedAccount,
      openingBalance: roundMoney(balanceDelta(selectedAccount, opening.debit, opening.credit)),
      closingBalance: pageMovements.length > 0 ? pageMovements[pageMovements.length - 1].runningBalance : roundMoney(balanceDelta(selectedAccount, opening.debit, opening.credit)),
      totalDebit: roundMoney(rangeTotals.debit),
      totalCredit: roundMoney(rangeTotals.credit),
      movements: pageMovements,
    },
    totalMovements: count ?? 0,
    page,
    pageSize,
  };
}

export async function getTrialBalanceReport(params: SearchParamsLike): Promise<TrialBalanceReportData> {
  const initialOptions = await getAccountingReportOptions();
  const filters = normalizeFilters(params, initialOptions.periods);
  const options = await getAccountingReportOptions({ accountType: filters.accountType, search: filters.search });
  const accounts = filters.accountId ? options.accounts.filter((account) => account.id === filters.accountId) : options.accounts;
  const accountIds = accounts.map((account) => account.id);
  const [openingRows, movementRows] = await Promise.all([
    getTrialAggregate(filters, true, accountIds),
    getTrialAggregate(filters, false, accountIds),
  ]);

  const openingByAccount = new Map<string, { debit: number; credit: number }>();
  const movementByAccount = new Map<string, { debit: number; credit: number }>();

  for (const row of openingRows) {
    if (!row.account_id) continue;
    openingByAccount.set(row.account_id, { debit: aggregateDebit(row), credit: aggregateCredit(row) });
  }

  for (const row of movementRows) {
    if (!row.account_id) continue;
    movementByAccount.set(row.account_id, { debit: aggregateDebit(row), credit: aggregateCredit(row) });
  }

  const rows: TrialBalanceRow[] = accounts
    .map((account) => {
      const opening = openingByAccount.get(account.id) ?? { debit: 0, credit: 0 };
      const movement = movementByAccount.get(account.id) ?? { debit: 0, credit: 0 };
      const openingBalance = balanceDelta(account, opening.debit, opening.credit);
      const endingBalance = roundMoney(openingBalance + balanceDelta(account, movement.debit, movement.credit));
      return {
        account,
        debit: roundMoney(movement.debit),
        credit: roundMoney(movement.credit),
        endingBalance,
        normalBalance: account.normal_balance,
      };
    })
    .filter((row) => filters.accountId || row.debit !== 0 || row.credit !== 0 || row.endingBalance !== 0)
    .sort((left, right) => left.account.code.localeCompare(right.account.code, "es-HN", { numeric: true }));

  const totalDebit = roundMoney(rows.reduce((sum, row) => sum + row.debit, 0));
  const totalCredit = roundMoney(rows.reduce((sum, row) => sum + row.credit, 0));
  const difference = roundMoney(totalDebit - totalCredit);

  return {
    filters,
    options,
    periodLabel: periodLabel(filters, options.periods),
    generatedAt: new Date().toISOString(),
    rows,
    totalDebit,
    totalCredit,
    totalEndingBalance: roundMoney(rows.reduce((sum, row) => sum + row.endingBalance, 0)),
    difference,
    balanced: Math.abs(difference) < 0.01,
  };
}