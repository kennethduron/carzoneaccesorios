import type { NextRequest } from "next/server";
import { createGoogleDriveBackup, formatBytes } from "@/lib/backups/google-drive";
import { logCronRun, verifyCronRequest } from "@/lib/cron";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function backupKindFromRequest(request: NextRequest) {
  const type = request.nextUrl.searchParams.get("type");

  if (type === "weekly" || type === "monthly" || type === "daily") {
    return type;
  }

  return "daily";
}

function backupScopeFromRequest(request: NextRequest) {
  const scope = request.nextUrl.searchParams.get("scope");
  return scope === "full" ? "full" : undefined;
}

async function run(request: NextRequest) {
  const unauthorized = verifyCronRequest(request);
  if (unauthorized) return unauthorized;

  const startedAt = Date.now();
  const kind = backupKindFromRequest(request);
  const scope = backupScopeFromRequest(request);

  try {
    const result = await createGoogleDriveBackup({
      kind,
      scope,
      triggeredBy: "cron",
      backupLogType: "scheduled",
      notes: `Backup ${kind} ejecutado por cron.`,
    });
    const response = {
      ok: true,
      type: result.type,
      scope: result.scope,
      fileName: result.fileName,
      fileSize: result.fileSize,
      fileSizeLabel: formatBytes(result.fileSize),
      googleDriveFileId: result.googleDriveFileId,
      folderName: result.folderName,
      tablesExported: result.tablesExported,
      tablesMissing: result.tablesMissing,
      retentionDeleted: result.retentionDeleted,
    };

    await logCronRun({
      jobName: "google-drive-backup",
      status: "success",
      startedAt,
      result: response,
    });

    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo ejecutar el backup.";
    await logCronRun({
      jobName: "google-drive-backup",
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
