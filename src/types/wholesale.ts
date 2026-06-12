export type WholesaleAccountStatus = "pending" | "approved" | "rejected" | "suspended";
export type WholesaleCodeStatus = "active" | "inactive" | "expired" | "disabled";
export type WholesaleCustomerType = "new" | "existing";

export type WholesaleAccount = {
  id: string;
  customerId: string;
  customerName: string;
  businessName: string;
  status: WholesaleAccountStatus;
  customerType: WholesaleCustomerType;
  firstPurchaseRequirement: WholesaleFirstPurchaseRequirement | null;
};

export type WholesaleFirstPurchaseRequirement = {
  minimum: number;
  accumulated: number;
  missing: number;
  completed: boolean;
};

export type WholesaleValidationResult = {
  ok: boolean;
  message: string;
  account: WholesaleAccount | null;
  requiresLogin?: boolean;
  code?: string;
};

export type WholesaleAccessKind = "guest" | "regular" | "pending" | "approved" | "rejected" | "suspended";

export type WholesaleAccessState = {
  kind: WholesaleAccessKind;
  title: string;
  message: string;
  canEnterCode: boolean;
  account: WholesaleAccount | null;
  shouldShowApprovedNotice: boolean;
  customerType: WholesaleCustomerType | null;
  firstPurchaseRequirement: WholesaleFirstPurchaseRequirement | null;
};

export type WholesaleCustomerOption = {
  id: string;
  business_name: string | null;
  contact_name: string;
  email: string | null;
  phone: string;
  user_id: string | null;
  status: "active" | "inactive" | "disabled" | "pending_account";
  active: boolean;
  account_email: string | null;
  account_active: boolean | null;
};

export type WholesaleCodeAdminRow = {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  business_name: string | null;
  customer_email: string | null;
  customer_user_id: string | null;
  customer_status: "active" | "inactive" | "disabled" | "pending_account" | null;
  customer_active: boolean | null;
  account_email: string | null;
  account_active: boolean | null;
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

export type WholesaleCustomerFormInput = {
  business_name: string;
  contact_name: string;
  email: string;
  phone: string;
  status: "active" | "inactive" | "disabled" | "pending_account";
};
