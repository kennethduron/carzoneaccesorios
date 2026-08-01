export const refreshTokenNotFoundCode = "refresh_token_not_found";
export const authTelemetryCookieName = "cz-auth-event-recent";

type AuthErrorLike = { code?: unknown; name?: unknown; message?: unknown; status?: unknown } | null | undefined;

export type AuthSessionEvent =
  | "auth.session_expired_handled"
  | "auth.login_required"
  | "auth.refresh_failed_unexpected"
  | "auth.permission_denied";

export function safeAuthErrorCode(error: AuthErrorLike) {
  const code = typeof error?.code === "string" ? error.code.trim().toLowerCase() : "";
  return /^[a-z0-9_]{3,80}$/.test(code) ? code : "auth_error_unclassified";
}

export function isRefreshTokenNotFound(error: AuthErrorLike) {
  return safeAuthErrorCode(error) === refreshTokenNotFoundCode;
}

export function isSupabaseAuthCookie(name: string) {
  return /^sb-[a-z0-9]+-auth-token(?:\.\d+)?$/i.test(name);
}

export function localAuthCookieNames(cookies: Array<{ name: string }>) {
  return cookies.map((cookie) => cookie.name).filter(isSupabaseAuthCookie);
}

export function safeNextPath(pathname: string, search: string) {
  const candidate = `${pathname}${search}`;
  return candidate.startsWith("/") && !candidate.startsWith("//") ? candidate : "/";
}

export async function writeAuthSessionEvent(input: {
  event: AuthSessionEvent;
  route: string;
  code: string;
  outcome: "redirect_login" | "redirect_denied";
  severity?: "info" | "warning";
}) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return;

  const safeCode = /^[a-z0-9_]{3,80}$/.test(input.code) ? input.code : "auth_error_unclassified";
  try {
    await fetch(`${supabaseUrl}/rest/v1/rpc/write_error_log`, {
      method: "POST",
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        affected_route: input.route.slice(0, 180),
        action_name: input.event,
        error_message: "Sanitized authentication session event.",
        error_stack: null,
        error_metadata: {
          module: "auth",
          category: "auth",
          severity: input.severity ?? "info",
          status: "resolved",
          code: safeCode,
          client_type: "next_proxy",
          redirect_outcome: input.outcome,
        },
      }),
      cache: "no-store",
    });
  } catch {
    // Authentication recovery must not fail because optional telemetry is unavailable.
  }
}
