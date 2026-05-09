import type { AppRole, Permission } from "@/types/auth";

export const rolePermissions: Record<AppRole, Permission[]> = {
  admin: [
    "admin:access",
    "products:manage",
    "inventory:manage",
    "orders:manage",
    "payments:manage",
    "invoices:manage",
    "crm:manage",
    "settings:manage",
    "audit:read",
  ],
  vendedor: ["admin:access", "products:read", "orders:manage", "customers:manage", "crm:manage"],
  bodega: ["admin:access", "products:read", "inventory:manage", "shipments:manage", "orders:read"],
  contadora: ["admin:access", "orders:read", "payments:manage", "invoices:manage", "reports:read"],
  cliente: ["store:buy", "orders:read_own", "invoices:read_own"],
};

export function roleHasPermission(role: AppRole, permission: Permission) {
  return rolePermissions[role].includes(permission);
}
