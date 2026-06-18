export type FiscalSettings = {
  legal_name: string;
  rtn: string;
  cai: string;
  invoice_range_start: string;
  invoice_range_end: string;
  current_invoice_number: string;
  cai_authorization_date: string | null;
  emission_deadline: string | null;
  fiscal_address: string;
  phone: string;
  email: string;
  logo_url: string | null;
  updated_at?: string;
};

export type FiscalAlert = {
  type: "warning" | "danger";
  message: string;
};
