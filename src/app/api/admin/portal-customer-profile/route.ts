import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSessionProfile } from "@/lib/auth/session";
import { hasEffectivePermission } from "@/lib/auth/permissions";
import { writeErrorLog } from "@/lib/error-logging";
import { getSupabaseServerClient } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

const allowedRoles = new Set(["technical_owner", "business_owner", "admin"]);

const recoverySchema = z.object({
  portalUserId: z.string().uuid(),
  requestKey: z.string().uuid(),
  expectedState: z.enum([
    "unresolved",
    "profile_created",
    "already_linked",
    "review_required",
    "internal_user_ignored",
    "inactive_account",
    "invalid_account",
    "failed",
  ]),
  reason: z.string().trim().min(10).max(500),
});

async function authorizedProfile() {
  const profile = await getSessionProfile();
  if (
    !profile ||
    !allowedRoles.has(profile.role) ||
    !(
      hasEffectivePermission(profile.role, profile.permissions, "customers:manage", profile.email) ||
      hasEffectivePermission(profile.role, profile.permissions, "customers:link_portal_account", profile.email)
    )
  ) {
    return null;
  }

  return profile;
}

export async function GET(request: NextRequest) {
  const profile = await authorizedProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, message: "No autorizado." }, { status: 401 });
  }

  const portalUserId = request.nextUrl.searchParams.get("portalUserId");
  const parsedUserId = z.string().uuid().safeParse(portalUserId);
  if (!parsedUserId.success) {
    return NextResponse.json({ ok: false, message: "La cuenta indicada no es válida." }, { status: 400 });
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("preview_admin_portal_customer_profile_v1", {
    p_portal_user_id: parsedUserId.data,
  });

  if (error) {
    await writeErrorLog({
      route: "/api/admin/portal-customer-profile",
      module: "crm",
      category: "crm",
      action: "portal_customer_profile.admin_preview_failed",
      errorMessage: error.message,
      userId: profile.id,
      metadata: { target_present: true },
    });
    return NextResponse.json({ ok: false, message: "No se pudo preparar la revisión." }, { status: 500 });
  }

  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  const profile = await authorizedProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, message: "No autorizado." }, { status: 401 });
  }

  const origin = request.headers.get("origin");
  if (!origin || origin !== request.nextUrl.origin) {
    return NextResponse.json({ ok: false, message: "Origen no autorizado." }, { status: 403 });
  }

  const parsed = recoverySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, message: "La solicitud de recuperación no es válida." }, { status: 400 });
  }

  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase.rpc("ensure_admin_portal_customer_profile_v1", {
    p_portal_user_id: parsed.data.portalUserId,
    p_request_key: parsed.data.requestKey,
    p_expected_state: parsed.data.expectedState,
    p_reason: parsed.data.reason,
  });

  if (error) {
    await writeErrorLog({
      route: "/api/admin/portal-customer-profile",
      module: "crm",
      category: "crm",
      action: "portal_customer_profile.admin_recovery_failed",
      errorMessage: error.message,
      userId: profile.id,
      metadata: {
        expected_state: parsed.data.expectedState,
        request_key_present: true,
        target_present: true,
      },
    });
    return NextResponse.json({ ok: false, message: "No se pudo ejecutar la recuperación controlada." }, { status: 500 });
  }

  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
