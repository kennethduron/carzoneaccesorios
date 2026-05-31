import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { AppRole } from "@/types/auth";

const protectedRoutes = ["/cuenta", "/mis-pedidos", "/facturas"];
const adminRoutes = ["/admin"];
const adminAccessRoles: AppRole[] = ["technical_owner", "admin", "business_owner", "vendedor", "bodega", "contadora", "soporte"];
const securityAccessRoles: AppRole[] = ["technical_owner", "business_owner", "admin"];

export async function proxy(request: NextRequest) {
  const response = NextResponse.next({
    request,
  });

  const pathname = request.nextUrl.pathname;
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
  } = await supabase.auth.getUser();

  if (!user) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
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
    const deniedUrl = request.nextUrl.clone();
    deniedUrl.pathname = "/sin-permiso";
    deniedUrl.search = "";
    return NextResponse.redirect(deniedUrl);
  }

  if (pathname.startsWith("/admin/seguridad") && !securityAccessRoles.includes(profile.roles.name)) {
    const deniedUrl = request.nextUrl.clone();
    deniedUrl.pathname = "/sin-permiso";
    deniedUrl.search = "";
    return NextResponse.redirect(deniedUrl);
  }

  if (
    pathname.startsWith("/admin/uso") &&
    profile.roles.name !== "technical_owner" &&
    profile.email?.trim().toLowerCase() !== "kennethduron.paz@gmail.com"
  ) {
    const deniedUrl = request.nextUrl.clone();
    deniedUrl.pathname = "/sin-permiso";
    deniedUrl.search = "";
    return NextResponse.redirect(deniedUrl);
  }

  return response;
}

export const config = {
  matcher: ["/admin/:path*", "/cuenta/:path*", "/mis-pedidos/:path*", "/facturas/:path*", "/facturas"],
};
