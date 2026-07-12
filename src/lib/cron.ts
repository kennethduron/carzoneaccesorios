import "server-only";

import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";

type CronRunStatus = "success" | "failed";

type CronRunInput = {
  jobName: string;
  status: CronRunStatus;
  startedAt: number;
  result?: Record<string, unknown>;
  errorMessage?: string | null;
};

type CronJobHandler = () => Promise<Record<string, unknown>>;

export function verifyCronRequest(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authorization = request.headers.get("authorization");

  if (!cronSecret || authorization !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ message: "No autorizado." }, { status: 401 });
  }

  return null;
}

export async function logCronRun(input: CronRunInput) {
  const admin = getSupabaseAdminClient();
  const finishedAt = Date.now();
  const { error } = await admin.from("operational_cron_runs").insert({
    job_name: input.jobName,
    status: input.status,
    started_at: new Date(input.startedAt).toISOString(),
    finished_at: new Date(finishedAt).toISOString(),
    duration_ms: finishedAt - input.startedAt,
    result: input.result ?? {},
    error_message: input.errorMessage ?? null,
  });

  if (error) {
    console.error("Cron log failed", { jobName: input.jobName, message: error.message });
  }
}

export async function runProtectedCronJob(request: NextRequest, jobName: string, handler: CronJobHandler) {
  const unauthorized = verifyCronRequest(request);
  if (unauthorized) return unauthorized;

  const startedAt = Date.now();

  try {
    const result = await handler();
    await logCronRun({ jobName, status: "success", startedAt, result });
    return NextResponse.json({ ok: true, jobName, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo ejecutar el cron.";
    await logCronRun({ jobName, status: "failed", startedAt, errorMessage: message });
    return NextResponse.json({ ok: false, jobName, message }, { status: 500 });
  }
}
