"use server";

import { headers } from "next/headers";
import { writeErrorLog } from "@/lib/error-logging";
import { checkRateLimit, rateLimitMessage } from "@/lib/rate-limit";
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

const genericConfirmationResendMessage =
  "Si el correo está registrado, enviaremos un nuevo enlace de verificación.";

function getLoginErrorMessage(rawMessage: string, userExists: boolean) {
  const message = rawMessage.toLowerCase();

  if (message.includes("email not confirmed") || message.includes("not confirmed")) {
    return userExists
      ? "Tu cuenta aún no ha sido verificada. Revisa tu correo o solicita un nuevo enlace."
      : "Tu cuenta aún no ha sido verificada. Revisa tu correo o solicita un nuevo enlace.";
  }

  if (message.includes("invalid login credentials")) {
    return userExists ? "Correo/usuario o contraseña incorrectos." : "No encontramos una cuenta con este correo.";
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

function getPasswordResetErrorMessage(rawMessage: string) {
  const message = rawMessage.toLowerCase();

  if (message.includes("expired") || message.includes("invalid") || message.includes("otp") || message.includes("token")) {
    return "El enlace no es válido o expiró. Solicita uno nuevo.";
  }

  if (message.includes("weak") || message.includes("password")) {
    return "La contraseña debe tener al menos 8 caracteres.";
  }

  if (message.includes("rate limit") || message.includes("too many")) {
    return rateLimitMessage;
  }

  return "No pudimos actualizar tu contraseña. Solicita un nuevo enlace e intenta nuevamente.";
}

function decodeJwtPayload(token: string | null | undefined) {
  if (!token) {
    return null;
  }

  try {
    const [, payload] = token.split(".");
    if (!payload) {
      return null;
    }

    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalized, "base64").toString("utf8");
    return JSON.parse(decoded) as { amr?: Array<string | { method?: string }> };
  } catch {
    return null;
  }
}

function hasRecoverySession(accessToken: string | null | undefined) {
  const payload = decodeJwtPayload(accessToken);
  const methods = Array.isArray(payload?.amr) ? payload.amr : [];

  return methods.some((method) => {
    if (typeof method === "string") {
      return method === "recovery";
    }

    return method?.method === "recovery";
  });
}

async function resolveLoginEmail(identifierInput: string) {
  const identifier = identifierInput.trim();

  if (looksLikeEmail(identifier)) {
    const email = normalizeEmail(identifier);
    if (!validateEmail(email)) {
      return { ok: false as const, message: "Ingresa un correo electrónico válido." };
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
    return { ok: false as const, message: "Esta cuenta está suspendida. Contacta a administración para revisarla." };
  }

  return { ok: true as const, email, kind: "username" as const, exists: true };
}

export async function loginWithEmailAction(identifierInput: string, password: string, nextPathInput?: string): Promise<AuthActionResult> {
  const rateLimit = await checkRateLimit({
    route: "/login",
    limit: 8,
    windowSeconds: 5 * 60,
    key: identifierInput.trim().toLowerCase(),
  });

  if (!rateLimit.ok) {
    return { ok: false, message: rateLimitMessage };
  }

  const resolved = await resolveLoginEmail(identifierInput);
  const nextPath = safeNextPath(nextPathInput);

  if (!resolved.ok) {
    return { ok: false, message: resolved.message };
  }

  if (!password.trim()) {
    return { ok: false, message: "Ingresa tu contraseña para continuar." };
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
          ? "Correo/usuario o contraseña incorrectos."
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
      return { ok: false, message: "Esta cuenta está suspendida. Contacta a administración para revisarla." };
    }
  }

  return { ok: true, message: "Sesión iniciada correctamente.", redirectTo: nextPath };
}

export async function registerWithEmailAction(input: {
  fullName: string;
  username: string;
  email: string;
  phone: string;
  password: string;
  nextPath?: string;
}): Promise<AuthActionResult> {
  const registerLimit = await checkRateLimit({
    route: "/registro",
    limit: 4,
    windowSeconds: 15 * 60,
    key: input.email.trim().toLowerCase(),
  });

  if (!registerLimit.ok) {
    return { ok: false, message: rateLimitMessage };
  }

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
    return { ok: false, message: "Ya existe una cuenta con este correo. Intenta iniciar sesión." };
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
      message: "Cuenta creada. Te enviamos un correo para confirmar tu dirección. Después de verificarla, podrás iniciar sesión.",
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

export async function resendConfirmationEmailAction(identifierInput: string): Promise<AuthActionResult> {
  const normalizedIdentifier = identifierInput.trim();
  const resendLimit = await checkRateLimit({
    route: "/login/resend-confirmation",
    limit: 3,
    windowSeconds: 15 * 60,
    key: normalizedIdentifier.toLowerCase(),
  });

  if (!resendLimit.ok) {
    return { ok: false, message: rateLimitMessage };
  }

  let email: string | null = null;
  let identifierKind: "email" | "username" | "invalid" = "invalid";

  if (looksLikeEmail(normalizedIdentifier)) {
    const normalizedEmail = normalizeEmail(normalizedIdentifier);
    if (validateEmail(normalizedEmail)) {
      email = normalizedEmail;
      identifierKind = "email";
    }
  } else {
    const username = validateUsername(normalizedIdentifier);
    if (username.ok) {
      const resolvedEmail = await getEmailForUsername(username.username);
      if (resolvedEmail && resolvedEmail !== "__suspended__") {
        email = resolvedEmail;
      }
      identifierKind = "username";
    }
  }

  if (!email) {
    return { ok: true, message: genericConfirmationResendMessage };
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
    await writeErrorLog({
      route: "/login",
      action: "auth.resend_confirmation_failed",
      errorMessage: error.message,
      metadata: {
        identifier_type: identifierKind,
      },
    });
  }

  return { ok: true, message: genericConfirmationResendMessage };
}

export async function requestPasswordResetAction(emailInput: string): Promise<AuthActionResult> {
  const email = normalizeEmail(emailInput);
  const safeMessage = "Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña.";
  const resetLimit = await checkRateLimit({
    route: "/recuperar-contrasena",
    limit: 4,
    windowSeconds: 15 * 60,
    key: email,
  });

  if (!resetLimit.ok) {
    return { ok: false, message: rateLimitMessage };
  }

  if (!validateEmail(email)) {
    return { ok: true, message: safeMessage };
  }

  const supabase = await getSupabaseServerClient();
  const siteUrl = await getSiteUrl();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: buildAuthCallbackUrl(siteUrl, "/restablecer-contrasena"),
  });

  if (error) {
    await writeErrorLog({
      route: "/recuperar-contrasena",
      action: "auth.password_reset_request_failed",
      errorMessage: error.message,
      metadata: { email_present: true },
    });
  }

  return { ok: true, message: safeMessage };
}

export async function updatePasswordAfterRecoveryAction(password: string): Promise<AuthActionResult> {
  const updateLimit = await checkRateLimit({
    route: "/restablecer-contrasena",
    limit: 6,
    windowSeconds: 15 * 60,
  });

  if (!updateLimit.ok) {
    return { ok: false, message: rateLimitMessage };
  }

  if (password.length < 8) {
    return { ok: false, message: "La contraseña debe tener al menos 8 caracteres." };
  }

  const supabase = await getSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session || !hasRecoverySession(session.access_token)) {
    return { ok: false, message: "El enlace no es válido o expiró. Solicita uno nuevo." };
  }

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    await writeErrorLog({
      route: "/restablecer-contrasena",
      action: "auth.password_update_failed",
      errorMessage: error.message,
    });

    return { ok: false, message: getPasswordResetErrorMessage(error.message) };
  }

  await supabase.auth.signOut();

  return {
    ok: true,
    message: "Tu contraseña fue actualizada correctamente.",
    redirectTo: "/login?password_updated=1",
  };
}
