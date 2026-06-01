import { NextResponse, type NextRequest } from "next/server";
import { logCronRun, verifyCronRequest } from "@/lib/cron";
import { deliverPendingReservationReviewEmails } from "@/lib/notifications/reservation-review-email";
import { getSupabaseAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

async function runLegacyCheck(request: NextRequest) {
  const unauthorized = verifyCronRequest(request);

  if (unauthorized) {
    return unauthorized;
  }

  const startedAt = Date.now();
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("check_expired_inventory_reservations", { max_orders: 100 });

  if (error) {
    await logCronRun({
      jobName: "check-expired-reservations-legacy-route",
      status: "failed",
      startedAt,
      errorMessage: error.message,
    });
    return NextResponse.json({ message: error.message }, { status: 500 });
  }

  await logCronRun({
    jobName: "check-expired-reservations-legacy-route",
    status: "success",
    startedAt,
    result: {
      reviewRequiredOrders: Number(data ?? 0),
    },
  });

  return NextResponse.json({
    ok: true,
    reviewRequiredOrders: Number(data ?? 0),
    email: await deliverPendingReservationReviewEmails(),
  });
}

export async function GET(request: NextRequest) {
  return runLegacyCheck(request);
}

export async function POST(request: NextRequest) {
  return runLegacyCheck(request);
}
