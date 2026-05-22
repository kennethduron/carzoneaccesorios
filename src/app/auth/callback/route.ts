import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { ensureRetailProfile } from "@/lib/auth/profile-sync";

export const dynamic = "force-dynamic";

function safeNextPath(value: string | null) {
  if (!value?.startsWith("/") || value.startsWith("//")) {
    return "/cuenta";
  }

  return value;
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
  } else {
    url.searchParams.set("reason", reason);
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
  return NextResponse.redirect(url);
}

function confirmationErrorReason(message: string) {
  const normalized = message.toLowerCase();

  if (normalized.includes("expired") || normalized.includes("invalid") || normalized.includes("otp")) {
    return "expired";
  }

  if (normalized.includes("already")) {
    return "already_confirmed";
  }

  return "failed";
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const tokenHash = request.nextUrl.searchParams.get("token_hash");
  const type = (request.nextUrl.searchParams.get("type") ?? "signup") as EmailOtpType;
  const requestedNext = safeNextPath(request.nextUrl.searchParams.get("next"));
  const isRecoveryFlow = requestedNext === "/restablecer-contrasena" || type === "recovery";

  if (request.nextUrl.searchParams.get("error")) {
    if (isRecoveryFlow) {
      return redirectToPasswordRecovery(request);
    }

    return redirectToVerificationError(request, "failed");
  }

  if (!code && !tokenHash) {
    if (isRecoveryFlow) {
      return redirectToPasswordRecovery(request);
    }

    return redirectToVerificationError(request, "missing");
  }

  const supabase = await getSupabaseServerClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      if (isRecoveryFlow) {
        return redirectToPasswordRecovery(request);
      }

      return redirectToVerificationError(request, confirmationErrorReason(error.message));
    }
  } else if (tokenHash) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    });

    if (error) {
      if (isRecoveryFlow) {
        return redirectToPasswordRecovery(request);
      }

      return redirectToVerificationError(request, confirmationErrorReason(error.message));
    }
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
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
    userId: user.id,
    email: user.email ?? "",
    fullName: user.user_metadata?.full_name,
    phone: user.user_metadata?.phone,
  });

  await supabase.auth.signOut();

  return redirectToVerified(request);
}
