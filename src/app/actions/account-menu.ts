"use server";

import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { roleHasPermission } from "@/lib/auth/permissions";
import type { AppRole } from "@/types/auth";

export type PublicAccountMenuState = {
  isAuthenticated: boolean;
  role: AppRole | null;
  hasAdminAccess: boolean;
};

export async function getPublicAccountMenuStateAction(): Promise<PublicAccountMenuState> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return {
      isAuthenticated: false,
      role: null,
      hasAdminAccess: false,
    };
  }

  const admin = getSupabaseAdminClient();
  const { data } = await admin
    .from("users")
    .select("roles(name)")
    .eq("id", user.id)
    .maybeSingle<{ roles: { name: AppRole } | null }>();

  const role = data?.roles?.name ?? "cliente";

  return {
    isAuthenticated: true,
    role,
    hasAdminAccess: roleHasPermission(role, "admin:access"),
  };
}
