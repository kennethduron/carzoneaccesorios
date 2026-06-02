import type { NextRequest } from "next/server";
import { runProtectedCronJob } from "@/lib/cron";
import { checkLowStockJob } from "@/lib/notifications/cron-jobs";

export const dynamic = "force-dynamic";

function run(request: NextRequest) {
  return runProtectedCronJob(request, "check-low-stock", checkLowStockJob);
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
