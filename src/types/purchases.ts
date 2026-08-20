export type Supplier = {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  tax_id: string | null;
  address: string | null;
  notes: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type PurchaseStatus = "draft" | "confirmed" | "received" | "cancelled" | "returned";
export type PurchasePaymentCondition = "cash" | "credit" | "partial";

export type Purchase = {
  id: string;
  supplier_id: string;
  purchase_number: string;
  purchase_date: string;
  status: PurchaseStatus;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  shipping_amount: number;
  total: number;
  currency: string;
  notes: string | null;
  created_by: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  payment_condition: PurchasePaymentCondition | null;
  confirmed_due_date: string | null;
  confirmation_request_key: string | null;
  confirmation_fingerprint: string | null;
  initial_supplier_payment_id: string | null;
  cancellation_request_key: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PurchasePayableSummary = {
  id: string;
  status: AccountsPayableStatus;
  total_amount: number;
  paid_amount: number;
  balance: number;
  due_date: string | null;
  automation_source: "purchase_confirmation_v1" | null;
};

export type PurchaseSupplierInvoiceSummary = {
  id: string;
  invoice_number: string;
  due_date: string | null;
  status: SupplierInvoiceStatus;
};

export type PurchaseItem = {
  id: string;
  purchase_id: string;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_cost: number;
  tax_amount: number;
  discount_amount: number;
  total_cost: number;
  inventory_movement_id: string | null;
  created_at: string;
};

export type SupplierInvoiceStatus = "draft" | "received" | "posted_to_ap" | "cancelled" | "paid";

export type SupplierInvoice = {
  id: string;
  supplier_id: string;
  purchase_id: string | null;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  status: SupplierInvoiceStatus;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  total: number;
  currency: string;
  notes: string | null;
  created_by: string | null;
  received_by: string | null;
  received_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type AccountsPayableStatus = "pending" | "partial" | "paid" | "cancelled" | "overdue";

export type AccountsPayableRecognitionState =
  | "pending_accounting_recognition"
  | "draft_pending_publication"
  | "recognized"
  | "blocked"
  | "source_backed";

export type ManualAccountsPayableRecognition = {
  id: string;
  accounts_payable_id: string;
  state: Exclude<AccountsPayableRecognitionState, "source_backed">;
  accounting_date: string | null;
  debit_account_id: string | null;
  debit_account_code: string | null;
  debit_account_name: string | null;
  concept: string | null;
  source_reference: string | null;
  subtotal: number | null;
  tax_amount: number | null;
  discount_amount: number | null;
  financial_event_id: string | null;
  journal_entry_id: string | null;
  journal_status: "borrador" | "publicada" | "reversada" | "anulada" | null;
  updated_at: string;
};

export type AccountsPayable = {
  id: string;
  supplier_id: string;
  purchase_id: string | null;
  supplier_invoice_id: string | null;
  total_amount: number;
  paid_amount: number;
  balance: number;
  due_date: string | null;
  status: AccountsPayableStatus;
  automation_source: "purchase_confirmation_v1" | null;
  accounting_recognition_version: "v2" | null;
  currency: string;
  notes: string | null;
  created_by: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SupplierPaymentStatus = "draft" | "paid" | "voided";

export type SupplierPayment = {
  id: string;
  accounts_payable_id: string;
  supplier_id: string;
  amount: number;
  payment_method: string;
  status: SupplierPaymentStatus;
  paid_at: string | null;
  notes: string | null;
  created_by: string | null;
  voided_by: string | null;
  voided_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PurchaseReturnStatus = "draft" | "confirmed" | "cancelled";

export type PurchaseReturn = {
  id: string;
  purchase_id: string;
  supplier_id: string;
  accounts_payable_id: string | null;
  return_number: string;
  return_date: string;
  status: PurchaseReturnStatus;
  subtotal: number;
  tax_amount: number;
  total: number;
  reason: string | null;
  created_by: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};

export type SupplierCreditStatus = "open" | "applied" | "cancelled";

export type SupplierCredit = {
  id: string;
  supplier_id: string;
  purchase_id: string | null;
  supplier_invoice_id: string | null;
  accounts_payable_id: string | null;
  credit_number: string;
  credit_date: string;
  amount: number;
  remaining_amount: number;
  status: SupplierCreditStatus;
  reason: string | null;
  created_by: string | null;
  applied_by: string | null;
  applied_at: string | null;
  cancelled_by: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
};
export type SupplierSummary = {
  total: number;
  active: number;
  inactive: number;
};

export type SupplierOption = Pick<Supplier, "id" | "name" | "is_active" | "tax_id">;

export type ProductPurchaseOption = {
  id: string;
  sku: string | null;
  name: string;
  cost_price: number;
  active: boolean;
  status: "active" | "inactive" | "draft" | "archived";
  available_stock: number;
  auto_disabled_by_stock: boolean;
};

export type PurchaseItemWithProduct = PurchaseItem & {
  product_name: string | null;
  product_sku: string | null;
};

export type AdminPurchase = Purchase & {
  supplier_name: string;
  supplier_tax_id: string | null;
  items: PurchaseItemWithProduct[];
  returns: PurchaseReturn[];
  payable: PurchasePayableSummary | null;
  supplier_invoice: PurchaseSupplierInvoiceSummary | null;
};

export type PurchasesSummary = {
  totalDraft: number;
  totalConfirmed: number;
  totalCancelled: number;
  totalReturned: number;
  totalAmount: number;
};

export type SupplierPaymentWithActor = SupplierPayment & {
  created_by_name: string | null;
  created_by_email: string | null;
};

export type AdminSupplierInvoice = SupplierInvoice & {
  supplier_name: string;
  purchase_number: string | null;
};

export type AdminAccountsPayable = AccountsPayable & {
  supplier_name: string;
  supplier_tax_id: string | null;
  purchase_number: string | null;
  invoice_number: string | null;
  recognition_state: AccountsPayableRecognitionState;
  recognition: ManualAccountsPayableRecognition | null;
  payments: SupplierPaymentWithActor[];
};

export type AdminSupplierCredit = SupplierCredit & {
  supplier_name: string;
  purchase_number: string | null;
  invoice_number: string | null;
};

export type PayablesSummary = {
  totalPending: number;
  totalOverdue: number;
  paidThisMonth: number;
  creditedThisMonth: number;
  pendingCount: number;
  overdueCount: number;
  paidCount: number;
};


