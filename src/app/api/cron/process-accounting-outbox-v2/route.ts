import type { NextRequest } from "next/server";
import { runProtectedCronJob } from "@/lib/cron";
import { processAccountingOutboxV2Job } from "@/lib/accounting/cron-jobs";

export const dynamic = "force-dynamic";

function run(request: NextRequest) {
  return runProtectedCronJob(
    request,
    "process-accounting-outbox-v2",
    processAccountingOutboxV2Job,
  );
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
