"use server";

import { cookies, headers } from "next/headers";
import { writeErrorLog } from "@/lib/error-logging";
import { checkRateLimit, getRateLimitMessage, type RateLimitResult } from "@/lib/rate-limit";
import { getSupabasePublicClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getAuthUserByEmail } from "@/lib/auth/email-confirmation";
import {
  ensureMyPortalCustomerProfile,
  ensurePortalCustomerProfileForUser,
} from "@/lib/auth/portal-customer-sync";
import { publicRegistrationSchema, type PublicRegistrationInput } from "@/lib/auth/registration-schema";
import { createVerificationSuccessToken } from "@/lib/auth/verification-token";
import { mapOperationalError, type MappedOperationalError } from "@/lib/operational-errors";
import { queueCustomerWelcomeEmail } from "@/lib/notifications/customer-lifecycle-emails";
import {
  emailExistsInProfile,
  ensureRetailProfile,
  getEmailForUsername,
  normalizeAuthEmail,
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

  if (process.env.VERCEL_ENV === "production") {
    return "https://carzoneaccesorios.com";
  }

  const requestHeaders = await headers();
  const host = requestHeaders.get("host");
  const proto = requestHeaders.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "https://carzoneaccesorios.com";
}

function buildAuthCallbackUrl(siteUrl: string, nextPath = "/verificacion/cuenta-confirmada", email?: string) {
  const callbackUrl = new URL("/auth/callback", siteUrl);
  callbackUrl.searchParams.set("next", safeNextPath(nextPath));
  if (email && validateEmail(email)) {
    callbackUrl.searchParams.set("email", email);
  }
  return callbackUrl.toString();
}

const genericConfirmationResendMessage =
  "Si el correo está registrado, enviaremos un nuevo enlace de verificación.";

type RegisterRateLimitCause = "email" | "device" | "ip";

type RegisterRateLimitBlock = {
  cause: RegisterRateLimitCause;
  result: RateLimitResult;
  limit: number;
  windowSeconds: number;
};

async function writeMappedAuthError(
  mapped: MappedOperationalError,
  userEmail?: string | null,
  metadata?: Record<string, unknown>,
) {
  await writeErrorLog({
    route: mapped.route,
    module: mapped.module,
    category: mapped.category,
    severity: mapped.severity,
    action: mapped.action,
    errorMessage: mapped.originalMessage,
    errorCode: mapped.code,
    httpStatus: mapped.status,
    customerMessage: mapped.customerMessage,
    adminReason: mapped.adminReason,
    recommendation: mapped.recommendation,
    userEmail,
    metadata,
  });
}

function retryAfterText(retryAfterSeconds?: number) {
  if (!retryAfterSeconds || retryAfterSeconds <= 0) {
    return "";
  }

  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return ` Podrás intentar nuevamente en aproximadamente ${minutes} ${minutes === 1 ? "minuto" : "minutos"}.`;
}

function getRegisterRateLimitMessage(cause: RegisterRateLimitCause, retryAfterSeconds?: number) {
  if (cause === "email") {
    return `Por seguridad, hemos pausado los intentos para este correo. Intenta nuevamente en unos minutos.${retryAfterText(retryAfterSeconds)}`;
  }

  if (cause === "device") {
    return `Por seguridad, hemos detectado muchos intentos desde este dispositivo. Espera unos minutos antes de intentar nuevamente.${retryAfterText(retryAfterSeconds)}`;
  }

  return `Por seguridad, hemos detectado muchos intentos desde esta conexión. Espera unos minutos antes de intentar nuevamente.${retryAfterText(retryAfterSeconds)}`;
}

function getRegisterRateLimitAdminReason(cause: RegisterRateLimitCause) {
  if (cause === "email") {
    return "Rate limit de registro activado por correo.";
  }

  if (cause === "device") {
    return "Rate limit de registro activado por IP y navegador.";
  }

  return "Rate limit global de registro activado por IP.";
}

async function checkRegisterRateLimits(email: string): Promise<RegisterRateLimitBlock | null> {
  const checks: Array<{ cause: RegisterRateLimitCause; limit: number; windowSeconds: number; result: RateLimitResult }> = [];

  const emailLimit = 5;
  const emailWindowSeconds = 15 * 60;
  const emailResult = await checkRateLimit({
    route: "/registro:email",
    limit: emailLimit,
    windowSeconds: emailWindowSeconds,
    key: email,
    scope: "key",
  });
  checks.push({ cause: "email", limit: emailLimit, windowSeconds: emailWindowSeconds, result: emailResult });

  if (!emailResult.ok) {
    return checks[0];
  }

  const deviceLimit = 20;
  const deviceWindowSeconds = 15 * 60;
  const deviceResult = await checkRateLimit({
    route: "/registro:device",
    limit: deviceLimit,
    windowSeconds: deviceWindowSeconds,
    scope: "ip-user-agent",
  });
  checks.push({ cause: "device", limit: deviceLimit, windowSeconds: deviceWindowSeconds, result: deviceResult });

  if (!deviceResult.ok) {
    return checks[1];
  }

  const ipLimit = 200;
  const ipWindowSeconds = 60 * 60;
  const ipResult = await checkRateLimit({
    route: "/registro:ip",
    limit: ipLimit,
    windowSeconds: ipWindowSeconds,
    scope: "ip",
  });
  checks.push({ cause: "ip", limit: ipLimit, windowSeconds: ipWindowSeconds, result: ipResult });

  if (!ipResult.ok) {
    return checks[2];
  }

  return null;
}

function getLoginErrorMessage(rawMessage: string, userExists: boolean) {
  const mapped = mapOperationalError(
    { message: rawMessage },
    { module: "auth", action: "auth.login_failed", route: "/login", category: "auth" },
  );

  if (!userExists && !rawMessage.toLowerCase().includes("not confirmed")) {
    return "Correo electrónico, usuario o contraseña incorrectos.";
  }

  return mapped.customerMessage;
}

function getRegisterErrorMessage(rawMessage: string) {
  const message = rawMessage.toLowerCase();

  if (message.includes("email rate limit")) {
    return "Supabase limitó temporalmente el envío de correos de verificación. Intenta nuevamente en unos minutos.";
  }

  if (message.includes("email address not authorized")) {
    return "Supabase no está autorizado para enviar correos a esta dirección. Configura SMTP personalizado para producción.";
  }

  if (message.includes("password") && message.includes("weak")) {
    return "La contraseña es muy débil. Usa al menos 8 caracteres.";
  }

  return mapOperationalError(
    { message: rawMessage },
    { module: "auth", action: "auth.register_failed", route: "/registro", category: "auth" },
  ).customerMessage;
}

function getPasswordResetErrorMessage(rawMessage: string) {
  const message = rawMessage.toLowerCase();

  if (message.includes("already") || message.includes("used")) {
    return "Este enlace ya fue utilizado. Solicita uno nuevo.";
  }

  if (message.includes("expired")) {
    return "Este enlace ha expirado. Solicita uno nuevo.";
  }

  if (message.includes("invalid") || message.includes("otp") || message.includes("token")) {
    return "El enlace no es válido. Solicita uno nuevo.";
  }

  if (message.includes("weak") || message.includes("password")) {
    return "La contraseña debe tener al menos 8 caracteres.";
  }

  return mapOperationalError(
    { message: rawMessage },
    { module: "auth", action: "auth.password_update_failed", route: "/actualizar-contrasena", category: "auth" },
  ).customerMessage;
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

const passwordRecoveryCookieName = "cz-password-recovery";

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
    return { ok: false as const, message: "Correo electrónico, usuario o contraseña incorrectos." };
  }

  const email = await getEmailForUsername(username.username);
  if (!email) {
    return { ok: false as const, message: "Correo electrónico, usuario o contraseña incorrectos." };
  }

  if (email === "__suspended__") {
    return { ok: false as const, message: "Esta cuenta está suspendida. Contacta al equipo de soporte para revisarla." };
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
    const mapped = mapOperationalError(
      { message: "rate limit", code: "RATE_LIMIT", status: 429 },
      {
        module: "auth",
        action: "auth.login_rate_limited",
        route: "/login",
        category: "auth",
        retryAfterSeconds: rateLimit.retryAfter,
      },
    );
    await writeMappedAuthError(mapped, looksLikeEmail(identifierInput) ? identifierInput : null, {
      identifier_type: looksLikeEmail(identifierInput) ? "email" : "username",
    });
    return { ok: false, message: getRateLimitMessage(rateLimit.retryAfter) };
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
    const mapped = mapOperationalError(error, {
      module: "auth",
      action: "auth.login_failed",
      route: "/login",
      category: "auth",
    });
    await writeMappedAuthError(mapped, resolved.email, {
      identifier_type: resolved.kind,
    });

    return {
      ok: false,
      message:
        resolved.kind === "username" && !error.message.toLowerCase().includes("not confirmed")
          ? "Correo electrónico, usuario o contraseña incorrectos."
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

    try {
      await ensureMyPortalCustomerProfile(supabase, data.user.id, "login", data.user.last_sign_in_at);
    } catch (syncError) {
      const mapped = mapOperationalError(syncError, {
        module: "auth",
        action: "auth.portal_customer_login_recovery_failed",
        route: "/login",
        category: "auth",
      });
      await writeMappedAuthError(mapped, data.user.email ?? resolved.email, {
        stage: "ensure_my_portal_customer_profile_v1",
        source: "login",
      });
    }

    const { data: profile } = await supabase
      .from("users")
      .select("active")
      .eq("id", data.user.id)
      .maybeSingle<{ active: boolean }>();

    if (profile?.active === false) {
      await supabase.auth.signOut();
      return { ok: false, message: "Esta cuenta está suspendida. Contacta al equipo de soporte para revisarla." };
    }
  }

  return { ok: true, message: "Sesión iniciada correctamente.", redirectTo: nextPath };
}

export async function registerWithEmailAction(input: PublicRegistrationInput): Promise<AuthActionResult> {
  const parsed = publicRegistrationSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Revisa los datos del registro e inténtalo nuevamente.",
    };
  }

  const validatedInput = parsed.data;
  const emailForLimit = validatedInput.email;
  const registerLimit = await checkRegisterRateLimits(emailForLimit);

  if (registerLimit) {
    const message = getRegisterRateLimitMessage(registerLimit.cause, registerLimit.result.retryAfter);
    const mapped = mapOperationalError(
      { message: `rate limit: register ${registerLimit.cause}`, code: "RATE_LIMIT", status: 429 },
      {
        module: "auth",
        action: "auth.register_rate_limited",
        route: registerLimit.result.route,
        category: "auth",
        retryAfterSeconds: registerLimit.result.retryAfter,
      },
    );
    await writeMappedAuthError(
      {
        ...mapped,
        customerMessage: message,
        adminReason: getRegisterRateLimitAdminReason(registerLimit.cause),
        recommendation:
          registerLimit.cause === "email"
            ? "Pedir al cliente esperar unos minutos o revisar si ya intentó registrar ese correo."
            : "Pedir al cliente esperar unos minutos; si es una sucursal o red compartida, intentar más tarde.",
      },
      validatedInput.email,
      {
        rate_limit_kind: registerLimit.cause,
        route_key: registerLimit.result.route,
        scope: registerLimit.result.scope,
        attempts: registerLimit.result.attempts,
        limit: registerLimit.limit,
        window_seconds: registerLimit.windowSeconds,
        username_present: Boolean(validatedInput.username.trim()),
      },
    );
    return { ok: false, message };
  }

  const fullName = validatedInput.fullName;
  const username = validateUsername(validatedInput.username);
  const email = emailForLimit;
  const phone = validatedInput.phone;
  const nextPath = safeNextPath(validatedInput.nextPath);

  if (!username.ok) {
    return { ok: false, message: username.message };
  }

  if (await emailExistsInProfile(email)) {
    return { ok: false, message: "Este correo ya tiene una cuenta registrada. Intenta iniciar sesión o recupera tu contraseña." };
  }

  if (await usernameExistsInProfile(username.username)) {
    return { ok: false, message: "Este nombre de usuario ya está en uso. Prueba con otro." };
  }

  const supabase = await getSupabaseServerClient();

  const siteUrl = await getSiteUrl();
  const emailRedirectTo = buildAuthCallbackUrl(siteUrl, nextPath, email);
  const { data, error } = await supabase.auth.signUp({
    email,
    password: validatedInput.password,
    options: {
      emailRedirectTo,
      data: {
        full_name: fullName,
        username: username.username,
        phone,
      },
    },
  });

  if (error) {
    const mapped = mapOperationalError(error, {
      module: "auth",
      action: "auth.register_failed",
      route: "/registro",
      category: "auth",
    });
    await writeMappedAuthError(mapped, email, {
      stage: "supabase.auth.signUp",
      email_redirect_origin: new URL(emailRedirectTo).origin,
      email_redirect_path: new URL(emailRedirectTo).pathname,
      auth_email_provider: "supabase-auth-smtp",
      username_present: Boolean(username.username),
      phone_present: Boolean(phone),
      sign_up_returned_user: Boolean(data.user),
      sign_up_returned_session: Boolean(data.session),
    });
    return { ok: false, message: getRegisterErrorMessage(error.message) };
  }

  if (data.user?.identities && data.user.identities.length === 0) {
    return { ok: false, message: "Este correo ya tiene una cuenta registrada. Intenta iniciar sesión o recupera tu contraseña." };
  }

  if (data.user) {
    await ensureRetailProfile({
      userId: data.user.id,
      email: data.user.email ?? email,
      fullName,
      phone,
      username: username.username,
    });

    try {
      await ensurePortalCustomerProfileForUser(data.user.id, "registration");
    } catch (syncError) {
      const mapped = mapOperationalError(syncError, {
        module: "auth",
        action: "auth.portal_customer_registration_sync_failed",
        route: "/registro",
        category: "auth",
      });
      await writeMappedAuthError(mapped, data.user.email ?? email, {
        stage: "ensure_portal_customer_profile_internal_v1",
        source: "registration",
        recovery_available: true,
      });
    }
  }

  if (!data.session) {
    return {
      ok: true,
      message: "Cuenta creada correctamente. Te enviamos un correo para verificar tu dirección.",
      redirectTo: `/login?check_email=1&email=${encodeURIComponent(email)}`,
      needsEmailConfirmation: true,
    };
  }

  if (data.user) {
    await queueCustomerWelcomeEmail({
      userId: data.user.id,
      email: data.user.email ?? email,
      name: fullName,
    });
  }

  return {
    ok: true,
    message: "Cuenta creada correctamente. Ahora puedes iniciar sesión.",
    redirectTo: nextPath,
  };
}

export async function checkRegisteredEmailVerificationAction(emailInput: string): Promise<AuthActionResult> {
  const email = normalizeEmail(emailInput);
  const notVerifiedMessage = "Tu cuenta aún no ha sido verificada. Revisa tu correo y presiona el botón de confirmación.";

  const checkLimit = await checkRateLimit({
    route: "/registro:verification-check",
    limit: 40,
    windowSeconds: 15 * 60,
    key: email,
  });

  if (!checkLimit.ok) {
    return { ok: false, message: getRateLimitMessage(checkLimit.retryAfter) };
  }

  const deviceLimit = await checkRateLimit({
    route: "/registro:verification-check:device",
    limit: 80,
    windowSeconds: 15 * 60,
    scope: "ip-user-agent",
  });

  if (!deviceLimit.ok) {
    return { ok: false, message: getRateLimitMessage(deviceLimit.retryAfter) };
  }

  const ipLimit = await checkRateLimit({
    route: "/registro:verification-check:ip",
    limit: 180,
    windowSeconds: 15 * 60,
    scope: "ip",
  });

  if (!ipLimit.ok) {
    return { ok: false, message: getRateLimitMessage(ipLimit.retryAfter) };
  }

  if (!validateEmail(email)) {
    return { ok: false, message: notVerifiedMessage };
  }

  try {
    const user = await getAuthUserByEmail(email);
    const confirmed = Boolean(user?.email_confirmed_at || user?.confirmed_at);

    if (!user || !confirmed) {
      return { ok: false, message: notVerifiedMessage };
    }

    await ensureRetailProfile({
      userId: user.id,
      email: user.email ?? email,
      fullName: user.user_metadata?.full_name,
      phone: user.user_metadata?.phone,
      username: user.user_metadata?.username,
    });

    try {
      await ensurePortalCustomerProfileForUser(
        user.id,
        "callback",
        user.email_confirmed_at ?? user.confirmed_at,
      );
    } catch (syncError) {
      const mapped = mapOperationalError(syncError, {
        module: "auth",
        action: "auth.portal_customer_verification_sync_failed",
        route: "/registro",
        category: "auth",
      });
      await writeMappedAuthError(mapped, user.email ?? email, {
        stage: "ensure_portal_customer_profile_internal_v1",
        source: "callback",
        recovery_available: true,
      });
    }

    await queueCustomerWelcomeEmail({
      userId: user.id,
      email: user.email ?? email,
      name: user.user_metadata?.full_name,
    });

    return {
      ok: true,
      message: "Cuenta verificada correctamente. Ahora puedes iniciar sesión.",
      redirectTo: `/login?verified=1&email=${encodeURIComponent(email)}&verification_token=${encodeURIComponent(createVerificationSuccessToken())}`,
    };
  } catch (error) {
    const mapped = mapOperationalError(error, {
      module: "auth",
      action: "auth.registration_verification_check_failed",
      route: "/registro",
      category: "auth",
    });
    await writeMappedAuthError(mapped, email, { check_type: "registration_email_confirmation" });

    return {
      ok: false,
      message: "No pudimos revisar la verificación en este momento. Inténtalo nuevamente.",
    };
  }
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
    const mapped = mapOperationalError(
      { message: "rate limit", code: "RATE_LIMIT", status: 429 },
      {
        module: "auth",
        action: "auth.resend_confirmation_rate_limited",
        route: "/login/resend-confirmation",
        category: "auth",
        retryAfterSeconds: resendLimit.retryAfter,
      },
    );
    await writeMappedAuthError(mapped, looksLikeEmail(normalizedIdentifier) ? normalizedIdentifier : null, {
      identifier_type: looksLikeEmail(normalizedIdentifier) ? "email" : "username",
    });
    return { ok: false, message: getRateLimitMessage(resendLimit.retryAfter) };
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
      emailRedirectTo: buildAuthCallbackUrl(siteUrl, "/verificacion/cuenta-confirmada", email),
    },
  });

  if (error) {
    const mapped = mapOperationalError(error, {
      module: "auth",
      action: "auth.resend_confirmation_failed",
      route: "/login/resend-confirmation",
      category: "auth",
    });
    await writeMappedAuthError(mapped, email, {
      identifier_type: identifierKind,
    });
  }

  return { ok: true, message: genericConfirmationResendMessage };
}

export async function requestPasswordResetAction(emailInput: string): Promise<AuthActionResult> {
  const email = normalizeEmail(emailInput);
  const safeMessage = "Si el correo está registrado, recibirás instrucciones para restablecer tu contraseña.";
  const resetLimit = await checkRateLimit({
    route: "/recuperar-contrasena",
    limit: 3,
    windowSeconds: 15 * 60,
    key: email,
  });

  if (!resetLimit.ok) {
    const mapped = mapOperationalError(
      { message: "rate limit", code: "RATE_LIMIT", status: 429 },
      {
        module: "auth",
        action: "auth.password_reset_request_rate_limited",
        route: "/recuperar-contrasena",
        category: "auth",
        retryAfterSeconds: resetLimit.retryAfter,
      },
    );
    await writeMappedAuthError(mapped, email, { email_present: Boolean(email) });
    return { ok: false, message: getRateLimitMessage(resetLimit.retryAfter) };
  }

  if (!validateEmail(email)) {
    return { ok: true, message: safeMessage };
  }

  const siteUrl = await getSiteUrl();
  const supabase = getSupabasePublicClient();
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: buildAuthCallbackUrl(siteUrl, "/actualizar-contrasena"),
  });

  if (error) {
    const mapped = mapOperationalError(error, {
      module: "auth",
      action: "auth.password_reset_request_failed",
      route: "/recuperar-contrasena",
      category: "auth",
    });
    await writeMappedAuthError(mapped, email, {
      email_present: true,
      auth_flow: "implicit_recovery",
      redirect_to: buildAuthCallbackUrl(siteUrl, "/actualizar-contrasena"),
    });
  }

  return { ok: true, message: safeMessage };
}

export async function updatePasswordAfterRecoveryAction(password: string): Promise<AuthActionResult> {
  const updateLimit = await checkRateLimit({
    route: "/actualizar-contrasena",
    limit: 6,
    windowSeconds: 15 * 60,
  });

  if (!updateLimit.ok) {
    const mapped = mapOperationalError(
      { message: "rate limit", code: "RATE_LIMIT", status: 429 },
      {
        module: "auth",
        action: "auth.password_update_rate_limited",
        route: "/actualizar-contrasena",
        category: "auth",
        retryAfterSeconds: updateLimit.retryAfter,
      },
    );
    await writeMappedAuthError(mapped);
    return { ok: false, message: getRateLimitMessage(updateLimit.retryAfter) };
  }

  if (password.length < 8) {
    return { ok: false, message: "La contraseña debe tener al menos 8 caracteres." };
  }

  const supabase = await getSupabaseServerClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const cookieStore = await cookies();
  const hasPasswordRecoveryCookie = cookieStore.get(passwordRecoveryCookieName)?.value === "1";

  if (!session || (!hasRecoverySession(session.access_token) && !hasPasswordRecoveryCookie)) {
    return { ok: false, message: "El enlace no es válido. Solicita uno nuevo." };
  }

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    const mapped = mapOperationalError(error, {
      module: "auth",
      action: "auth.password_update_failed",
      route: "/actualizar-contrasena",
      category: "auth",
    });
    await writeMappedAuthError(mapped);

    return { ok: false, message: getPasswordResetErrorMessage(error.message) };
  }

  await supabase.auth.signOut();
  cookieStore.delete(passwordRecoveryCookieName);

  return {
    ok: true,
    message: "Tu contraseña fue actualizada correctamente.",
    redirectTo: "/login?password_updated=1",
  };
}
