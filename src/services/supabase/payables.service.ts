import "server-only";

import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import type {
  AdminAccountsPayable,
  ManualAccountsPayableRecognition,
  AdminSupplierCredit,
  AdminSupplierInvoice,
  PayablesSummary,
  SupplierPaymentWithActor,
} from "@/types/purchases";

type InvoiceQueryRow = Omit<AdminSupplierInvoice, "supplier_name" | "purchase_number"> & {
  suppliers: { name: string } | null;
  purchases: { purchase_number: string } | null;
};

type CreditQueryRow = Omit<AdminSupplierCredit, "supplier_name" | "purchase_number" | "invoice_number"> & {
  suppliers: { name: string } | null;
  purchases: { purchase_number: string } | null;
  supplier_invoices: { invoice_number: string } | null;
};

type PaymentQueryRow = Omit<SupplierPaymentWithActor, "created_by_name" | "created_by_email"> & {
  users: { full_name: string | null; email: string | null } | null;
};

type PayableQueryRow = Omit<AdminAccountsPayable, "supplier_name" | "supplier_tax_id" | "purchase_number" | "invoice_number" | "recognition_state" | "recognition" | "payments"> & {
  imported_from_batch_id: string | null;
  imported_from_row_id: string | null;
  suppliers: { name: string; tax_id: string | null } | null;
  purchases: { purchase_number: string } | null;
  supplier_invoices: { invoice_number: string } | null;
  supplier_payments: PaymentQueryRow[] | null;
  manual_recognition: Array<{
    id: string;
    accounts_payable_id: string;
    state: ManualAccountsPayableRecognition["state"];
    accounting_date: string | null;
    debit_account_id: string | null;
    concept: string | null;
    source_reference: string | null;
    subtotal: unknown;
    tax_amount: unknown;
    discount_amount: unknown;
    financial_event_id: string | null;
    journal_entry_id: string | null;
    updated_at: string;
    debit_account: { code: string; name: string } | null;
    journal_entry: { status: ManualAccountsPayableRecognition["journal_status"] } | null;
  }> | null;
};

function toNumber(value: unknown) {
  return Number(value ?? 0);
}

function tegucigalpaDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

function normalizeInvoice(row: InvoiceQueryRow): AdminSupplierInvoice {
  return {
    ...row,
    subtotal: toNumber(row.subtotal),
    tax_amount: toNumber(row.tax_amount),
    discount_amount: toNumber(row.discount_amount),
    total: toNumber(row.total),
    supplier_name: row.suppliers?.name ?? "Proveedor",
    purchase_number: row.purchases?.purchase_number ?? null,
  };
}

function normalizeCredit(row: CreditQueryRow): AdminSupplierCredit {
  return {
    ...row,
    amount: toNumber(row.amount),
    remaining_amount: toNumber(row.remaining_amount),
    supplier_name: row.suppliers?.name ?? "Proveedor",
    purchase_number: row.purchases?.purchase_number ?? null,
    invoice_number: row.supplier_invoices?.invoice_number ?? null,
  };
}

function normalizePayment(row: PaymentQueryRow): SupplierPaymentWithActor {
  const { users, ...payment } = row;
  return {
    ...payment,
    amount: toNumber(payment.amount),
    created_by_name: users?.full_name ?? null,
    created_by_email: users?.email ?? null,
  };
}

function normalizePayable(row: PayableQueryRow): AdminAccountsPayable {
  const rawRecognition = row.manual_recognition?.[0] ?? null;
  const recognition: ManualAccountsPayableRecognition | null = rawRecognition
    ? {
        id: rawRecognition.id,
        accounts_payable_id: rawRecognition.accounts_payable_id,
        state: rawRecognition.journal_entry?.status === "publicada"
          ? "recognized"
          : rawRecognition.journal_entry?.status === "borrador"
            ? "draft_pending_publication"
            : rawRecognition.state,
        accounting_date: rawRecognition.accounting_date,
        debit_account_id: rawRecognition.debit_account_id,
        debit_account_code: rawRecognition.debit_account?.code ?? null,
        debit_account_name: rawRecognition.debit_account?.name ?? null,
        concept: rawRecognition.concept,
        source_reference: rawRecognition.source_reference,
        subtotal: rawRecognition.subtotal === null ? null : toNumber(rawRecognition.subtotal),
        tax_amount: rawRecognition.tax_amount === null ? null : toNumber(rawRecognition.tax_amount),
        discount_amount: rawRecognition.discount_amount === null ? null : toNumber(rawRecognition.discount_amount),
        financial_event_id: rawRecognition.financial_event_id,
        journal_entry_id: rawRecognition.journal_entry_id,
        journal_status: rawRecognition.journal_entry?.status ?? null,
        updated_at: rawRecognition.updated_at,
      }
    : null;
  const recognitionState = recognition?.state
    ?? (row.purchase_id || row.supplier_invoice_id || row.imported_from_batch_id || row.imported_from_row_id || row.accounting_recognition_version === "v2"
      ? "source_backed"
      : "pending_accounting_recognition");
  const { manual_recognition: _manualRecognition, imported_from_batch_id: _importBatch, imported_from_row_id: _importRow, ...payable } = row;
  void _manualRecognition;
  void _importBatch;
  void _importRow;
  return {
    ...payable,
    total_amount: toNumber(row.total_amount),
    paid_amount: toNumber(row.paid_amount),
    balance: toNumber(row.balance),
    supplier_name: row.suppliers?.name ?? "Proveedor",
    supplier_tax_id: row.suppliers?.tax_id ?? null,
    purchase_number: row.purchases?.purchase_number ?? null,
    invoice_number: row.supplier_invoices?.invoice_number ?? null,
    recognition_state: recognitionState,
    recognition,
    payments: (row.supplier_payments ?? []).map(normalizePayment).sort((left, right) => right.created_at.localeCompare(left.created_at)),
  };
}

export async function getAdminSupplierInvoices(): Promise<AdminSupplierInvoice[]> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("supplier_invoices")
    .select(
      `
      id,
      supplier_id,
      purchase_id,
      invoice_number,
      invoice_date,
      due_date,
      status,
      subtotal,
      tax_amount,
      discount_amount,
      total,
      currency,
      notes,
      created_by,
      received_by,
      received_at,
      cancelled_by,
      cancelled_at,
      created_at,
      updated_at,
      suppliers(name),
      purchases(purchase_number)
    `,
    )
    .order("invoice_date", { ascending: false })
    .limit(500)
    .returns<InvoiceQueryRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(normalizeInvoice);
}

export async function getAdminSupplierCredits(): Promise<AdminSupplierCredit[]> {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("supplier_credits")
    .select(
      `
      id,
      supplier_id,
      purchase_id,
      supplier_invoice_id,
      accounts_payable_id,
      credit_number,
      credit_date,
      amount,
      remaining_amount,
      status,
      reason,
      created_by,
      applied_by,
      applied_at,
      cancelled_by,
      cancelled_at,
      created_at,
      updated_at,
      suppliers(name),
      purchases(purchase_number),
      supplier_invoices(invoice_number)
    `,
    )
    .order("credit_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(500)
    .returns<CreditQueryRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).map(normalizeCredit);
}

export async function getAdminPayables(): Promise<{ payables: AdminAccountsPayable[]; invoices: AdminSupplierInvoice[]; credits: AdminSupplierCredit[]; summary: PayablesSummary }> {
  const admin = getSupabaseAdminClient();
  const [payablesResult, invoices, credits] = await Promise.all([
    admin
      .from("accounts_payable")
      .select(
        `
        id,
        supplier_id,
        purchase_id,
        supplier_invoice_id,
        total_amount,
        paid_amount,
        balance,
        due_date,
        status,
        currency,
        notes,
        created_by,
        cancelled_by,
        cancelled_at,
        automation_source,
        accounting_recognition_version,
        imported_from_batch_id,
        imported_from_row_id,
        created_at,
        updated_at,
        suppliers(name, tax_id),
        purchases(purchase_number),
        supplier_invoices(invoice_number),
        manual_recognition:manual_accounts_payable_recognitions!manual_ap_recognition_payable_fkey(
          id,
          accounts_payable_id,
          state,
          accounting_date,
          debit_account_id,
          concept,
          source_reference,
          subtotal,
          tax_amount,
          discount_amount,
          financial_event_id,
          journal_entry_id,
          updated_at,
          debit_account:accounting_accounts!manual_ap_recognition_debit_account_fkey(code, name),
          journal_entry:journal_entries!manual_ap_recognition_journal_fkey(status)
        ),
        supplier_payments(id, accounts_payable_id, supplier_id, amount, payment_method, status, paid_at, notes, created_by, voided_by, voided_at, created_at, updated_at, users:users!supplier_payments_created_by_fkey(full_name, email))
      `,
      )
      .order("due_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(500)
      .returns<PayableQueryRow[]>(),
    getAdminSupplierInvoices(),
    getAdminSupplierCredits(),
  ]);

  if (payablesResult.error) {
    throw new Error(payablesResult.error.message);
  }

  const payables = (payablesResult.data ?? []).map(normalizePayable);
  const today = tegucigalpaDate();
  const month = today.slice(0, 7);
  const activePayables = payables.filter((payable) => payable.status !== "cancelled");
  const overduePayables = activePayables.filter((payable) => payable.balance > 0 && payable.due_date !== null && payable.due_date < today);
  const activePayments = payables.flatMap((payable) => payable.payments.filter((payment) => payment.status === "paid"));
  const appliedCredits = credits.filter((credit) => credit.status === "applied");

  return {
    payables,
    invoices,
    credits,
    summary: {
      totalPending: activePayables.filter((payable) => payable.balance > 0).reduce((sum, payable) => sum + payable.balance, 0),
      totalOverdue: overduePayables.reduce((sum, payable) => sum + payable.balance, 0),
      paidThisMonth: activePayments
        .filter((payment) => (payment.paid_at ?? payment.created_at).slice(0, 7) === month)
        .reduce((sum, payment) => sum + payment.amount, 0),
      creditedThisMonth: appliedCredits
        .filter((credit) => (credit.applied_at ?? credit.created_at).slice(0, 7) === month)
        .reduce((sum, credit) => sum + credit.amount, 0),
      pendingCount: activePayables.filter((payable) => payable.status === "pending" || payable.status === "partial").length,
      overdueCount: overduePayables.length,
      paidCount: activePayables.filter((payable) => payable.status === "paid").length,
    },
  };
}
