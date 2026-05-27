export type FiscalCorrectionValueKey =
  | "customer_name"
  | "customer_rtn"
  | "customer_phone"
  | "customer_email"
  | "customer_address";

export type FiscalCorrectionValues = Partial<Record<FiscalCorrectionValueKey, string | null>>;

export type FiscalCorrectionHistoryEntry = {
  id: string;
  created_at: string;
  user_id: string | null;
  user_label: string | null;
  actor_role: string | null;
  table_name: string;
  record_id: string | null;
  action: string;
  order_id: string | null;
  invoice_id: string | null;
  fields_modified: FiscalCorrectionValueKey[];
  old_values: FiscalCorrectionValues;
  new_values: FiscalCorrectionValues;
  correction_reason: string | null;
  ip_address: string | null;
  user_agent: string | null;
};
