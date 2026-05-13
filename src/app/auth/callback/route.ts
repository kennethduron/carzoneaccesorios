import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { ensureRetailProfile, getUserRole } from "@/lib/auth/profile-sync";
import type { AppRole } from "@/types/auth";

export const dynamic = "force-dynamic";

const adminRoles: AppRole[] = ["technical_owner", "admin", "vendedor", "bodega", "contadora"];

function safeNextPath(value: string | null) {
  if (!value?.startsWith("/") || value.startsWith("//")) {
    return "/cuenta";
  }

  return value;
}

function redirectToLogin(request: NextRequest, reason: "missing" | "expired" | "failed" | "already_confirmed" = "failed") {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  url.searchParams.set("confirmation_error", reason);
  return NextResponse.redirect(url);
}

function redirectAfterConfirmation(request: NextRequest, role: AppRole | null, requestedNext: string) {
  const url = request.nextUrl.clone();

  if (role && adminRoles.includes(role)) {
    url.pathname = "/admin";
  } else {
    url.pathname = requestedNext.startsWith("/admin") ? "/cuenta" : requestedNext;
  }

  url.search = "";
  url.searchParams.set("confirmed", "1");
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
  const type = (request.nextUrl.searchParams.get("type") ?? "email") as EmailOtpType;
  const requestedNext = safeNextPath(request.nextUrl.searchParams.get("next"));

  if (request.nextUrl.searchParams.get("error")) {
    return redirectToLogin(request, "failed");
  }

  if (!code && !tokenHash) {
    return redirectToLogin(request, "missing");
  }

  const supabase = await getSupabaseServerClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      return redirectToLogin(request, confirmationErrorReason(error.message));
    }
  } else if (tokenHash) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type,
    });

    if (error) {
      return redirectToLogin(request, confirmationErrorReason(error.message));
    }
  }

  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  if (userError || !user) {
    return redirectToLogin(request, "failed");
  }

  const roleFromSync = await ensureRetailProfile({
    userId: user.id,
    email: user.email ?? "",
    fullName: user.user_metadata?.full_name,
    phone: user.user_metadata?.phone,
  });
  const role = roleFromSync ?? (await getUserRole(user.id));

  return redirectAfterConfirmation(request, role, requestedNext);
}
