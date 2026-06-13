import type { NextRequest } from "next/server";
import { runProtectedCronJob } from "@/lib/cron";
import { checkCommercialCreditRemindersJob } from "@/lib/notifications/cron-jobs";

export const dynamic = "force-dynamic";

async function runCheck(request: NextRequest) {
  return runProtectedCronJob(request, "check-commercial-credit", checkCommercialCreditRemindersJob);
}

export async function GET(request: NextRequest) {
  return runCheck(request);
}

export async function POST(request: NextRequest) {
  return runCheck(request);
}
