export type CrmInteractionType =
  | "seguimiento"
  | "llamada"
  | "nota"
  | "reunion"
  | "prospecto"
  | "contacto_general"
  | "solicitud_mayorista";
export type CrmPriority = "baja" | "media" | "alta" | "urgente";
export type CrmFollowupStatus = "pending" | "completed" | "cancelled";
export type CrmLeadStatus = "prospecto" | "contactado" | "calificado" | "cliente" | "perdido";
export type CrmWholesaleStatus = "none" | "pending" | "approved" | "rejected" | "suspended";
export type CrmProfileKind = "customer" | "internal";

export type CrmCustomerOption = {
  id: string;
  user_id: string | null;
  business_name: string | null;
  company_name: string | null;
  contact_name: string;
  email: string | null;
  phone: string;
  tax_id: string | null;
  city: string | null;
  notes: string | null;
  is_wholesale: boolean;
  wholesale_status: CrmWholesaleStatus;
  wholesale_requested_at: string | null;
  wholesale_request_source: "formulario_publico" | "cuenta_registrada" | "admin" | null;
  wholesale_approved_at: string | null;
  wholesale_approved_notice_seen: boolean;
  status: "active" | "inactive" | "disabled" | "pending_account";
  active: boolean;
  lead_status: CrmLeadStatus;
  estimated_value: number;
  monthly_amount: number;
  created_at: string;
  updated_at: string;
  account_email: string | null;
  account_full_name: string | null;
  account_phone: string | null;
  account_active: boolean | null;
  account_created_at: string | null;
  account_role: import("@/types/auth").AppRole | null;
  profile_kind: CrmProfileKind;
  profile_label: string;
  primary_badges: string[];
  email_confirmed_at: string | null;
  confirmed_at: string | null;
  order_count: number;
  invoice_count: number;
  wholesale_code_count: number;
  total_spent: number;
  last_activity_at: string | null;
  account_state:
    | "Cuenta creada"
    | "Correo electrónico pendiente de confirmar"
    | "Correo electrónico confirmado"
    | "Cliente activo"
    | "Cliente invitado"
    | "Compra sin cuenta"
    | "Prospecto"
    | "Mayorista pendiente"
    | "Mayorista aprobado"
    | "Cuenta suspendida"
    | "Usuario interno"
    | "Business Owner"
    | "Technical Owner";
  customer_type: "Retail" | "Mayorista";
  has_wholesale_request: boolean;
  wholesale_first_purchase_completed: boolean;
  wholesale_lifecycle_status: "Sin acceso mayorista" | "Pendiente de primera compra" | "Primera compra completada" | "Mayorista activo";
  is_test_account: boolean;
  can_delete_permanently: boolean;
  delete_block_reason: string | null;
};

export type CrmFollowupRow = {
  id: string;
  customer_id: string;
  order_id: string | null;
  customer_name: string | null;
  business_name: string | null;
  assigned_user_id: string | null;
  title: string;
  interaction_type: CrmInteractionType;
  next_action: string | null;
  due_at: string | null;
  priority: CrmPriority;
  phone: string | null;
  notes: string | null;
  estimated_value: number;
  monthly_amount: number;
  status: CrmFollowupStatus;
  completed_at: string | null;
  created_at: string;
  customer_account_role: import("@/types/auth").AppRole | null;
  customer_profile_kind: CrmProfileKind;
  customer_profile_label: string;
};

export type CrmNoteRow = {
  id: string;
  customer_id: string;
  customer_name: string | null;
  business_name: string | null;
  user_id: string | null;
  note_type: string;
  note: string;
  archived_at: string | null;
  created_at: string;
};

export type CrmDuplicateCandidate = {
  id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  created_at: string;
  order_count: number;
  invoice_count: number;
  is_test_account: boolean;
  can_merge: boolean;
};

export type CrmDuplicateGroup = {
  key: string;
  match_type: "email" | "phone";
  label: string;
  customers: CrmDuplicateCandidate[];
};

export type CrmCustomerOrderProfileRow = {
  id: string;
  order_number: string;
  tracking_code: string | null;
  created_at: string;
  status: string;
  payment_method: string;
  payment_timing: "before_delivery" | "on_delivery";
  payment_status: string | null;
  bank_reference_number: string | null;
  has_transfer_receipt: boolean;
  price_mode: "retail" | "wholesale";
  subtotal: number;
  tax: number;
  shipping_fee: number;
  cash_on_delivery_fee: number;
  small_order_fee: number;
  discount_total: number;
  additional_fees_total: number;
  total: number;
  invoice_number: string | null;
  invoice_status: string | null;
};

export type CrmCustomerInvoiceProfileRow = {
  id: string;
  invoice_number: string;
  order_id: string;
  order_number: string | null;
  status: string;
  subtotal: number;
  tax: number;
  shipping_fee: number;
  cash_on_delivery_fee: number;
  small_order_fee: number;
  discount_total: number;
  additional_fees_total: number;
  total: number;
  issued_at: string | null;
  created_at: string;
};

export type CrmCustomerWholesaleCodeProfileRow = {
  id: string;
  code: string;
  label: string;
  minimum_order: number;
  max_uses: number | null;
  used_count: number;
  status: string;
  active: boolean;
  expires_at: string | null;
  last_used_at: string | null;
};

export type CrmCustomerWholesaleHistoryRow = {
  id: string;
  note: string;
  created_at: string;
  user_name: string | null;
  user_email: string | null;
};

export type CrmCustomerProfile = {
  customer: CrmCustomerOption;
  orders: CrmCustomerOrderProfileRow[];
  invoices: CrmCustomerInvoiceProfileRow[];
  notes: CrmNoteRow[];
  followups: CrmFollowupRow[];
  wholesaleCodes: CrmCustomerWholesaleCodeProfileRow[];
  wholesaleHistory: CrmCustomerWholesaleHistoryRow[];
};

export type CrmLeadInput = {
  id?: string;
  business_name: string;
  contact_name: string;
  email: string;
  phone: string;
  tax_id: string;
  address: string;
  city: string;
  notes: string;
  lead_status: CrmLeadStatus;
  estimated_value: number;
  monthly_amount: number;
};

export type CrmFollowupInput = {
  id?: string;
  customer_id: string;
  title: string;
  interaction_type: CrmInteractionType;
  next_action: string;
  due_at: string;
  priority: CrmPriority;
  phone: string;
  notes: string;
  estimated_value: number;
  monthly_amount: number;
  status?: CrmFollowupStatus;
};

export type CrmNoteInput = {
  id?: string;
  customer_id: string;
  note_type?: string;
  note: string;
};

export type AdminCrmData = {
  customers: CrmCustomerOption[];
  followups: CrmFollowupRow[];
  notes: CrmNoteRow[];
  duplicateGroups: CrmDuplicateGroup[];
  customersTotal: number;
  followupsTotal: number;
  customerPage: number;
  followupPage: number;
  pageSize: number;
};
