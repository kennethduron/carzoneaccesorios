export type AppRole =
  | "technical_owner"
  | "admin"
  | "business_owner"
  | "vendedor"
  | "bodega"
  | "contadora"
  | "soporte"
  | "cliente";

export type Permission =
  | "admin:access"
  | "products:read"
  | "products:manage"
  | "inventory:manage"
  | "orders:read"
  | "orders:manage"
  | "customers:read"
  | "customers:manage"
  | "payments:read"
  | "payments:manage"
  | "invoices:read"
  | "invoices:create"
  | "invoices:correct"
  | "invoices:manage"
  | "fiscal:read"
  | "reports:export"
  | "shipments:manage"
  | "crm:manage"
  | "reports:read"
  | "settings:manage"
  | "commercial_settings:manage"
  | "users:manage"
  | "users:read"
  | "users:manage_operational"
  | "roles:assign"
  | "roles:assign_operational"
  | "audit:read"
  | "audit:read_operational"
  | "user_activity:read_operational"
  | "system:monitoring"
  | "store:buy"
  | "orders:read_own"
  | "invoices:read_own";

export type AuthProfile = {
  id: string;
  email: string | null;
  username: string | null;
  full_name: string | null;
  role: AppRole;
  permissions: Permission[];
};
