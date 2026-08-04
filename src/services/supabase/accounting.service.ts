import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getAccountingAccountHierarchyOptions } from "@/services/supabase/accounting-account.service";
import type {
  AccountingAccount,
  AccountingDashboardSummary,
  AccountingPageData,
  JournalEntry,
  JournalEntryEditData,
  JournalEntryLine,
  JournalEntrySourceContext,
  JournalEntryViewerData,
} from "@/types/accounting";
import { uuidLike } from "@/utils/validation";

type AccountingPageInput = {
  accountPage?: number;
  accountPageSize?: number;
  journalPage?: number;
  journalPageSize?: number;
};

type JournalEntryRow = Omit<JournalEntry, "lines" | "total_debit" | "total_credit" | "metadata"> & {
  metadata: unknown;
};

type JournalLineRow = Omit<JournalEntryLine, "debit" | "credit" | "account"> & {
  debit: unknown;
  credit: unknown;
  accounting_accounts: JournalEntryLine["account"] | null;
};

type ViewerUserRow = {
  id: string;
  full_name: string | null;
  username: string | null;
  email: string | null;
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
    metadata: row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : {},
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
    .select("id, entry_number, entry_date, description, status, source_type, source_id, created_by, posted_by, posted_at, reversed_entry_id, version, updated_by, metadata, created_at, updated_at")
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
    { count: activeAccountsTotal, error: activeAccountsError },
    accountHierarchyOptions,
    { data: journalRows, error: journalError, count: journalTotal },
    { count: journalEntriesThisMonth, error: monthError },
    { count: draftEntries, error: draftError },
    latestEntry,
    { data: closedPeriods, error: closedPeriodsError },
  ] = await Promise.all([
    supabase
      .from("accounting_accounts")
      .select("id, code, name, type, parent_id, normal_balance, is_active, description, created_by, created_at, updated_at", { count: "exact" })
      .order("code", { ascending: true })
      .range(accountFrom, accountFrom + accountPageSize - 1)
      .returns<AccountingAccount[]>(),
    supabase
      .from("accounting_accounts")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true),
    getAccountingAccountHierarchyOptions(),
    supabase
      .from("journal_entries")
      .select("id, entry_number, entry_date, description, status, source_type, source_id, created_by, posted_by, posted_at, reversed_entry_id, version, updated_by, metadata, created_at, updated_at", { count: "exact" })
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
    supabase
      .from("accounting_periods")
      .select("id, name, start_date, end_date, status")
      .eq("status", "closed")
      .order("start_date", { ascending: true }),
  ]);

  if (accountsError) throw new Error(accountsError.message);
  if (activeAccountsError) throw new Error(activeAccountsError.message);
  if (journalError) throw new Error(journalError.message);
  if (monthError) throw new Error(monthError.message);
  if (draftError) throw new Error(draftError.message);
  if (closedPeriodsError) throw new Error(closedPeriodsError.message);

  const entryIds = (journalRows ?? []).map((entry) => entry.id);
  const linesByEntry = await getLinesByEntryIds(entryIds);
  const journalEntries = (journalRows ?? []).map((entry) => normalizeEntry(entry, linesByEntry.get(entry.id) ?? []));

  const summary: AccountingDashboardSummary = {
    totalAccounts: accountTotal ?? 0,
    activeAccounts: activeAccountsTotal ?? 0,
    journalEntriesThisMonth: journalEntriesThisMonth ?? 0,
    draftEntries: draftEntries ?? 0,
    latestEntry,
  };

  return {
    summary,
    accounts: accounts ?? [],
    accountHierarchyOptions,
    journalEntries,
    closedPeriods: closedPeriods ?? [],
    accountPage,
    accountPageSize,
    accountTotal: accountTotal ?? 0,
    journalPage,
    journalPageSize,
    journalTotal: journalTotal ?? 0,
  };
}

function viewerUserName(user: ViewerUserRow | undefined, fallback: string) {
  return user?.full_name?.trim() || user?.username?.trim() || user?.email?.trim() || fallback;
}

export async function getJournalEntryByIdForViewer(journalEntryId: string): Promise<JournalEntryViewerData | null> {
  const validatedId = uuidLike(journalEntryId, "ID de partida contable");
  if (!validatedId.ok) return null;

  const supabase = await getSupabaseServerClient();
  const { data: entryRow, error: entryError } = await supabase
    .from("journal_entries")
    .select("id, entry_number, entry_date, description, status, source_type, source_id, created_by, posted_by, posted_at, reversed_entry_id, version, updated_by, metadata, created_at, updated_at")
    .eq("id", validatedId.value)
    .maybeSingle<JournalEntryRow>();

  if (entryError) throw new Error(entryError.message);
  if (!entryRow) return null;

  const sourceEntryId = entryRow.source_type === "journal_reversal" && entryRow.source_id
    ? uuidLike(entryRow.source_id, "ID de partida original")
    : null;
  const relatedEntryId = entryRow.reversed_entry_id ?? (sourceEntryId?.ok ? sourceEntryId.value : null);
  const { data: relatedEntryRow, error: relatedEntryError } = relatedEntryId
    ? await supabase
      .from("journal_entries")
      .select("id, entry_number, entry_date, description, status, source_type, source_id, created_by, posted_by, posted_at, reversed_entry_id, version, updated_by, metadata, created_at, updated_at")
      .eq("id", relatedEntryId)
      .maybeSingle<JournalEntryRow>()
    : { data: null, error: null };
  if (relatedEntryError) throw new Error(relatedEntryError.message);

  const reversalMetadata = entryRow.status === "reversada" ? entryRow.metadata : relatedEntryRow?.metadata;
  const metadataObject = reversalMetadata && typeof reversalMetadata === "object" && !Array.isArray(reversalMetadata)
    ? reversalMetadata as Record<string, unknown>
    : {};
  const reversalActorId = typeof metadataObject.reversal_actor_id === "string" ? metadataObject.reversal_actor_id : null;
  const actorIds = [...new Set([entryRow.created_by, entryRow.posted_by, reversalActorId].filter((id): id is string => Boolean(id)))];
  const [linesByEntry, { data: users, error: usersError }] = await Promise.all([
    getLinesByEntryIds([entryRow.id, ...(relatedEntryRow ? [relatedEntryRow.id] : [])]),
    supabase
      .from("users")
      .select("id, full_name, username, email")
      .in("id", actorIds)
      .returns<ViewerUserRow[]>(),
  ]);

  if (usersError) throw new Error(usersError.message);

  const usersById = new Map((users ?? []).map((user) => [user.id, user]));
  const relatedEntry = relatedEntryRow ? normalizeEntry(relatedEntryRow, linesByEntry.get(relatedEntryRow.id) ?? []) : null;
  return {
    entry: normalizeEntry(entryRow, linesByEntry.get(entryRow.id) ?? []),
    creatorName: viewerUserName(usersById.get(entryRow.created_by), entryRow.created_by),
    postedByName: entryRow.posted_by
      ? viewerUserName(usersById.get(entryRow.posted_by), entryRow.posted_by)
      : null,
    reversalRelation: relatedEntry
      ? {
        direction: entryRow.status === "reversada" ? "reversed_by" : "reversal_of",
        entryId: relatedEntry.id,
        entryNumber: relatedEntry.entry_number,
        entryDate: relatedEntry.entry_date,
        status: relatedEntry.status,
        reason: typeof metadataObject.reversal_reason === "string" ? metadataObject.reversal_reason : null,
        actorName: reversalActorId ? viewerUserName(usersById.get(reversalActorId), reversalActorId) : null,
        amount: relatedEntry.total_debit,
      }
      : null,
  };
}

export async function getJournalEntryEditData(entryId: string): Promise<JournalEntryEditData | null> {
  const supabase = await getSupabaseServerClient();
  const { data: entryRow, error: entryError } = await supabase
    .from("journal_entries")
    .select("id, entry_number, entry_date, description, status, source_type, source_id, created_by, posted_by, posted_at, reversed_entry_id, version, updated_by, metadata, created_at, updated_at")
    .eq("id", entryId)
    .maybeSingle<JournalEntryRow>();

  if (entryError) throw new Error(entryError.message);
  if (!entryRow) return null;

  const linesByEntry = await getLinesByEntryIds([entryId]);
  const entry = normalizeEntry(entryRow, linesByEntry.get(entryId) ?? []);
  const { data: creator } = await supabase
    .from("users")
    .select("full_name, username, email")
    .eq("id", entry.created_by)
    .maybeSingle<{ full_name: string | null; username: string | null; email: string | null }>();
  const creatorName = creator?.full_name?.trim() || creator?.username?.trim() || creator?.email?.trim() || entry.created_by;

  let sourceContext: JournalEntrySourceContext | null = null;
  if (entry.source_type === "financial_event" && entry.source_id) {
    const { data: financialEvent, error: eventError } = await supabase
      .from("financial_events")
      .select("id, status, event_purpose, source_type, source_id, source_snapshot")
      .eq("id", entry.source_id)
      .maybeSingle<{
        id: string;
        status: string;
        event_purpose: string;
        source_type: string;
        source_id: string;
        source_snapshot: unknown;
      }>();
    if (eventError) throw new Error(eventError.message);

    if (financialEvent) {
      let accountsPayable: JournalEntrySourceContext["accounts_payable"] = null;
      let purchase: JournalEntrySourceContext["purchase"] = null;
      let supplierInvoice: JournalEntrySourceContext["supplier_invoice"] = null;
      if (financialEvent.source_type === "accounts_payable") {
        const { data: payable, error: payableError } = await supabase
          .from("accounts_payable")
          .select("id, purchase_id, supplier_invoice_id, total_amount, balance, currency, status, due_date")
          .eq("id", financialEvent.source_id)
          .maybeSingle<{
            id: string;
            purchase_id: string | null;
            supplier_invoice_id: string | null;
            total_amount: unknown;
            balance: unknown;
            currency: string;
            status: string;
            due_date: string | null;
          }>();
        if (payableError) throw new Error(payableError.message);
        if (payable) {
          accountsPayable = {
            id: payable.id,
            total_amount: toNumber(payable.total_amount),
            balance: toNumber(payable.balance),
            currency: payable.currency,
            status: payable.status,
            due_date: payable.due_date,
          };
          const [purchaseResult, invoiceResult] = await Promise.all([
            payable.purchase_id
              ? supabase.from("purchases").select("id, purchase_number, subtotal, tax_amount, discount_amount, shipping_amount, total, status").eq("id", payable.purchase_id).maybeSingle()
              : Promise.resolve({ data: null, error: null }),
            payable.supplier_invoice_id
              ? supabase.from("supplier_invoices").select("id, invoice_number, subtotal, tax_amount, discount_amount, total, status").eq("id", payable.supplier_invoice_id).maybeSingle()
              : Promise.resolve({ data: null, error: null }),
          ]);
          if (purchaseResult.error) throw new Error(purchaseResult.error.message);
          if (invoiceResult.error) throw new Error(invoiceResult.error.message);
          if (purchaseResult.data) {
            const row = purchaseResult.data as Record<string, unknown>;
            purchase = {
              id: String(row.id), purchase_number: String(row.purchase_number),
              subtotal: toNumber(row.subtotal), tax_amount: toNumber(row.tax_amount),
              discount_amount: toNumber(row.discount_amount), shipping_amount: toNumber(row.shipping_amount),
              total: toNumber(row.total), status: String(row.status),
            };
          }
          if (invoiceResult.data) {
            const row = invoiceResult.data as Record<string, unknown>;
            supplierInvoice = {
              id: String(row.id), invoice_number: String(row.invoice_number),
              subtotal: toNumber(row.subtotal), tax_amount: toNumber(row.tax_amount),
              discount_amount: toNumber(row.discount_amount), total: toNumber(row.total), status: String(row.status),
            };
          }
        }
      }
      sourceContext = {
        financial_event_id: financialEvent.id,
        event_status: financialEvent.status,
        event_purpose: financialEvent.event_purpose,
        source_type: financialEvent.source_type,
        source_id: financialEvent.source_id,
        source_snapshot: financialEvent.source_snapshot && typeof financialEvent.source_snapshot === "object"
          ? financialEvent.source_snapshot as Record<string, unknown>
          : {},
        accounts_payable: accountsPayable,
        purchase,
        supplier_invoice: supplierInvoice,
      };
    }
  }

  return { entry, creatorName, sourceContext };
}
