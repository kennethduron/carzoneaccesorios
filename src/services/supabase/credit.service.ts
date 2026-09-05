import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import type {
  AccountsReceivableRow,
  AccountsReceivablePaymentRow,
  AdminAccountsReceivableRow,
  CustomerCreditAccount,
  ReceivablesSummary,
} from "@/types/credit";
import type { InvoiceStatus } from "@/types/invoices";

export type CustomerCreditNotification = {
  id: string;
  title: string;
  message: string;
  created_at: string;
};

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

function toNullableNumber(value: unknown) {
  return value === null || value === undefined ? null : toNumber(value);
}

function tegucigalpaDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

type CreditAccountQueryRow = Omit<CustomerCreditAccount, "credit_limit"> & {
  credit_limit: unknown;
};

type ReceivableQueryRow = Omit<AccountsReceivableRow, "original_amount" | "total_paid" | "balance_due" | "payments" | "order_number"> & {
  original_amount: unknown;
  balance_due: unknown;
  orders?: {
    order_number: string | null;
  } | null;
  accounts_receivable_payments?: PaymentQueryRow[] | null;
};

type PaymentQueryRow = Omit<AccountsReceivablePaymentRow, "amount" | "balance_before" | "balance_after" | "recorded_by_name" | "recorded_by_email"> & {
  amount: unknown;
  balance_before?: unknown;
  balance_after?: unknown;
  recorded_by_user?: {
    full_name: string | null;
    email: string | null;
  } | Array<{
    full_name: string | null;
    email: string | null;
  }> | null;
};

type AdminReceivableQueryRow = ReceivableQueryRow & {
  historical_invoice_number: string | null;
  customers: {
    contact_name: string | null;
    business_name: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  orders: {
    order_number: string | null;
  } | null;
  invoices: {
    invoice_number: string | null;
    status: InvoiceStatus;
  } | null;
};

export function normalizeCreditAccount(row: CreditAccountQueryRow): CustomerCreditAccount {
  return {
    ...row,
    credit_limit: toNumber(row.credit_limit),
  };
}

export function normalizeReceivable(row: ReceivableQueryRow): AccountsReceivableRow {
  const payments = (row.accounts_receivable_payments ?? []).map(normalizeReceivablePayment);
  const totalPaid = payments
    .filter((payment) => !payment.voided_at)
    .reduce((sum, payment) => sum + payment.amount, 0);

  return {
    ...row,
    original_amount: toNumber(row.original_amount),
    total_paid: Math.round(totalPaid * 100) / 100,
    balance_due: toNumber(row.balance_due),
    order_number: row.orders?.order_number ?? null,
    payments,
  };
}

export function normalizeReceivablePayment(row: PaymentQueryRow): AccountsReceivablePaymentRow {
  const { recorded_by_user: recordedByUser, ...payment } = row;
  const recorder = Array.isArray(recordedByUser) ? recordedByUser[0] : recordedByUser;

  return {
    ...payment,
    amount: toNumber(payment.amount),
    balance_before: toNullableNumber(payment.balance_before),
    balance_after: toNullableNumber(payment.balance_after),
    recorded_by_name: recorder?.full_name ?? null,
    recorded_by_email: recorder?.email ?? null,
    accounting_trace: payment.accounting_trace ?? null,
  };
}

export async function getActiveCreditAccountForUser(userId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("customer_credit_accounts")
    .select(
      `
      id,
      customer_id,
      is_credit_enabled,
      credit_limit,
      terms_days,
      status,
      activated_at,
      activated_by,
      suspended_at,
      suspended_by,
      notes,
      created_at,
      updated_at,
      customers!inner(user_id, active)
    `,
    )
    .eq("customers.user_id", userId)
    .eq("customers.active", true)
    .eq("is_credit_enabled", true)
    .eq("status", "active")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle<CreditAccountQueryRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ? normalizeCreditAccount(data) : null;
}

export async function getOpenCreditBalance(customerId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("accounts_receivable")
    .select("balance_due")
    .eq("customer_id", customerId)
    .in("status", ["open", "partial", "overdue"])
    .returns<Array<{ balance_due: unknown }>>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).reduce((sum, row) => sum + toNumber(row.balance_due), 0);
}

export async function getCustomerReceivablesForUser(userId: string, limit = 20) {
  const admin = getSupabaseAdminClient();
  const { data: customers, error: customersError } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", userId)
    .eq("active", true)
    .returns<Array<{ id: string }>>();

  if (customersError) {
    throw new Error(customersError.message);
  }

  const customerIds = (customers ?? []).map((customer) => customer.id);
  if (customerIds.length === 0) {
    return [];
  }

  const { data, error } = await admin
    .from("accounts_receivable")
    .select(`
      id,
      customer_id,
      order_id,
      invoice_id,
      original_amount,
      balance_due,
      due_date,
      status,
      paid_at,
      overdue_at,
      payment_received_method,
      payment_received_reference,
      payment_recorded_by,
      created_at,
      updated_at,
      orders(order_number),
      accounts_receivable_payments(id, receivable_id, customer_id, order_id, amount, payment_method, reference, received_at, note, receipt_url, receipt_public_id, recorded_by, voided_at, voided_by, void_reason, created_at)
    `)
    .in("customer_id", customerIds)
    .order("created_at", { ascending: false })
    .limit(limit)
    .returns<ReceivableQueryRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(normalizeReceivable);
}

export async function getCustomerCreditAccount(customerId: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("customer_credit_accounts")
    .select("id, customer_id, is_credit_enabled, credit_limit, terms_days, status, activated_at, activated_by, suspended_at, suspended_by, notes, created_at, updated_at")
    .eq("customer_id", customerId)
    .maybeSingle<CreditAccountQueryRow>();

  if (error) {
    throw new Error(error.message);
  }

  return data ? normalizeCreditAccount(data) : null;
}

export async function getCustomerReceivables(customerId: string, limit = 50) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("accounts_receivable")
    .select(`
      id,
      customer_id,
      order_id,
      invoice_id,
      original_amount,
      balance_due,
      due_date,
      status,
      paid_at,
      overdue_at,
      payment_received_method,
      payment_received_reference,
      payment_recorded_by,
      created_at,
      updated_at,
      orders(order_number),
      accounts_receivable_payments(id, receivable_id, customer_id, order_id, amount, balance_before, balance_after, payment_method, reference, received_at, note, receipt_url, receipt_public_id, recorded_by, voided_at, voided_by, void_reason, created_at, recorded_by_user:users!accounts_receivable_payments_recorded_by_fkey(full_name, email))
    `)
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(limit)
    .returns<ReceivableQueryRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  const rows = (data ?? []).map(normalizeReceivable);
  const paymentIds = rows.flatMap((row) => row.payments.map((payment) => payment.id));
  const [{ data: eventRows, error: eventsError }, { data: outboxRows, error: outboxError }] = paymentIds.length > 0
    ? await Promise.all([
        admin
          .from("financial_events")
          .select("id, source_id, status, journal_entry_id, journal_entries(id, entry_number, status)")
          .eq("source_type", "receivable_payment")
          .eq("event_purpose", "receivable_payment")
          .eq("posting_version", "v1")
          .in("source_id", paymentIds),
        admin
          .from("accounting_outbox")
          .select("id, source_id, status, attempts")
          .eq("source_type", "receivable_payment")
          .eq("event_purpose", "receivable_payment")
          .eq("posting_version", "v1")
          .in("source_id", paymentIds),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];

  if (eventsError) throw new Error(eventsError.message);
  if (outboxError) throw new Error(outboxError.message);

  const eventByPayment = new Map((eventRows ?? []).map((event) => [event.source_id, event]));
  const outboxByPayment = new Map((outboxRows ?? []).map((outbox) => [outbox.source_id, outbox]));

  return rows.map((row) => ({
    ...row,
    payments: row.payments.map((payment) => {
      const event = eventByPayment.get(payment.id);
      const outbox = outboxByPayment.get(payment.id);
      const journal = Array.isArray(event?.journal_entries) ? event.journal_entries[0] : event?.journal_entries;
      return {
        ...payment,
        accounting_trace: {
          outbox_id: outbox?.id ?? null,
          outbox_status: outbox?.status ?? null,
          attempts: Number(outbox?.attempts ?? 0),
          event_id: event?.id ?? null,
          event_status: event?.status ?? null,
          journal_entry_id: event?.journal_entry_id ?? null,
          journal_entry_number: journal?.entry_number ?? null,
          journal_entry_status: journal?.status ?? null,
        },
      };
    }),
  }));
}

export async function getAdminAccountsReceivable(): Promise<{
  rows: AdminAccountsReceivableRow[];
  summary: ReceivablesSummary;
}> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("accounts_receivable")
    .select(
      `
      id,
      customer_id,
      order_id,
      invoice_id,
      original_amount,
      balance_due,
      due_date,
      status,
      paid_at,
      overdue_at,
      payment_received_method,
      payment_received_reference,
      payment_recorded_by,
      historical_invoice_number,
      created_at,
      updated_at,
      accounts_receivable_payments(id, receivable_id, customer_id, order_id, amount, balance_before, balance_after, payment_method, reference, received_at, note, receipt_url, receipt_public_id, recorded_by, voided_at, voided_by, void_reason, created_at, recorded_by_user:users!accounts_receivable_payments_recorded_by_fkey(full_name, email)),
      customers(contact_name, business_name, email, phone),
      orders(order_number),
      invoices(invoice_number, status)
    `,
    )
    .order("created_at", { ascending: false })
    .order("due_date", { ascending: true })
    .limit(500)
    .returns<AdminReceivableQueryRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  const baseRows = (data ?? []).map((row) => {
    const base = normalizeReceivable(row);
    return {
      ...base,
      customer_name: row.customers?.business_name || row.customers?.contact_name || "Cliente",
      customer_email: row.customers?.email ?? null,
      customer_phone: row.customers?.phone ?? null,
      order_number: row.orders?.order_number ?? null,
      invoice_number: row.invoices?.invoice_number ?? row.historical_invoice_number ?? null,
      invoice_status: row.invoices?.status ?? null,
    };
  });
  const paymentIds = baseRows.flatMap((row) => row.payments.map((payment) => payment.id));
  const [{ data: eventRows, error: eventsError }, { data: outboxRows, error: outboxError }] = paymentIds.length > 0
    ? await Promise.all([
        admin
          .from("financial_events")
          .select("id, source_id, status, journal_entry_id, journal_entries(id, entry_number, status)")
          .eq("source_type", "receivable_payment")
          .eq("event_purpose", "receivable_payment")
          .eq("posting_version", "v1")
          .in("source_id", paymentIds),
        admin
          .from("accounting_outbox")
          .select("id, source_id, status, attempts")
          .eq("source_type", "receivable_payment")
          .eq("event_purpose", "receivable_payment")
          .eq("posting_version", "v1")
          .in("source_id", paymentIds),
      ])
    : [{ data: [], error: null }, { data: [], error: null }];

  if (eventsError) throw new Error(eventsError.message);
  if (outboxError) throw new Error(outboxError.message);

  const eventByPayment = new Map((eventRows ?? []).map((event) => [event.source_id, event]));
  const outboxByPayment = new Map((outboxRows ?? []).map((outbox) => [outbox.source_id, outbox]));
  const rows = baseRows.map((row) => ({
    ...row,
    payments: row.payments.map((payment) => {
      const event = eventByPayment.get(payment.id);
      const outbox = outboxByPayment.get(payment.id);
      const journal = Array.isArray(event?.journal_entries) ? event.journal_entries[0] : event?.journal_entries;
      return {
        ...payment,
        accounting_trace: {
          outbox_id: outbox?.id ?? null,
          outbox_status: outbox?.status ?? null,
          attempts: Number(outbox?.attempts ?? 0),
          event_id: event?.id ?? null,
          event_status: event?.status ?? null,
          journal_entry_id: event?.journal_entry_id ?? null,
          journal_entry_number: journal?.entry_number ?? null,
          journal_entry_status: journal?.status ?? null,
        },
      };
    }),
  }));
  const pendingRows = rows.filter((row) => row.status !== "paid" && row.status !== "cancelled" && row.balance_due > 0);
  const uniqueCustomers = new Set(pendingRows.map((row) => row.customer_id));
  const today = tegucigalpaDate();
  const inSevenDays = tegucigalpaDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
  const currentMonth = today.slice(0, 7);
  const overdueRows = pendingRows.filter((row) => row.status === "overdue" || row.due_date < today);
  const activePayments = rows.flatMap((row) => row.payments.filter((payment) => !payment.voided_at));
  const topDebtorsByCustomer = new Map<string, { customerId: string; customerName: string; balanceDue: number }>();

  for (const row of pendingRows) {
    const debtor = topDebtorsByCustomer.get(row.customer_id) ?? {
      customerId: row.customer_id,
      customerName: row.customer_name,
      balanceDue: 0,
    };
    debtor.balanceDue += row.balance_due;
    topDebtorsByCustomer.set(row.customer_id, debtor);
  }

  return {
    rows,
    summary: {
      totalPending: pendingRows.reduce((sum, row) => sum + row.balance_due, 0),
      overdueBalance: overdueRows.reduce((sum, row) => sum + row.balance_due, 0),
      collectedToday: activePayments
        .filter((payment) => tegucigalpaDate(new Date(payment.received_at)) === today)
        .reduce((sum, payment) => sum + payment.amount, 0),
      collectedThisMonth: activePayments
        .filter((payment) => tegucigalpaDate(new Date(payment.received_at)).startsWith(currentMonth))
        .reduce((sum, payment) => sum + payment.amount, 0),
      customersWithDebt: uniqueCustomers.size,
      dueInSevenDays: pendingRows.filter((row) => row.due_date >= today && row.due_date <= inSevenDays).length,
      overdue: overdueRows.length,
      upcomingReceivables: [...pendingRows]
        .filter((row) => row.due_date >= today)
        .sort((left, right) => left.due_date.localeCompare(right.due_date))
        .slice(0, 5)
        .map((row) => ({
          id: row.id,
          customerName: row.customer_name,
          orderNumber: row.order_number,
          balanceDue: row.balance_due,
          dueDate: row.due_date,
        })),
      topDebtors: [...topDebtorsByCustomer.values()].sort((left, right) => right.balanceDue - left.balanceDue).slice(0, 5),
    },
  };
}

export async function getUnreadCustomerCreditNotifications(userId: string): Promise<CustomerCreditNotification[]> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("internal_notifications")
    .select("id, title, message, created_at")
    .eq("user_id", userId)
    .eq("notification_type", "commercial_credit.enabled")
    .eq("read_state", "unread")
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(5)
    .returns<CustomerCreditNotification[]>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}
