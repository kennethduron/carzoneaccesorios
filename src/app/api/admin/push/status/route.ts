import { NextResponse } from "next/server";
import { getSessionProfile } from "@/lib/auth/session";
import { getFcmStatus } from "@/lib/notifications/fcm";

export const dynamic = "force-dynamic";

export async function GET() {
  const profile = await getSessionProfile();
  if (!profile) {
    return NextResponse.json({ ok: false, message: "No autorizado." }, { status: 401 });
  }

  return NextResponse.json({ ok: true, fcm: getFcmStatus() });
}
