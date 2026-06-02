import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { registerFcmDeviceToken } from "@/lib/notifications/fcm";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, message: "No autorizado." }, { status: 401 });
  }

  const payload = (await request.json().catch(() => null)) as { token?: string; platform?: "web" | "android" | "ios" | "unknown" } | null;
  if (!payload?.token) {
    return NextResponse.json({ ok: false, message: "Token requerido." }, { status: 400 });
  }

  const headerStore = await headers();
  const result = await registerFcmDeviceToken({
    userId: profile.id,
    token: payload.token,
    platform: payload.platform ?? "web",
    userAgent: headerStore.get("user-agent")?.slice(0, 500) ?? null,
  });

  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
