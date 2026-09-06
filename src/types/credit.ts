import type { InvoiceStatus } from "@/types/invoices";

export type CommercialCreditStatus = "active" | "suspended";
export type AccountsReceivableStatus = "open" | "partial" | "paid" | "overdue" | "cancelled";
export type CommercialCreditPaymentReceivedMethod = "bank_transfer" | "card" | "cash";

export type ReceivablePaymentAccountingTrace = {
  outbox_id: string | null;
  outbox_status: "queued" | "processing" | "completed" | "failed" | null;
  attempts: number;
  event_id: string | null;
  event_status: string | null;
  journal_entry_id: string | null;
  journal_entry_number: string | null;
  journal_entry_status: string | null;
};

export type AccountsReceivablePaymentRow = {
  id: string;
  receivable_id: string;
  customer_id: string;
  order_id: string | null;
  amount: number;
  balance_before: number | null;
  balance_after: number | null;
  payment_method: CommercialCreditPaymentReceivedMethod;
  reference: string | null;
  received_at: string;
  note: string | null;
  receipt_url: string | null;
  receipt_public_id: string | null;
  recorded_by: string | null;
  recorded_by_name: string | null;
  recorded_by_email: string | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  accounting_trace?: ReceivablePaymentAccountingTrace | null;
  created_at: string;
};

export type CustomerCreditAccount = {
  id: string;
  customer_id: string;
  is_credit_enabled: boolean;
  credit_limit: number;
  terms_days: number;
  status: CommercialCreditStatus;
  activated_at: string | null;
  activated_by: string | null;
  suspended_at: string | null;
  suspended_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type AccountsReceivableRow = {
  id: string;
  customer_id: string;
  order_id: string | null;
  invoice_id: string | null;
  original_amount: number;
  total_paid: number;
  balance_due: number;
  due_date: string;
  status: AccountsReceivableStatus;
  paid_at: string | null;
  overdue_at: string | null;
  payment_received_method: CommercialCreditPaymentReceivedMethod | null;
  payment_received_reference: string | null;
  payment_recorded_by: string | null;
  order_number?: string | null;
  payments: AccountsReceivablePaymentRow[];
  created_at: string;
  updated_at: string;
};

export type AdminAccountsReceivableRow = AccountsReceivableRow & {
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  order_number: string | null;
  invoice_number: string | null;
  invoice_status: InvoiceStatus | null;
};

export type ReceivablesSummary = {
  totalPending: number;
  overdueBalance: number;
  collectedToday: number;
  collectedThisMonth: number;
  customersWithDebt: number;
  dueInSevenDays: number;
  overdue: number;
  upcomingReceivables: Array<{
    id: string;
    customerName: string;
    orderNumber: string | null;
    balanceDue: number;
    dueDate: string;
  }>;
  topDebtors: Array<{
    customerId: string;
    customerName: string;
    balanceDue: number;
  }>;
};

export type AdminReceivableFilter = "pending" | "partial" | "overdue" | "paid" | "all";
export type AdminReceivableSort = "created" | "due" | "balance";
export type AdminReceivableSortDirection = "asc" | "desc";

export type AdminAccountsReceivablePage = {
  rows: AdminAccountsReceivableRow[];
  summary: ReceivablesSummary;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  truncated: boolean;
  filter: AdminReceivableFilter;
  query: string;
  sort: AdminReceivableSort;
  direction: AdminReceivableSortDirection;
};
