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
  const { data, error } = await admin.rpc("cleanup_old_rate_limits", { retention_hours: 24 });

  if (error) {
    await logCronRun({
      jobName: "cleanup-rate-limits",
      status: "failed",
      startedAt,
      errorMessage: error.message,
    });
    return NextResponse.json({ message: error.message }, { status: 500 });
  }

  await logCronRun({
    jobName: "cleanup-rate-limits",
    status: "success",
    startedAt,
    result: {
      deletedRateLimits: Number(data ?? 0),
    },
  });

  return NextResponse.json({
    ok: true,
    deletedRateLimits: Number(data ?? 0),
  });
}
