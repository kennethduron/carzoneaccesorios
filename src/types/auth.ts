export type AppRole = "admin" | "vendedor" | "bodega" | "contadora" | "cliente";

export type Permission =
  | "admin:access"
  | "products:read"
  | "products:manage"
  | "inventory:manage"
  | "orders:read"
  | "orders:manage"
  | "customers:manage"
  | "payments:manage"
  | "invoices:manage"
  | "shipments:manage"
  | "crm:manage"
  | "reports:read"
  | "settings:manage"
  | "audit:read"
  | "store:buy"
  | "orders:read_own"
  | "invoices:read_own";

export type AuthProfile = {
  id: string;
  email: string | null;
  full_name: string | null;
  role: AppRole;
  permissions: Permission[];
};
