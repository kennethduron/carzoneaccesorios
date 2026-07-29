import { effectiveRole } from "@/lib/auth/permissions";
import type { AppRole } from "@/types/auth";

export type PosPermission =
  | "pos:create_sale"
  | "pos:apply_discount"
  | "pos:access"
  | "pos:customers:search"
  | "pos:customers:create"
  | "pos:customers:update"
  | "pos:drafts:create"
  | "pos:drafts:read"
  | "pos:drafts:edit_own"
  | "pos:drafts:edit_any"
  | "pos:drafts:abandon"
  | "pos:products:search"
  | "pos:price_override"
  | "customers:read_commercial"
  | "customers:read_credit";

export const posAuthorizedRoles = ["technical_owner", "business_owner", "admin"] as const satisfies readonly AppRole[];

type PosPermissionProfile = {
  role: AppRole;
  email?: string | null;
  permissions: readonly string[];
};

export function hasPosPermission(profile: PosPermissionProfile, permission: PosPermission) {
  const role = effectiveRole(profile.role, profile.email);
  return posAuthorizedRoles.includes(role as (typeof posAuthorizedRoles)[number])
    && profile.permissions.includes(permission);
}
