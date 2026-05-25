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
  email_confirmed_at: string | null;
  confirmed_at: string | null;
  order_count: number;
  invoice_count: number;
  wholesale_code_count: number;
  total_spent: number;
  last_activity_at: string | null;
  account_state:
    | "Cuenta creada"
    | "Correo pendiente de confirmar"
    | "Correo confirmado"
    | "Cliente activo"
    | "Mayorista pendiente"
    | "Mayorista aprobado"
    | "Cuenta suspendida";
  customer_type: "Retail" | "Mayorista";
  has_wholesale_request: boolean;
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
  payment_status: string | null;
  price_mode: "retail" | "wholesale";
  total: number;
  invoice_number: string | null;
};

export type CrmCustomerInvoiceProfileRow = {
  id: string;
  invoice_number: string;
  order_id: string;
  order_number: string | null;
  status: string;
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
