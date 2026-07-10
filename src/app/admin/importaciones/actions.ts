"use server";

import { hasEffectivePermission } from "@/lib/auth/permissions";
import { requirePermission } from "@/lib/auth/session";
import { searchImportAssignmentOptions } from "@/services/supabase/import-foundation.service";
import type { AssignmentSelectorKind } from "@/types/import-foundation";

export async function searchImportAssignmentOptionsAction(kind: AssignmentSelectorKind, query: string) {
  const profile = await requirePermission("admin:access");

  const allowed =
    kind === "customer"
      ? hasEffectivePermission(profile.role, profile.permissions, "customers:read", profile.email) ||
        hasEffectivePermission(profile.role, profile.permissions, "receivables:read", profile.email) ||
        hasEffectivePermission(profile.role, profile.permissions, "credit:manage", profile.email)
      : hasEffectivePermission(profile.role, profile.permissions, "suppliers:read", profile.email) ||
        hasEffectivePermission(profile.role, profile.permissions, "payables:read", profile.email) ||
        hasEffectivePermission(profile.role, profile.permissions, "payables:manage", profile.email);

  if (!allowed) {
    return [];
  }

  return searchImportAssignmentOptions(kind, query);
}
