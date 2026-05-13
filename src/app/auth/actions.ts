"use server";

import { headers } from "next/headers";
import { writeErrorLog } from "@/lib/error-logging";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import {
  emailExistsInProfile,
  ensureRetailProfile,
  getEmailForUsername,
  normalizeAuthEmail,
  normalizeAuthPhone,
  normalizeAuthText,
  usernameExistsInProfile,
} from "@/lib/auth/profile-sync";
import { validateUsername } from "@/utils/usernames";

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

function looksLikeEmail(value: string) {
  return value.includes("@");
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
      ? "Tu cuenta fue creada, pero aun debes confirmar tu correo. Revisa tu bandeja de entrada o spam."
      : "Revisa tu correo y confirma tu cuenta antes de iniciar sesion.";
  }

  if (message.includes("invalid login credentials")) {
    return userExists ? "Correo/usuario o contrasena incorrectos." : "No encontramos una cuenta con este correo.";
  }

  if (message.includes("too many")) {
    return "Demasiados intentos. Espera unos minutos e intenta nuevamente.";
  }

  return "No pudimos iniciar sesion. Revisa tus datos e intenta nuevamente.";
}

function getRegisterErrorMessage(rawMessage: string) {
  const message = rawMessage.toLowerCase();

  if (message.includes("already registered") || message.includes("already exists") || message.includes("user already")) {
    return "Ya existe una cuenta con este correo. Intenta iniciar sesion.";
  }

  if (message.includes("password") && message.includes("weak")) {
    return "La contrasena es muy debil. Usa al menos 6 caracteres.";
  }

  if (message.includes("rate limit") || message.includes("too many")) {
    return "Demasiados intentos. Espera unos minutos e intenta nuevamente.";
  }

  return "No pudimos crear la cuenta. Revisa la informacion e intenta nuevamente.";
}

async function resolveLoginEmail(identifierInput: string) {
  const identifier = identifierInput.trim();

  if (looksLikeEmail(identifier)) {
    const email = normalizeEmail(identifier);
    if (!validateEmail(email)) {
      return { ok: false as const, message: "Ingresa un correo electronico valido." };
    }

    return { ok: true as const, email, kind: "email" as const, exists: await emailExistsInProfile(email) };
  }

  const username = validateUsername(identifier);
  if (!username.ok) {
    return { ok: false as const, message: "No encontramos una cuenta con ese usuario." };
  }

  const email = await getEmailForUsername(username.username);
  if (!email) {
    return { ok: false as const, message: "No encontramos una cuenta con ese usuario." };
  }

  if (email === "__suspended__") {
    return { ok: false as const, message: "Esta cuenta esta suspendida. Contacta a administracion para revisarla." };
  }

  return { ok: true as const, email, kind: "username" as const, exists: true };
}

export async function loginWithEmailAction(identifierInput: string, password: string, nextPathInput?: string): Promise<AuthActionResult> {
  const resolved = await resolveLoginEmail(identifierInput);
  const nextPath = safeNextPath(nextPathInput);

  if (!resolved.ok) {
    return { ok: false, message: resolved.message };
  }

  if (!password.trim()) {
    return { ok: false, message: "Ingresa tu contrasena para continuar." };
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: resolved.email, password });

  if (error) {
    await writeErrorLog({
      route: "/login",
      action: "auth.login_failed",
      errorMessage: error.message,
      metadata: {
        identifier_type: resolved.kind,
      },
    });

    return {
      ok: false,
      message:
        resolved.kind === "username" && !error.message.toLowerCase().includes("not confirmed")
          ? "Correo/usuario o contrasena incorrectos."
          : getLoginErrorMessage(error.message, resolved.exists),
    };
  }

  if (data.user) {
    await ensureRetailProfile({
      userId: data.user.id,
      email: data.user.email ?? resolved.email,
      fullName: data.user.user_metadata?.full_name,
      phone: data.user.user_metadata?.phone,
      username: data.user.user_metadata?.username,
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

  return { ok: true, message: "Sesion iniciada correctamente.", redirectTo: nextPath };
}

export async function registerWithEmailAction(input: {
  fullName: string;
  username: string;
  email: string;
  phone: string;
  password: string;
  nextPath?: string;
}): Promise<AuthActionResult> {
  const fullName = normalizeText(input.fullName);
  const username = validateUsername(input.username);
  const email = normalizeEmail(input.email);
  const phone = normalizePhone(input.phone);
  const nextPath = safeNextPath(input.nextPath);

  if (fullName.length < 3) {
    return { ok: false, message: "Ingresa tu nombre completo." };
  }

  if (!username.ok) {
    return { ok: false, message: username.message };
  }

  if (!validateEmail(email)) {
    return { ok: false, message: "Ingresa un correo electronico valido." };
  }

  if (phone.length < 8) {
    return { ok: false, message: "Ingresa un numero de telefono valido." };
  }

  if (input.password.length < 6) {
    return { ok: false, message: "La contrasena debe tener al menos 6 caracteres." };
  }

  if (await emailExistsInProfile(email)) {
    return { ok: false, message: "Ya existe una cuenta con este correo. Intenta iniciar sesion." };
  }

  if (await usernameExistsInProfile(username.username)) {
    return { ok: false, message: "Ya existe una cuenta con ese usuario. Elige otro." };
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
        username: username.username,
        phone,
      },
    },
  });

  if (error) {
    await writeErrorLog({
      route: "/registro",
      action: "auth.register_failed",
      errorMessage: error.message,
      metadata: {
        username: username.username,
      },
    });
    return { ok: false, message: getRegisterErrorMessage(error.message) };
  }

  if (data.user?.identities && data.user.identities.length === 0) {
    return { ok: false, message: "Ya existe una cuenta con este correo. Intenta iniciar sesion." };
  }

  if (data.user) {
    await ensureRetailProfile({
      userId: data.user.id,
      email: data.user.email ?? email,
      fullName,
      phone,
      username: username.username,
    });
  }

  if (!data.session) {
    return {
      ok: true,
      message: "Cuenta creada. Te enviamos un correo para confirmar tu cuenta antes de iniciar sesion.",
      redirectTo: `/login?check_email=1&email=${encodeURIComponent(email)}`,
      needsEmailConfirmation: true,
    };
  }

  return {
    ok: true,
    message: "Cuenta creada correctamente. Ahora puedes iniciar sesion.",
    redirectTo: nextPath,
  };
}

export async function resendConfirmationEmailAction(identifierInput: string): Promise<AuthActionResult> {
  const resolved = await resolveLoginEmail(identifierInput);

  if (!resolved.ok) {
    return { ok: false, message: "Ingresa un correo o usuario valido para reenviar la confirmacion." };
  }

  const supabase = await getSupabaseServerClient();
  const siteUrl = await getSiteUrl();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: resolved.email,
    options: {
      emailRedirectTo: buildAuthCallbackUrl(siteUrl),
    },
  });

  if (error) {
    await writeErrorLog({
      route: "/login",
      action: "auth.resend_confirmation_failed",
      errorMessage: error.message,
      metadata: {
        identifier_type: resolved.kind,
      },
    });

    return {
      ok: false,
      message: "No pudimos reenviar el correo. Verifica el correo e intenta nuevamente.",
    };
  }

  return { ok: true, message: "Te enviamos un nuevo correo de confirmacion." };
}
