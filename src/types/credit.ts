export type CommercialCreditStatus = "active" | "suspended";
export type AccountsReceivableStatus = "open" | "paid" | "overdue";

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
  order_id: string;
  invoice_id: string | null;
  original_amount: number;
  balance_due: number;
  due_date: string;
  status: AccountsReceivableStatus;
  paid_at: string | null;
  overdue_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AdminAccountsReceivableRow = AccountsReceivableRow & {
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  order_number: string | null;
  invoice_number: string | null;
};

export type ReceivablesSummary = {
  totalPending: number;
  customersWithDebt: number;
  dueInSevenDays: number;
  overdue: number;
};
