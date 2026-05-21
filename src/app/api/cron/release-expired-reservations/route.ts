import { NextResponse, type NextRequest } from "next/server";
import { logCronRun, verifyCronRequest } from "@/lib/cron";
import { getSupabaseAdminClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const unauthorized = verifyCronRequest(request);

  if (unauthorized) {
    return unauthorized;
  }

  const startedAt = Date.now();
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("expire_inventory_reservations", { max_orders: 100 });

  if (error) {
    await logCronRun({
      jobName: "release-expired-reservations",
      status: "failed",
      startedAt,
      errorMessage: error.message,
    });
    return NextResponse.json({ message: error.message }, { status: 500 });
  }

  await logCronRun({
    jobName: "release-expired-reservations",
    status: "success",
    startedAt,
    result: {
      expiredOrders: Number(data ?? 0),
    },
  });

  return NextResponse.json({
    ok: true,
    expiredOrders: Number(data ?? 0),
  });
}
