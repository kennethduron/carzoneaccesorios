import { hasEffectivePermission, isTechnicalOwner } from "@/lib/auth/permissions";
import type { AppRole, AuthProfile } from "@/types/auth";

type SecurityActor = Pick<AuthProfile, "id" | "email" | "permissions" | "role">;
type SecurityTarget = { id: string; email: string | null; role: AppRole };

export const protectedTechnicalEmail = "kennethduron.paz@gmail.com";
export const securityAccessRoles: AppRole[] = ["technical_owner", "business_owner", "admin"];
export const operationalRoles: AppRole[] = ["vendedor", "bodega", "contadora", "soporte", "cliente"];
export const allRoles: AppRole[] = ["technical_owner", "business_owner", "admin", ...operationalRoles];

export function hasTechnicalControl(profile: Pick<AuthProfile, "email" | "role">) {
  return isTechnicalOwner(profile.role, profile.email);
}

export function canAccessSecurity(profile: SecurityActor) {
  return securityAccessRoles.includes(profile.role) &&
    hasEffectivePermission(profile.role, profile.permissions, "security:read", profile.email);
}

export function canManageSecurityUsers(profile: SecurityActor) {
  return canAccessSecurity(profile) &&
    hasEffectivePermission(profile.role, profile.permissions, "security:manage", profile.email) &&
    (hasTechnicalControl(profile) || profile.permissions.includes("users:manage_operational"));
}

export function assignableRolesFor(profile: Pick<AuthProfile, "email" | "role">): AppRole[] {
  if (hasTechnicalControl(profile)) {
    return allRoles;
  }

  if (profile.role === "business_owner") {
    return ["admin", ...operationalRoles];
  }

  if (profile.role === "admin") {
    return operationalRoles;
  }

  return [];
}

export function creatableRolesFor(profile: Pick<AuthProfile, "email" | "role">): AppRole[] {
  return assignableRolesFor(profile);
}

export function canAssignRole(profile: Pick<AuthProfile, "email" | "role">, role: AppRole) {
  return assignableRolesFor(profile).includes(role);
}

export function isProtectedTechnicalUser(user: Pick<SecurityTarget, "email" | "role">) {
  return user.role === "technical_owner" || user.email?.trim().toLowerCase() === protectedTechnicalEmail;
}

export function canViewSecurityUser(profile: Pick<AuthProfile, "email" | "role">, user: SecurityTarget) {
  return hasTechnicalControl(profile) || !isProtectedTechnicalUser(user);
}

export function canModifySecurityUser(profile: Pick<AuthProfile, "id" | "email" | "role">, user: SecurityTarget) {
  if (profile.id === user.id) {
    return false;
  }

  if (hasTechnicalControl(profile)) {
    return true;
  }

  if (isProtectedTechnicalUser(user) || user.role === "business_owner") {
    return false;
  }

  if (profile.role === "business_owner") {
    return user.role === "admin" || operationalRoles.includes(user.role);
  }

  if (profile.role === "admin") {
    return operationalRoles.includes(user.role);
  }

  return false;
}

export function visibleSecurityRolesFor(profile: Pick<AuthProfile, "email" | "role">) {
  return hasTechnicalControl(profile) ? allRoles : allRoles.filter((role) => role !== "technical_owner");
}

export function canUseTechnicalTools(profile: SecurityActor) {
  return hasTechnicalControl(profile) &&
    hasEffectivePermission(profile.role, profile.permissions, "technical:tools", profile.email);
}

export function canRequestTechnicalBackups(profile: SecurityActor) {
  return canUseTechnicalTools(profile) &&
    hasEffectivePermission(profile.role, profile.permissions, "system:backups", profile.email);
}
