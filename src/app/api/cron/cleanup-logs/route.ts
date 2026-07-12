import { NextResponse, type NextRequest } from "next/server";
import { logCronRun, verifyCronRequest } from "@/lib/cron";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

type CleanupRow = {
  table_name: string;
  deleted_count: number;
};

export async function POST(request: NextRequest) {
  const unauthorized = verifyCronRequest(request);

  if (unauthorized) {
    return unauthorized;
  }

  const startedAt = Date.now();
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .rpc("cleanup_old_operational_logs", { retention_days: 90 })
    .returns<CleanupRow[]>();

  if (error) {
    await logCronRun({
      jobName: "cleanup-logs",
      status: "failed",
      startedAt,
      errorMessage: error.message,
    });
    return NextResponse.json({ message: error.message }, { status: 500 });
  }

  const rows = Array.isArray(data) ? data : [];
  const deleted = rows.reduce<Record<string, number>>((summary, row: CleanupRow) => {
    summary[row.table_name] = Number(row.deleted_count ?? 0);
    return summary;
  }, {});

  await logCronRun({
    jobName: "cleanup-logs",
    status: "success",
    startedAt,
    result: { deleted },
  });

  return NextResponse.json({
    ok: true,
    deleted,
  });
}
