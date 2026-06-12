import type { AppRole } from "@/types/auth";

export const internalRoles = [
  "technical_owner",
  "admin",
  "business_owner",
  "vendedor",
  "bodega",
  "contadora",
  "soporte",
] as const satisfies AppRole[];

export type InternalRole = (typeof internalRoles)[number];

export const roleLabels: Record<AppRole, string> = {
  technical_owner: "Technical Owner",
  admin: "Administrador",
  business_owner: "Business Owner",
  vendedor: "Vendedor",
  bodega: "Bodega",
  contadora: "Contadora",
  soporte: "Soporte",
  cliente: "Cliente",
};

export function isInternalRole(role: AppRole | null | undefined): role is InternalRole {
  return Boolean(role && internalRoles.includes(role as InternalRole));
}

export function internalRoleLabel(role: AppRole | null | undefined) {
  if (!isInternalRole(role)) {
    return "Cliente";
  }

  return roleLabels[role];
}
