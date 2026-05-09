import { redirect } from "next/navigation";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { AppRole, AuthProfile, Permission } from "@/types/auth";

type UserRoleRow = {
  id: string;
  email: string | null;
  full_name: string | null;
  roles: {
    name: AppRole;
    permissions: Permission[];
  } | null;
};

export async function getSessionProfile(): Promise<AuthProfile | null> {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data } = await supabase
    .from("users")
    .select("id, email, full_name, roles(name, permissions)")
    .eq("id", user.id)
    .maybeSingle<UserRoleRow>();

  if (!data?.roles) {
    return {
      id: user.id,
      email: user.email ?? null,
      full_name: user.user_metadata?.full_name ?? null,
      role: "cliente",
      permissions: [],
    };
  }

  return {
    id: data.id,
    email: data.email,
    full_name: data.full_name,
    role: data.roles.name,
    permissions: data.roles.permissions,
  };
}

export async function requireSession() {
  const profile = await getSessionProfile();

  if (!profile) {
    redirect("/login");
  }

  return profile;
}

export async function requirePermission(permission: Permission) {
  const profile = await requireSession();

  if (!profile.permissions.includes(permission) && profile.role !== "admin") {
    redirect("/sin-permiso");
  }

  return profile;
}
