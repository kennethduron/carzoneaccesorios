"use server";

import { headers } from "next/headers";
import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export type AuthActionResult = {
  ok: boolean;
  message: string;
  redirectTo?: string;
  needsEmailConfirmation?: boolean;
};

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function normalizePhone(phone: string) {
  return phone.replace(/[^\d]/g, "");
}

function validateEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function safeNextPath(nextPath: string | null | undefined) {
  const fallback = "/cuenta";
  if (!nextPath?.startsWith("/") || nextPath.startsWith("//")) {
    return fallback;
  }

  return nextPath;
}

async function getSiteUrl() {
  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  const proto = requestHeaders.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "https://carzoneaccesorios.vercel.app";
}

async function emailExistsInProfile(email: string) {
  const admin = getSupabaseAdminClient();
  const { data } = await admin.from("users").select("id").ilike("email", email).maybeSingle<{ id: string }>();
  return Boolean(data?.id);
}

async function ensureRetailProfile(input: { userId: string; email: string; fullName?: string | null; phone?: string | null }) {
  const admin = getSupabaseAdminClient();
  const fullName = normalizeText(input.fullName ?? "") || input.email;
  const phone = normalizePhone(input.phone ?? "") || "00000000";

  const { data: role } = await admin
    .from("roles")
    .select("id")
    .eq("name", "cliente")
    .maybeSingle<{ id: string }>();

  const { data: existingUser } = await admin
    .from("users")
    .select("id, roles(name)")
    .eq("id", input.userId)
    .maybeSingle<{ id: string; roles: { name: string } | null }>();

  if (existingUser?.id) {
    await admin
      .from("users")
      .update({
        full_name: fullName,
        email: input.email,
        phone,
      })
      .eq("id", input.userId);
  } else {
    await admin.from("users").insert({
      id: input.userId,
      role_id: role?.id ?? null,
      full_name: fullName,
      email: input.email,
      phone,
      active: true,
    });
  }

  if (existingUser?.roles?.name && existingUser.roles.name !== "cliente") {
    return;
  }

  const { data: pendingCustomer } = await admin
    .from("customers")
    .select("id, is_wholesale")
    .is("user_id", null)
    .ilike("email", input.email)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; is_wholesale: boolean }>();

  if (pendingCustomer?.id) {
    await admin
      .from("customers")
      .update({
        user_id: input.userId,
        contact_name: fullName,
        email: input.email,
        phone,
        status: "active",
        active: true,
      })
      .eq("id", pendingCustomer.id);
    return;
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
        email: input.email,
        phone,
      })
      .eq("id", existingCustomer.id);
    return;
  }

  await admin.from("customers").insert({
    user_id: input.userId,
    contact_name: fullName,
    email: input.email,
    phone,
    is_wholesale: false,
    status: "active",
    active: true,
    notes: "Cliente retail registrado desde la tienda publica.",
  });
}

function getLoginErrorMessage(rawMessage: string, userExists: boolean) {
  const message = rawMessage.toLowerCase();

  if (message.includes("email not confirmed") || message.includes("not confirmed")) {
    return "Revisa tu correo y confirma tu cuenta antes de iniciar sesión.";
  }

  if (message.includes("invalid login credentials")) {
    return userExists ? "Correo o contraseña incorrectos." : "No encontramos una cuenta con este correo.";
  }

  if (message.includes("too many")) {
    return "Demasiados intentos. Espera unos minutos e intenta nuevamente.";
  }

  return "No pudimos iniciar sesión. Revisa tus datos e intenta nuevamente.";
}

function getRegisterErrorMessage(rawMessage: string) {
  const message = rawMessage.toLowerCase();

  if (message.includes("already registered") || message.includes("already exists") || message.includes("user already")) {
    return "Ya existe una cuenta con este correo. Intenta iniciar sesión.";
  }

  if (message.includes("password") && message.includes("weak")) {
    return "La contraseña es muy débil. Usa al menos 6 caracteres.";
  }

  if (message.includes("rate limit") || message.includes("too many")) {
    return "Demasiados intentos. Espera unos minutos e intenta nuevamente.";
  }

  return "No pudimos crear la cuenta. Revisa la información e intenta nuevamente.";
}

export async function loginWithEmailAction(emailInput: string, password: string, nextPathInput?: string): Promise<AuthActionResult> {
  const email = normalizeEmail(emailInput);
  const nextPath = safeNextPath(nextPathInput);

  if (!validateEmail(email)) {
    return { ok: false, message: "Ingresa un correo electrónico válido." };
  }

  if (!password.trim()) {
    return { ok: false, message: "Ingresa tu contraseña para continuar." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    return {
      ok: false,
      message: getLoginErrorMessage(error.message, await emailExistsInProfile(email)),
    };
  }

  if (data.user) {
    await ensureRetailProfile({
      userId: data.user.id,
      email: data.user.email ?? email,
      fullName: data.user.user_metadata?.full_name,
      phone: data.user.user_metadata?.phone,
    });
  }

  return { ok: true, message: "Sesión iniciada correctamente.", redirectTo: nextPath };
}

export async function registerWithEmailAction(input: {
  fullName: string;
  email: string;
  phone: string;
  password: string;
  nextPath?: string;
}): Promise<AuthActionResult> {
  const fullName = normalizeText(input.fullName);
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const nextPath = safeNextPath(input.nextPath);

  if (fullName.length < 3) {
    return { ok: false, message: "Ingresa tu nombre completo." };
  }

  if (!validateEmail(email)) {
    return { ok: false, message: "Ingresa un correo electrónico válido." };
  }

  if (phone.length < 8) {
    return { ok: false, message: "Ingresa un número de teléfono válido." };
  }

  if (input.password.length < 6) {
    return { ok: false, message: "La contraseña debe tener al menos 6 caracteres." };
  }

  if (await emailExistsInProfile(email)) {
    return { ok: false, message: "Ya existe una cuenta con este correo. Intenta iniciar sesión." };
  }

  const supabase = await getSupabaseServerClient();
  const siteUrl = await getSiteUrl();
  const { data, error } = await supabase.auth.signUp({
    email,
    password: input.password,
    options: {
      emailRedirectTo: `${siteUrl}/login?registered=1`,
      data: {
        full_name: fullName,
        phone,
      },
    },
  });

  if (error) {
    return { ok: false, message: getRegisterErrorMessage(error.message) };
  }

  if (data.user?.identities && data.user.identities.length === 0) {
    return { ok: false, message: "Ya existe una cuenta con este correo. Intenta iniciar sesión." };
  }

  if (data.user) {
    await ensureRetailProfile({
      userId: data.user.id,
      email: data.user.email ?? email,
      fullName,
      phone,
    });
  }

  if (!data.session) {
    return {
      ok: true,
      message: "Cuenta creada correctamente. Revisa tu correo y confirma tu cuenta antes de iniciar sesión.",
      redirectTo: "/login?check_email=1",
      needsEmailConfirmation: true,
    };
  }

  return {
    ok: true,
    message: "Cuenta creada correctamente. Ahora puedes iniciar sesión.",
    redirectTo: nextPath,
  };
}
