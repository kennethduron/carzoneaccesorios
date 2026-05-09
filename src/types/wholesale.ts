export type WholesaleCodeStatus = "active" | "inactive" | "expired" | "disabled";

export type WholesaleAccount = {
  id: string;
  code: string;
  customerId: string | null;
  customerName: string;
  businessName: string;
  minimumOrder: number;
  expiresAt: string | null;
  usedCount: number;
  status: WholesaleCodeStatus;
};

export type WholesaleValidationResult = {
  ok: boolean;
  message: string;
  account: WholesaleAccount | null;
};

export type WholesaleCustomerOption = {
  id: string;
  business_name: string | null;
  contact_name: string;
};

export type WholesaleCodeAdminRow = {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  business_name: string | null;
  code: string;
  label: string;
  minimum_order: number;
  max_uses: number | null;
  used_count: number;
  status: WholesaleCodeStatus;
  active: boolean;
  starts_at: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
};

export type WholesaleCodeFormInput = {
  id?: string;
  customer_id: string | null;
  code: string;
  label: string;
  minimum_order: number;
  max_uses: number | null;
  used_count: number;
  status: WholesaleCodeStatus;
  active: boolean;
  starts_at: string | null;
  expires_at: string | null;
};
