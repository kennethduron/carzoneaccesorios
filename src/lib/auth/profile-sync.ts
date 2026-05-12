import { getSupabaseAdminClient } from "@/lib/supabase";
import type { AppRole } from "@/types/auth";

export function normalizeAuthEmail(email: string) {
  return email.trim().toLowerCase();
}

export function normalizeAuthText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeAuthPhone(phone: string) {
  return phone.replace(/[^\d]/g, "");
}

export async function emailExistsInProfile(email: string) {
  const admin = getSupabaseAdminClient();
  const { data } = await admin
    .from("users")
    .select("id")
    .ilike("email", normalizeAuthEmail(email))
    .maybeSingle<{ id: string }>();

  return Boolean(data?.id);
}

export async function ensureRetailProfile(input: {
  userId: string;
  email: string;
  fullName?: string | null;
  phone?: string | null;
}) {
  const admin = getSupabaseAdminClient();
  const email = normalizeAuthEmail(input.email);
  const fullName = normalizeAuthText(input.fullName ?? "") || email;
  const phone = normalizeAuthPhone(input.phone ?? "") || "00000000";

  const { data: role } = await admin
    .from("roles")
    .select("id")
    .eq("name", "cliente")
    .maybeSingle<{ id: string }>();

  const { data: existingUser } = await admin
    .from("users")
    .select("id, roles(name)")
    .eq("id", input.userId)
    .maybeSingle<{ id: string; roles: { name: AppRole } | null }>();

  if (existingUser?.id) {
    await admin
      .from("users")
      .update({
        full_name: fullName,
        email,
        phone,
      })
      .eq("id", input.userId);
  } else {
    await admin.from("users").insert({
      id: input.userId,
      role_id: role?.id ?? null,
      full_name: fullName,
      email,
      phone,
      active: true,
    });
  }

  if (existingUser?.roles?.name && existingUser.roles.name !== "cliente") {
    return existingUser.roles.name;
  }

  const { data: pendingCustomer } = await admin
    .from("customers")
    .select("id, is_wholesale")
    .is("user_id", null)
    .ilike("email", email)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; is_wholesale: boolean }>();

  if (pendingCustomer?.id) {
    await admin
      .from("customers")
      .update({
        user_id: input.userId,
        contact_name: fullName,
        email,
        phone,
        status: "active",
        active: true,
      })
      .eq("id", pendingCustomer.id);
    return "cliente";
  }

  const { data: existingCustomer } = await admin
    .from("customers")
    .select("id")
    .eq("user_id", input.userId)
    .maybeSingle<{ id: string }>();

  if (existingCustomer?.id) {
    await admin
      .from("customers")
      .update({
        contact_name: fullName,
        email,
        phone,
      })
      .eq("id", existingCustomer.id);
    return "cliente";
  }

  await admin.from("customers").insert({
    user_id: input.userId,
    contact_name: fullName,
    email,
    phone,
    is_wholesale: false,
    status: "active",
    active: true,
    notes: "Cliente retail registrado desde la tienda publica.",
  });

  return "cliente";
}

export async function getUserRole(userId: string): Promise<AppRole | null> {
  const admin = getSupabaseAdminClient();
  const { data } = await admin
    .from("users")
    .select("roles(name)")
    .eq("id", userId)
    .maybeSingle<{ roles: { name: AppRole } | null }>();

  return data?.roles?.name ?? null;
}
