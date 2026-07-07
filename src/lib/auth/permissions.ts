import type { AppRole, Permission } from "@/types/auth";

export const protectedTechnicalEmail = "kennethduron.paz@gmail.com";

export const allPermissions: Permission[] = [
  "admin:access",
  "products:read",
  "products:manage",
  "inventory:manage",
  "orders:read",
  "orders:manage",
  "orders:manage_logistics",
  "customers:read",
  "customers:manage",
  "wholesale:manage",
  "payments:read",
  "payments:manage",
  "payments:confirm",
  "payments:reject",
  "orders:cancel",
  "orders:extend_reservation",
  "reservations:review",
  "notifications:read",
  "notifications:manage",
  "invoices:read",
  "invoices:export",
  "invoices:create",
  "invoices:correct",
  "invoices:manage",
  "fiscal:read",
  "fiscal:reports",
  "tax:read",
  "tax:export",
  "reports:export",
  "reports:fiscal_read",
  "reports:fiscal_export",
  "credit:read",
  "credit:manage",
  "credit:mark_paid",
  "receivables:read",
  "receivables:export",
  "suppliers:read",
  "suppliers:manage",
  "purchases:read",
  "purchases:manage",
  "payables:read",
  "payables:manage",
  "accounting:read",
  "accounting:create",
  "accounting:post",
  "accounting:manage",
  "accounting:reverse",
  "accounting:export",
  "accounting:settings",
  "accounting:close_period",
  "accounting:view_reports",
  "shipments:manage",
  "crm:manage",
  "reports:read",
  "settings:manage",
  "commercial_settings:manage",
  "settings:fiscal",
  "security:read",
  "security:manage",
  "users:manage",
  "users:read",
  "users:create",
  "users:manage_operational",
  "roles:assign",
  "roles:assign_admin",
  "roles:assign_operational",
  "audit:read",
  "audit:read_operational",
  "user_activity:read_operational",
  "system:monitoring",
  "system:backups",
  "technical:tools",
  "store:buy",
  "orders:read_own",
  "invoices:read_own",
];

const purchasesApFullPermissions: Permission[] = [
  "suppliers:read",
  "suppliers:manage",
  "purchases:read",
  "purchases:manage",
  "payables:read",
  "payables:manage",
];

const accountingFullPermissions: Permission[] = [
  "accounting:read",
  "accounting:create",
  "accounting:post",
  "accounting:manage",
  "accounting:reverse",
  "accounting:export",
  "accounting:settings",
  "accounting:close_period",
  "accounting:view_reports",
];

export const rolePermissions: Record<AppRole, Permission[]> = {
  technical_owner: allPermissions,
  admin: [
    "admin:access",
    "products:manage",
    "inventory:manage",
    "orders:manage",
    "customers:read",
    "customers:manage",
    "wholesale:manage",
    "payments:read",
    "payments:manage",
    "payments:confirm",
    "payments:reject",
    "orders:cancel",
    "orders:extend_reservation",
    "reservations:review",
    "notifications:read",
    "notifications:manage",
    "invoices:read",
    "invoices:export",
    "invoices:create",
    "invoices:correct",
    "invoices:manage",
    "fiscal:read",
    "fiscal:reports",
    "tax:read",
    "tax:export",
    "settings:fiscal",
    "crm:manage",
    "reports:read",
    "reports:export",
    "reports:fiscal_read",
    "reports:fiscal_export",
    "credit:read",
    "credit:manage",
    "credit:mark_paid",
    "receivables:read",
    "receivables:export",
    ...purchasesApFullPermissions,
    ...accountingFullPermissions,
    "commercial_settings:manage",
    "security:read",
    "security:manage",
    "users:read",
    "users:create",
    "users:manage_operational",
    "roles:assign_operational",
    "audit:read_operational",
    "user_activity:read_operational",
    "shipments:manage",
  ],
  business_owner: [
    "admin:access",
    "products:manage",
    "inventory:manage",
    "orders:manage",
    "customers:read",
    "customers:manage",
    "wholesale:manage",
    "payments:read",
    "payments:manage",
    "payments:confirm",
    "payments:reject",
    "orders:cancel",
    "orders:extend_reservation",
    "reservations:review",
    "notifications:read",
    "notifications:manage",
    "invoices:read",
    "invoices:export",
    "invoices:create",
    "invoices:correct",
    "invoices:manage",
    "fiscal:read",
    "fiscal:reports",
    "tax:read",
    "tax:export",
    "settings:fiscal",
    "crm:manage",
    "reports:read",
    "reports:export",
    "reports:fiscal_read",
    "reports:fiscal_export",
    "credit:read",
    "credit:manage",
    "credit:mark_paid",
    "receivables:read",
    "receivables:export",
    ...purchasesApFullPermissions,
    ...accountingFullPermissions,
    "shipments:manage",
    "users:read",
    "users:manage_operational",
    "roles:assign_operational",
    "audit:read_operational",
    "user_activity:read_operational",
    "commercial_settings:manage",
    "security:read",
    "security:manage",
    "users:create",
    "roles:assign_admin",
  ],
  vendedor: ["admin:access", "products:read", "orders:read", "customers:read", "customers:manage", "crm:manage"],
  bodega: [
    "admin:access",
    "products:read",
    "inventory:manage",
    "shipments:manage",
    "orders:read",
    "orders:manage_logistics",
    "reservations:review",
    "notifications:read",
  ],
  contadora: [
    "admin:access",
    "notifications:read",
    "invoices:read",
    "invoices:export",
    "fiscal:read",
    "fiscal:reports",
    "tax:read",
    "tax:export",
    "reports:fiscal_read",
    "reports:fiscal_export",
    "credit:read",
    "receivables:read",
    "receivables:export",
    ...purchasesApFullPermissions,
    "accounting:read",
    "accounting:create",
    "accounting:post",
    "accounting:manage",
    "accounting:close_period",
    "accounting:view_reports",
    "accounting:export",
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

  return permissions.includes(permission);
}
