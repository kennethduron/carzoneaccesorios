export type CrmInteractionType = "seguimiento" | "llamada" | "nota" | "reunion" | "prospecto";
export type CrmPriority = "baja" | "media" | "alta" | "urgente";
export type CrmFollowupStatus = "pending" | "completed" | "cancelled";
export type CrmLeadStatus = "prospecto" | "contactado" | "calificado" | "cliente" | "perdido";

export type CrmCustomerOption = {
  id: string;
  business_name: string | null;
  contact_name: string;
  email: string | null;
  phone: string;
  lead_status: CrmLeadStatus;
  estimated_value: number;
  monthly_amount: number;
};

export type CrmFollowupRow = {
  id: string;
  customer_id: string;
  customer_name: string | null;
  business_name: string | null;
  assigned_user_id: string | null;
  title: string;
  interaction_type: CrmInteractionType;
  next_action: string | null;
  due_at: string | null;
  priority: CrmPriority;
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
};
