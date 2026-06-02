import type { NextRequest } from "next/server";
import { runProtectedCronJob } from "@/lib/cron";
import { checkExpiredReservationsJob } from "@/lib/notifications/cron-jobs";

export const dynamic = "force-dynamic";

async function runLegacyCheck(request: NextRequest) {
  return runProtectedCronJob(request, "check-expired-reservations-legacy-route", checkExpiredReservationsJob);
}

export async function GET(request: NextRequest) {
  return runLegacyCheck(request);
}

export async function POST(request: NextRequest) {
  return runLegacyCheck(request);
}
