import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { normalizeProductCategorySlug } from "@/lib/product-categories";
import {
  authTelemetryCookieName,
  isRefreshTokenNotFound,
  localAuthCookieNames,
  safeAuthErrorCode,
  safeNextPath,
  writeAuthSessionEvent,
} from "@/lib/auth/session-errors";
import type { AppRole } from "@/types/auth";

const protectedRoutes = ["/cuenta", "/mis-pedidos", "/facturas"];
const adminRoutes = ["/admin"];
const adminAccessRoles: AppRole[] = ["technical_owner", "admin", "business_owner", "vendedor", "bodega", "contadora", "soporte"];
const securityAccessRoles: AppRole[] = ["technical_owner", "business_owner", "admin"];

async function permissionDeniedResponse(request: NextRequest) {
  const deniedUrl = request.nextUrl.clone();
  deniedUrl.pathname = "/sin-permiso";
  deniedUrl.search = "";
  const deniedResponse = NextResponse.redirect(deniedUrl);
  if (!request.cookies.has(authTelemetryCookieName)) {
    await writeAuthSessionEvent({
      event: "auth.permission_denied",
      route: request.nextUrl.pathname,
      code: "permission_denied",
      outcome: "redirect_denied",
      severity: "warning",
    });
  }
  deniedResponse.cookies.set(authTelemetryCookieName, "auth.permission_denied", {
    path: "/",
    maxAge: 300,
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
  });
  return deniedResponse;
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (request.method === "GET" && pathname === "/catalogo") {
    const requestedCategory = request.nextUrl.searchParams.get("categoria");
    const canonicalCategory = normalizeProductCategorySlug(requestedCategory);

    if (requestedCategory && canonicalCategory && requestedCategory !== canonicalCategory) {
      const canonicalUrl = request.nextUrl.clone();
      canonicalUrl.searchParams.set("categoria", canonicalCategory);
      return NextResponse.redirect(canonicalUrl, 308);
    }
  }

  const response = NextResponse.next({
    request,
  });

  const isProtectedRoute = protectedRoutes.some((route) => pathname.startsWith(route));
  const isAdminRoute = adminRoutes.some((route) => pathname.startsWith(route));

  if (!isProtectedRoute && !isAdminRoute) {
    return response;
  }

  response.headers.set("Cache-Control", "no-store, max-age=0");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return response;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (!user) {
    const expiredSession = isRefreshTokenNotFound(authError);
    const event = expiredSession
      ? "auth.session_expired_handled"
      : authError
        ? "auth.refresh_failed_unexpected"
        : "auth.login_required";
    const errorCode = expiredSession ? "refresh_token_not_found" : authError ? safeAuthErrorCode(authError) : "login_required";
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    loginUrl.searchParams.set("next", safeNextPath(pathname, request.nextUrl.search));
    if (expiredSession) loginUrl.searchParams.set("reason", "session_expired");
    const redirectResponse = NextResponse.redirect(loginUrl);

    if (expiredSession) {
      for (const name of localAuthCookieNames(request.cookies.getAll())) {
        redirectResponse.cookies.set(name, "", { path: "/", maxAge: 0, httpOnly: true, sameSite: "lax" });
      }
    }

    if (!request.cookies.has(authTelemetryCookieName)) {
      await writeAuthSessionEvent({
        event,
        route: pathname,
        code: errorCode,
        outcome: "redirect_login",
        severity: authError && !expiredSession ? "warning" : "info",
      });
    }
    redirectResponse.cookies.set(authTelemetryCookieName, event, {
      path: "/",
      maxAge: 300,
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
    });
    return redirectResponse;
  }

  if (!isAdminRoute) {
    return response;
  }

  const { data: profile } = await supabase
    .from("users")
    .select("active, email, roles(name)")
    .eq("id", user.id)
    .maybeSingle<{ active: boolean; email: string | null; roles: { name: AppRole } | null }>();

  if (!profile?.active || !profile.roles || !adminAccessRoles.includes(profile.roles.name)) {
    return permissionDeniedResponse(request);
  }

  if (pathname.startsWith("/admin/seguridad") && !securityAccessRoles.includes(profile.roles.name)) {
    return permissionDeniedResponse(request);
  }

  if (
    pathname.startsWith("/admin/uso") &&
    profile.roles.name !== "technical_owner" &&
    profile.email?.trim().toLowerCase() !== "kennethduron.paz@gmail.com"
  ) {
    return permissionDeniedResponse(request);
  }

  return response;
}

export const config = {
  matcher: ["/catalogo", "/admin/:path*", "/cuenta/:path*", "/mis-pedidos/:path*", "/facturas/:path*", "/facturas"],
};
