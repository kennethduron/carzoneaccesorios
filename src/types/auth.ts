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
  | "orders:manage_logistics"
  | "customers:read"
  | "customers:manage"
  | "wholesale:manage"
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
  | "settings:fiscal"
  | "security:read"
  | "security:manage"
  | "users:manage"
  | "users:read"
  | "users:create"
  | "users:manage_operational"
  | "roles:assign"
  | "roles:assign_admin"
  | "roles:assign_operational"
  | "audit:read"
  | "audit:read_operational"
  | "user_activity:read_operational"
  | "system:monitoring"
  | "system:backups"
  | "technical:tools"
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
