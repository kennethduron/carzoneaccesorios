import "server-only";

import { hasEffectivePermission } from "@/lib/auth/permissions";
import { getSessionProfile } from "@/lib/auth/session";
import type { Permission } from "@/types/auth";

export async function authorizeCommissionRequest(permission: Permission, elevated = false) {
  const profile = await getSessionProfile();
  if (!profile) return { profile: null, response: Response.json({ code: "AUTH_REQUIRED", message: "Autenticacion requerida." }, { status: 401 }) };
  const allowed = hasEffectivePermission(profile.role, profile.permissions, permission, profile.email)
    && (!elevated || ["technical_owner", "business_owner", "admin"].includes(profile.role));
  if (!allowed) return { profile: null, response: Response.json({ code: "COMMISSION_ACCESS_DENIED", message: "Acceso denegado." }, { status: 403 }) };
  return { profile, response: null };
}
