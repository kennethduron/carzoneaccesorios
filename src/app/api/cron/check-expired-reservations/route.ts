import { NextResponse, type NextRequest } from "next/server";
import { logCronRun, verifyCronRequest } from "@/lib/cron";
import { deliverPendingReservationReviewEmails } from "@/lib/notifications/reservation-review-email";
import { getSupabaseAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

async function runCheck(request: NextRequest) {
  const unauthorized = verifyCronRequest(request);
  if (unauthorized) return unauthorized;

  const startedAt = Date.now();

  try {
    const admin = getSupabaseAdminClient();
    const { data, error } = await admin.rpc("check_expired_inventory_reservations", { max_orders: 100 });
    if (error) throw new Error(error.message);

    const email = await deliverPendingReservationReviewEmails();
    const result = { reviewRequiredOrders: Number(data ?? 0), email };

    await logCronRun({ jobName: "check-expired-reservations", status: "success", startedAt, result });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudieron revisar reservas vencidas.";
    await logCronRun({ jobName: "check-expired-reservations", status: "failed", startedAt, errorMessage: message });
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return runCheck(request);
}

export async function POST(request: NextRequest) {
  return runCheck(request);
}
