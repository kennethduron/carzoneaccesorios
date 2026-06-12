import type { NextRequest } from "next/server";
import { createEmailBackup, formatBytes } from "@/lib/backups/email";
import { logCronRun, verifyCronRequest } from "@/lib/cron";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function run(request: NextRequest) {
  const unauthorized = verifyCronRequest(request);
  if (unauthorized) return unauthorized;

  const startedAt = Date.now();

  try {
    const result = await createEmailBackup({
      triggeredBy: "cron",
      notes: "Backup programado por correo ejecutado por cron.",
      backupLogType: "scheduled",
    });
    const response = {
      ok: true,
      type: result.type,
      fileName: result.fileName,
      fileSize: result.fileSize,
      fileSizeLabel: formatBytes(result.fileSize),
      recipientEmail: result.recipientEmail,
      deliveryProvider: result.deliveryProvider,
      deliveryMessageIdPresent: Boolean(result.deliveryMessageId),
      tablesExported: result.tablesExported,
      tablesMissing: result.tablesMissing,
      totalRecords: result.totalRecords,
    };

    await logCronRun({
      jobName: "email-backup",
      status: "success",
      startedAt,
      result: response,
    });

    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo ejecutar la copia de seguridad por correo electrónico.";
    await logCronRun({
      jobName: "email-backup",
      status: "failed",
      startedAt,
      errorMessage: message,
    });

    return Response.json({ ok: false, message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
