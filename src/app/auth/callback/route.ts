import { type EmailOtpType, type User } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { writeErrorLog } from "@/lib/error-logging";
import { mapOperationalError } from "@/lib/operational-errors";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getAuthUserByEmail, isValidAuthEmail } from "@/lib/auth/email-confirmation";
import { ensureRetailProfile } from "@/lib/auth/profile-sync";
import { createVerificationSuccessToken } from "@/lib/auth/verification-token";

export const dynamic = "force-dynamic";

function safeNextPath(value: string | null) {
  if (!value?.startsWith("/") || value.startsWith("//")) {
    return "/verificacion/cuenta-confirmada";
  }

  return value;
}

function getStringParam(request: NextRequest, key: string) {
  const value = request.nextUrl.searchParams.get(key);
  return value?.trim() || null;
}

function getRequestEmail(request: NextRequest) {
  const email = getStringParam(request, "email")?.toLowerCase() ?? null;
  if (email && isValidAuthEmail(email)) {
    return email;
  }

  const nextPath = getStringParam(request, "next");
  if (nextPath?.startsWith("/") && !nextPath.startsWith("//")) {
    const nextEmail = new URL(nextPath, request.nextUrl.origin).searchParams.get("email")?.trim().toLowerCase() ?? null;
    if (nextEmail && isValidAuthEmail(nextEmail)) {
      return nextEmail;
    }
  }

  const redirectTo = getStringParam(request, "redirect_to");
  if (redirectTo) {
    try {
      const redirectEmail = new URL(redirectTo, request.nextUrl.origin).searchParams.get("email")?.trim().toLowerCase() ?? null;
      if (redirectEmail && isValidAuthEmail(redirectEmail)) {
        return redirectEmail;
      }
    } catch {
      return null;
    }
  }

  return null;
}

function redirectToVerificationError(
  request: NextRequest,
  reason: "missing" | "expired" | "failed" | "already_confirmed" = "failed",
) {
  const url = request.nextUrl.clone();
  url.pathname = reason === "already_confirmed" ? "/verificacion/cuenta-confirmada" : "/verificacion/enlace-invalido";
  url.search = "";
  if (reason === "already_confirmed") {
    url.searchParams.set("status", "already");
    url.searchParams.set("verification_token", createVerificationSuccessToken("already"));
  } else {
    url.searchParams.set("reason", reason);
    const errorCode = request.nextUrl.searchParams.get("error_code");
    const error = request.nextUrl.searchParams.get("error");
    const email = getRequestEmail(request);
    if (errorCode) {
      url.searchParams.set("error_code", errorCode);
    }
    if (error) {
      url.searchParams.set("error", error);
    }
    if (email) {
      url.searchParams.set("email", email);
    }
  }
  return NextResponse.redirect(url);
}

function redirectToPasswordRecovery(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/recuperar-contrasena";
  url.search = "";
  url.searchParams.set("reset_error", "expired");
  return NextResponse.redirect(url);
}

function redirectToVerified(request: NextRequest, status: "verified" | "already" = "verified") {
  const url = request.nextUrl.clone();
  url.pathname = "/verificacion/cuenta-confirmada";
  url.search = "";
  url.searchParams.set("status", status);
  url.searchParams.set("verification_token", createVerificationSuccessToken(status));
  return NextResponse.redirect(url);
}

function confirmationErrorReason(message: string) {
  const normalized = message.toLowerCase();

  if (
    normalized.includes("expired") ||
    normalized.includes("invalid") ||
    normalized.includes("otp") ||
    normalized.includes("access_denied") ||
    normalized.includes("access denied")
  ) {
    return "expired";
  }

  if (normalized.includes("already")) {
    return "already_confirmed";
  }

  return "failed";
}

async function ensureProfileForConfirmedEmail(email: string) {
  const user = await getAuthUserByEmail(email);
  if (!user || !(user.email_confirmed_at || user.confirmed_at)) {
    return false;
  }

  await ensureRetailProfile({
    userId: user.id,
    email: user.email ?? email,
    fullName: user.user_metadata?.full_name,
    phone: user.user_metadata?.phone,
    username: user.user_metadata?.username,
  });

  return true;
}

async function logAuthCallbackError(request: NextRequest, action: string, error: unknown) {
  const mapped = mapOperationalError(error, {
    module: "auth",
    action,
    route: "/auth/callback",
    category: "auth",
  });

  await writeErrorLog({
    route: mapped.route,
    module: mapped.module,
    category: mapped.category,
    severity: mapped.severity,
    action: mapped.action,
    errorMessage: mapped.originalMessage,
    errorCode: mapped.code ?? request.nextUrl.searchParams.get("error_code"),
    httpStatus: mapped.status,
    customerMessage: mapped.customerMessage,
    adminReason: mapped.adminReason,
    recommendation: mapped.recommendation,
    userEmail: getRequestEmail(request),
    metadata: {
      raw_type: request.nextUrl.searchParams.get("type"),
      requested_next: safeNextPath(request.nextUrl.searchParams.get("next")),
      has_code: Boolean(request.nextUrl.searchParams.get("code")),
      has_token_hash: Boolean(request.nextUrl.searchParams.get("token_hash")),
      error: request.nextUrl.searchParams.get("error"),
      error_code: request.nextUrl.searchParams.get("error_code"),
    },
  });
}

async function redirectToVerifiedIfConfirmed(request: NextRequest, errorMessage: string) {
  const reason = confirmationErrorReason(errorMessage);
  if (reason !== "expired" && reason !== "already_confirmed") {
    return null;
  }

  const email = getRequestEmail(request);
  if (!email) {
    return null;
  }

  return (await ensureProfileForConfirmedEmail(email))
    ? redirectToVerified(request, "already")
    : null;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const rawType = request.nextUrl.searchParams.get("type") ?? "signup";
  const type = rawType as EmailOtpType;
  const requestedNext = safeNextPath(request.nextUrl.searchParams.get("next"));
  const isRecoveryFlow = requestedNext === "/restablecer-contrasena" || type === "recovery";
  let callbackUser: User | null = null;

  if (request.nextUrl.searchParams.get("error")) {
    const errorText = [
      request.nextUrl.searchParams.get("error"),
      request.nextUrl.searchParams.get("error_code"),
      request.nextUrl.searchParams.get("error_description"),
    ]
      .filter(Boolean)
      .join(" ");

    await logAuthCallbackError(request, "auth.callback_provider_error", {
      message: request.nextUrl.searchParams.get("error_description") ?? request.nextUrl.searchParams.get("error") ?? "Auth callback error",
      code: request.nextUrl.searchParams.get("error_code"),
    });

    if (isRecoveryFlow) {
      return redirectToPasswordRecovery(request);
    }

    const verifiedRedirect = await redirectToVerifiedIfConfirmed(request, errorText);
    if (verifiedRedirect) {
      return verifiedRedirect;
    }

    return redirectToVerificationError(request, confirmationErrorReason(errorText));
  }

  if (!code && !tokenHash) {
    if (isRecoveryFlow) {
      return redirectToPasswordRecovery(request);
    }

    return redirectToVerificationError(request, "missing");
  }

  const supabase = await getSupabaseServerClient();

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      await logAuthCallbackError(request, "auth.callback_exchange_failed", error);

      if (isRecoveryFlow) {
        return redirectToPasswordRecovery(request);
      }

      const verifiedRedirect = await redirectToVerifiedIfConfirmed(request, error.message);
      if (verifiedRedirect) {
        return verifiedRedirect;
      }

      return redirectToVerificationError(request, confirmationErrorReason(error.message));
    }
    callbackUser = data.user ?? null;
  } else if (tokenHash) {
    const { data, error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    });
    callbackUser = data.user ?? null;

    if (error) {
      if (rawType === "email") {
        const { data: signupFallbackData, error: signupFallbackError } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: "signup",
        });

        if (!signupFallbackError) {
          const user = signupFallbackData.user;

          if (user) {
            await ensureRetailProfile({
              userId: user.id,
              email: user.email ?? "",
              fullName: user.user_metadata?.full_name,
              phone: user.user_metadata?.phone,
            });

            await supabase.auth.signOut();
            return redirectToVerified(request);
          }
        }
      }

      await logAuthCallbackError(request, "auth.callback_verify_otp_failed", error);

      if (isRecoveryFlow) {
        return redirectToPasswordRecovery(request);
      }

      const verifiedRedirect = await redirectToVerifiedIfConfirmed(request, error.message);
      if (verifiedRedirect) {
        return verifiedRedirect;
      }

      return redirectToVerificationError(request, confirmationErrorReason(error.message));
    }
  }

  if (!callbackUser) {
    await logAuthCallbackError(request, "auth.callback_user_missing", { message: "No authenticated user after callback" });

    if (isRecoveryFlow) {
      return redirectToPasswordRecovery(request);
    }

    return redirectToVerificationError(request, "failed");
  }

  if (isRecoveryFlow) {
    const url = request.nextUrl.clone();
    url.pathname = "/restablecer-contrasena";
    url.search = "";
    url.searchParams.set("recovery", "1");
    return NextResponse.redirect(url);
  }

  await ensureRetailProfile({
    userId: callbackUser.id,
    email: callbackUser.email ?? "",
    fullName: callbackUser.user_metadata?.full_name,
    phone: callbackUser.user_metadata?.phone,
  });

  await supabase.auth.signOut();

  return redirectToVerified(request);
}
