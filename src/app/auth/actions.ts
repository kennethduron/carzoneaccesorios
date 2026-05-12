"use server";

import { headers } from "next/headers";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import {
  emailExistsInProfile,
  ensureRetailProfile,
  normalizeAuthEmail,
  normalizeAuthPhone,
  normalizeAuthText,
} from "@/lib/auth/profile-sync";

export type AuthActionResult = {
  ok: boolean;
  message: string;
  redirectTo?: string;
  needsEmailConfirmation?: boolean;
};

function normalizeEmail(email: string) {
  return normalizeAuthEmail(email);
}

function normalizeText(value: string) {
  return normalizeAuthText(value);
}

function normalizePhone(phone: string) {
  return normalizeAuthPhone(phone);
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
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL;
  }

  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  const proto = requestHeaders.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "https://carzoneaccesorios.vercel.app";
}

function buildAuthCallbackUrl(siteUrl: string, nextPath = "/cuenta") {
  const callbackUrl = new URL("/auth/callback", siteUrl);
  callbackUrl.searchParams.set("next", safeNextPath(nextPath));
  return callbackUrl.toString();
}

function getLoginErrorMessage(rawMessage: string, userExists: boolean) {
  const message = rawMessage.toLowerCase();

  if (message.includes("email not confirmed") || message.includes("not confirmed")) {
    return userExists
      ? "Tu cuenta fue creada, pero aún debes confirmar tu correo. Revisa tu bandeja de entrada o spam."
      : "Revisa tu correo y confirma tu cuenta antes de iniciar sesión.";
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

    const { data: profile } = await supabase
      .from("users")
      .select("active")
      .eq("id", data.user.id)
      .maybeSingle<{ active: boolean }>();

    if (profile?.active === false) {
      await supabase.auth.signOut();
      return { ok: false, message: "Esta cuenta esta suspendida. Contacta a administracion para revisarla." };
    }
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
      emailRedirectTo: buildAuthCallbackUrl(siteUrl, nextPath),
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
      message: "Cuenta creada. Te enviamos un correo para confirmar tu cuenta antes de iniciar sesión.",
      redirectTo: `/login?check_email=1&email=${encodeURIComponent(email)}`,
      needsEmailConfirmation: true,
    };
  }

  return {
    ok: true,
    message: "Cuenta creada correctamente. Ahora puedes iniciar sesión.",
    redirectTo: nextPath,
  };
}

export async function resendConfirmationEmailAction(emailInput: string): Promise<AuthActionResult> {
  const email = normalizeEmail(emailInput);

  if (!validateEmail(email)) {
    return { ok: false, message: "Ingresa un correo electrónico válido para reenviar la confirmación." };
  }

  const supabase = await getSupabaseServerClient();
  const siteUrl = await getSiteUrl();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email,
    options: {
      emailRedirectTo: buildAuthCallbackUrl(siteUrl),
    },
  });

  if (error) {
    return {
      ok: false,
      message: "No pudimos reenviar el correo. Verifica el correo e intenta nuevamente.",
    };
  }

  return { ok: true, message: "Te enviamos un nuevo correo de confirmación." };
}
