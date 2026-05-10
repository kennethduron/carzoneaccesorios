import type { AppRole, Permission } from "@/types/auth";

export const rolePermissions: Record<AppRole, Permission[]> = {
  admin: [
    "admin:access",
    "products:manage",
    "inventory:manage",
    "orders:manage",
    "customers:read",
    "payments:read",
    "payments:manage",
    "invoices:read",
    "invoices:create",
    "invoices:manage",
    "fiscal:read",
    "crm:manage",
    "reports:read",
    "reports:export",
    "settings:manage",
    "audit:read",
  ],
  vendedor: ["admin:access", "products:read", "orders:manage", "customers:manage", "crm:manage"],
  bodega: ["admin:access", "products:read", "inventory:manage", "shipments:manage", "orders:read"],
  contadora: [
    "admin:access",
    "orders:read",
    "customers:read",
    "payments:read",
    "invoices:read",
    "invoices:create",
    "fiscal:read",
    "reports:read",
    "reports:export",
  ],
  cliente: ["store:buy", "orders:read_own", "invoices:read_own"],
};

export function roleHasPermission(role: AppRole, permission: Permission) {
  return rolePermissions[role].includes(permission);
}
