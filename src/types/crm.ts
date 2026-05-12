export type CrmInteractionType = "seguimiento" | "llamada" | "nota" | "reunion" | "prospecto";
export type CrmPriority = "baja" | "media" | "alta" | "urgente";
export type CrmFollowupStatus = "pending" | "completed" | "cancelled";
export type CrmLeadStatus = "prospecto" | "contactado" | "calificado" | "cliente" | "perdido";

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
  note: string;
  created_at: string;
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
};

export type CrmNoteInput = {
  customer_id: string;
  note: string;
};

export type AdminCrmData = {
  customers: CrmCustomerOption[];
  followups: CrmFollowupRow[];
  notes: CrmNoteRow[];
  customersTotal: number;
  followupsTotal: number;
  customerPage: number;
  followupPage: number;
  pageSize: number;
};
