import type { AppRole, Permission } from "@/types/auth";

export const protectedTechnicalEmail = "kennethduron.paz@gmail.com";

export const allPermissions: Permission[] = [
  "admin:access",
  "products:read",
  "products:manage",
  "inventory:manage",
  "orders:read",
  "orders:manage",
  "customers:read",
  "customers:manage",
  "payments:read",
  "payments:manage",
  "invoices:read",
  "invoices:create",
  "invoices:correct",
  "invoices:manage",
  "fiscal:read",
  "reports:export",
  "shipments:manage",
  "crm:manage",
  "reports:read",
  "settings:manage",
  "commercial_settings:manage",
  "users:manage",
  "users:read",
  "users:manage_operational",
  "roles:assign",
  "roles:assign_operational",
  "audit:read",
  "audit:read_operational",
  "user_activity:read_operational",
  "system:monitoring",
  "store:buy",
  "orders:read_own",
  "invoices:read_own",
];

export const rolePermissions: Record<AppRole, Permission[]> = {
  technical_owner: allPermissions,
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
    "invoices:correct",
    "invoices:manage",
    "fiscal:read",
    "crm:manage",
    "reports:read",
    "reports:export",
    "settings:manage",
    "commercial_settings:manage",
    "users:manage",
    "users:read",
    "users:manage_operational",
    "roles:assign",
    "roles:assign_operational",
    "audit:read",
    "audit:read_operational",
    "user_activity:read_operational",
    "system:monitoring",
  ],
  business_owner: [
    "admin:access",
    "products:manage",
    "inventory:manage",
    "orders:manage",
    "customers:read",
    "customers:manage",
    "payments:read",
    "payments:manage",
    "invoices:read",
    "invoices:create",
    "invoices:correct",
    "invoices:manage",
    "fiscal:read",
    "crm:manage",
    "reports:read",
    "reports:export",
    "users:read",
    "users:manage_operational",
    "roles:assign_operational",
    "audit:read",
    "audit:read_operational",
    "user_activity:read_operational",
    "commercial_settings:manage",
  ],
  vendedor: ["admin:access", "products:read", "orders:manage", "customers:manage", "crm:manage", "reports:read"],
  bodega: ["admin:access", "products:read", "inventory:manage", "shipments:manage", "orders:read"],
  contadora: [
    "admin:access",
    "orders:read",
    "customers:read",
    "payments:read",
    "invoices:read",
    "invoices:create",
    "invoices:correct",
    "fiscal:read",
    "reports:read",
    "reports:export",
  ],
  soporte: ["admin:access", "customers:read", "crm:manage", "orders:read", "invoices:read"],
  cliente: ["store:buy", "orders:read_own", "invoices:read_own"],
};

export function roleHasPermission(role: AppRole, permission: Permission) {
  return role === "technical_owner" || rolePermissions[role].includes(permission);
}

export function normalizeEmailForAuth(email: string | null | undefined) {
  return email?.trim().toLowerCase() ?? null;
}

export function isProtectedTechnicalEmail(email: string | null | undefined) {
  return normalizeEmailForAuth(email) === protectedTechnicalEmail;
}

export function isTechnicalOwner(role: AppRole | null | undefined, email?: string | null) {
  return role === "technical_owner" || isProtectedTechnicalEmail(email);
}

export function effectiveRole(role: AppRole | null | undefined, email?: string | null): AppRole {
  if (isProtectedTechnicalEmail(email)) {
    return "technical_owner";
  }

  return role ?? "cliente";
}

export function effectivePermissions(role: AppRole, email?: string | null) {
  if (isTechnicalOwner(role, email)) {
    return allPermissions;
  }

  return rolePermissions[role];
}

export function hasEffectivePermission(role: AppRole, permissions: Permission[], permission: Permission, email?: string | null) {
  if (isTechnicalOwner(role, email)) {
    return true;
  }

  if (role === "admin") {
    return true;
  }

  return permissions.includes(permission);
}
