import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { getFcmStatus } from "@/lib/notifications/fcm";
import { getSupabaseAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const pushRoles = new Set(["technical_owner", "business_owner", "admin", "contadora", "bodega", "vendedor"]);
const summaryRoles = new Set(["technical_owner", "business_owner", "admin"]);

export async function GET() {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, message: "No autorizado." }, { status: 401 });
  }

  const admin = getSupabaseAdminClient();
  const canViewSummary = summaryRoles.has(profile.role);
  const [currentTokens, currentTokenCount, totalTokenCount] = await Promise.all([
    admin
      .from("fcm_device_tokens")
      .select("id, last_seen_at, updated_at")
      .eq("user_id", profile.id)
      .eq("enabled", true)
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .returns<Array<{ id: string; last_seen_at: string | null; updated_at: string | null }>>(),
    admin.from("fcm_device_tokens").select("id", { count: "exact", head: true }).eq("user_id", profile.id).eq("enabled", true),
    canViewSummary
      ? admin.from("fcm_device_tokens").select("id", { count: "exact", head: true }).eq("enabled", true)
      : Promise.resolve({ count: null, error: null }),
  ]);

  const lastToken = currentTokens.data?.[0] ?? null;

  return NextResponse.json({
    ok: true,
    fcm: getFcmStatus(),
    canUsePush: pushRoles.has(profile.role),
    canViewSummary,
    device: {
      registered: (currentTokenCount.count ?? 0) > 0,
      tokenCount: currentTokenCount.count ?? 0,
      lastSyncAt: lastToken?.last_seen_at ?? lastToken?.updated_at ?? null,
      error: currentTokens.error?.message ?? currentTokenCount.error?.message ?? null,
    },
    summary: canViewSummary
      ? {
          registeredTokens: totalTokenCount.count ?? 0,
          error: totalTokenCount.error?.message ?? null,
        }
      : null,
  });
}
