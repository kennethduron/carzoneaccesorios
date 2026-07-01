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
  cancelled_by: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
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
