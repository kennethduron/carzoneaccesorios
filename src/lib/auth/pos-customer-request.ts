import "server-only";

import { hasDatabasePosPermission } from "@/lib/auth/pos-server-authorization";
import { hasPosPermission, type PosPermission } from "@/lib/auth/pos-permissions";
import { getSessionProfile } from "@/lib/auth/session";

export async function authorizePosCustomerRequest(permission: PosPermission) {
  const profile = await getSessionProfile();
  if (!profile) {
    return { profile: null, response: Response.json({ message: "Autenticacion requerida." }, { status: 401 }) };
  }

  if (!hasPosPermission(profile, "pos:access") || !hasPosPermission(profile, permission)) {
    return { profile: null, response: Response.json({ message: "Acceso denegado." }, { status: 403 }) };
  }

  const [databaseAccess, databasePermission] = await Promise.all([
    hasDatabasePosPermission("pos:access"),
    hasDatabasePosPermission(permission),
  ]);
  if (!databaseAccess || !databasePermission) {
    return { profile: null, response: Response.json({ message: "Acceso denegado." }, { status: 403 }) };
  }

  return { profile, response: null };
}
