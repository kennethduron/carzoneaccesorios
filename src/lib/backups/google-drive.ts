import "server-only";

import { createSign } from "node:crypto";
import JSZip from "jszip";
import { getSupabaseAdminClient } from "@/lib/supabase";
import type { AuthProfile } from "@/types/auth";
import type { BackupType } from "@/types/security";

type BackupKind = "manual" | "daily" | "weekly" | "monthly";
type BackupScope = "light" | "full";
type BackupTrigger = "manual" | "cron" | "system";
type JsonRecord = Record<string, unknown>;

type BackupTable = {
  name: string;
  important?: boolean;
  limit?: number;
  orderBy?: string;
};

type ExportedTable = {
  rows: JsonRecord[];
  rowCount: number;
  truncated: boolean;
};

type BackupRunInput = {
  kind: BackupKind;
  scope?: BackupScope;
  triggeredBy: BackupTrigger;
  createdBy?: Pick<AuthProfile, "id" | "email" | "role"> | null;
  notes?: string | null;
  backupLogType?: BackupType;
};

export type GoogleDriveBackupResult = {
  ok: true;
  type: BackupKind;
  scope: BackupScope;
  fileName: string;
  fileSize: number;
  googleDriveFileId: string;
  googleDriveFolderId: string;
  folderName: string;
  tablesExported: string[];
  tablesMissing: string[];
  redactedFields: string[];
  retentionDeleted: number;
  startedAt: string;
  finishedAt: string;
};

type DriveTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

type DriveFileResponse = {
  id?: string;
  name?: string;
  size?: string;
};

type DriveErrorPayload = {
  error?: {
    message?: string;
  };
};

const pageSize = 1000;
const defaultMaxBytes = 45 * 1024 * 1024;
const driveFolderMimeType = "application/vnd.google-apps.folder";
const backupFilePrefix = "car-zone-backup";

const lightTables: BackupTable[] = [
  { name: "products" },
  { name: "product_images" },
  { name: "categories" },
  { name: "inventory_movements", important: true, limit: 1000, orderBy: "created_at" },
  { name: "inventory_reservations" },
  { name: "orders" },
  { name: "order_items" },
  { name: "payments" },
  { name: "invoices" },
  { name: "invoice_items" },
  { name: "customers" },
  { name: "users" },
  { name: "fiscal_settings" },
  { name: "company_settings" },
  { name: "business_settings" },
];

const fullTables: BackupTable[] = [
  ...lightTables,
  { name: "wholesale_codes" },
  { name: "crm_notes" },
  { name: "crm_followups" },
  { name: "holiday_banners" },
  { name: "notification_logs", important: true, limit: 1000, orderBy: "created_at" },
  { name: "audit_logs", important: true, limit: 5000, orderBy: "created_at" },
];

const retentionByKind: Partial<Record<BackupKind, number>> = {
  daily: 7,
  weekly: 4,
  monthly: 6,
};

const sensitiveFieldPattern =
  /(^|_)(password|passcode|token|secret|authorization|credential|private_key|api_key|service_role|refresh_token|access_token|cron_secret|cvv|card_number|tarjeta_numero)(_|$)/i;

function base64Url(input: string | Buffer) {
  return Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function normalizePrivateKey(value: string) {
  return value.replace(/^"|"$/g, "").replace(/\\n/g, "\n");
}

function driveConfig() {
  const clientEmail = process.env.GOOGLE_DRIVE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_DRIVE_PRIVATE_KEY;
  const rootFolderId = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID;

  if (!clientEmail || !privateKey || !rootFolderId) {
    throw new Error("Google Drive backup no esta configurado en variables de entorno.");
  }

  return {
    clientEmail,
    privateKey: normalizePrivateKey(privateKey),
    rootFolderId,
  };
}

async function getDriveAccessToken() {
  const config = driveConfig();
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iss: config.clientEmail,
      scope: "https://www.googleapis.com/auth/drive.file",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const unsignedJwt = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedJwt);
  signer.end();
  const signature = signer.sign(config.privateKey);
  const assertion = `${unsignedJwt}.${base64Url(signature)}`;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  const data = (await response.json()) as DriveTokenResponse;

  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "No se pudo autenticar con Google Drive.");
  }

  return { token: data.access_token, rootFolderId: config.rootFolderId };
}

async function driveFetch<T>(token: string, path: string, init: RequestInit = {}) {
  const response = await fetch(`https://www.googleapis.com/drive/v3${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const data: T & DriveErrorPayload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(data.error?.message || "Google Drive no pudo completar la operacion.");
  }

  return data as T;
}

async function driveUpload<T>(token: string, body: Buffer, contentType: string) {
  const response = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": contentType,
      },
      body: new Blob([new Uint8Array(body)]),
    },
  );
  const data = (await response.json()) as T & { error?: { message?: string } };

  if (!response.ok) {
    throw new Error(data.error?.message || "No se pudo subir el backup a Google Drive.");
  }

  return data as T;
}

function driveQueryValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function ensureDriveFolder(token: string, parentId: string, name: string) {
  const query = [
    `'${driveQueryValue(parentId)}' in parents`,
    `name = '${driveQueryValue(name)}'`,
    `mimeType = '${driveFolderMimeType}'`,
    "trashed = false",
  ].join(" and ");
  const existing = await driveFetch<{ files?: Array<{ id: string; name: string }> }>(
    token,
    `/files?q=${encodeURIComponent(query)}&fields=files(id,name)&pageSize=1`,
  );
  const folder = existing.files?.[0];

  if (folder?.id) {
    return folder.id;
  }

  const created = await driveFetch<{ id: string }>(token, "/files?fields=id", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: driveFolderMimeType,
      parents: [parentId],
    }),
  });

  return created.id;
}

async function ensureBackupFolders(token: string, rootFolderId: string, kind: BackupKind) {
  const folderNames: BackupKind[] = ["daily", "weekly", "monthly", "manual"];
  const folderIds = new Map<BackupKind, string>();

  for (const folderName of folderNames) {
    folderIds.set(folderName, await ensureDriveFolder(token, rootFolderId, folderName));
  }

  return {
    folderName: kind,
    folderId: folderIds.get(kind) ?? rootFolderId,
  };
}

function sanitizeValue(value: unknown, redacted: Set<string>, path = ""): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizeValue(entry, redacted, `${path}[${index}]`));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as JsonRecord).map(([key, entry]) => {
        const nextPath = path ? `${path}.${key}` : key;
        if (sensitiveFieldPattern.test(key)) {
          redacted.add(nextPath);
          return [key, "[redacted]"];
        }

        return [key, sanitizeValue(entry, redacted, nextPath)];
      }),
    );
  }

  return value;
}

function rowsToCsv(rows: JsonRecord[]) {
  if (rows.length === 0) {
    return "";
  }

  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const escapeCell = (value: unknown) => {
    const text = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
    return `"${text.replace(/"/g, '""')}"`;
  };

  return [headers.join(","), ...rows.map((row) => headers.map((header) => escapeCell(row[header])).join(","))].join("\n");
}

function hnTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}-${value.hour}-${value.minute}`;
}

async function exportTable(table: BackupTable, redacted: Set<string>): Promise<ExportedTable | null> {
  const admin = getSupabaseAdminClient();
  const rows: JsonRecord[] = [];

  if (table.limit && table.orderBy) {
    const { data, error } = await admin
      .from(table.name)
      .select("*")
      .order(table.orderBy, { ascending: false })
      .limit(table.limit)
      .returns<JsonRecord[]>();

    if (error) {
      if (error.code === "42P01" || error.message.toLowerCase().includes("does not exist")) {
        return null;
      }

      throw new Error(`No se pudo exportar ${table.name}.`);
    }

    return {
      rows: (data ?? []).map((row) => sanitizeValue(row, redacted, table.name) as JsonRecord),
      rowCount: data?.length ?? 0,
      truncated: (data?.length ?? 0) >= table.limit,
    };
  }

  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await admin
      .from(table.name)
      .select("*")
      .range(offset, offset + pageSize - 1)
      .returns<JsonRecord[]>();

    if (error) {
      if (error.code === "42P01" || error.message.toLowerCase().includes("does not exist")) {
        return null;
      }

      throw new Error(`No se pudo exportar ${table.name}.`);
    }

    const page = data ?? [];
    rows.push(...page.map((row) => sanitizeValue(row, redacted, table.name) as JsonRecord));

    if (page.length < pageSize) {
      break;
    }
  }

  return { rows, rowCount: rows.length, truncated: false };
}

async function buildBackupArchive(input: BackupRunInput) {
  const scope: BackupScope = input.scope ?? (input.kind === "daily" ? "light" : "full");
  const tables = scope === "light" ? lightTables : fullTables;
  const redacted = new Set<string>();
  const exported: Record<string, ExportedTable> = {};
  const missingTables: string[] = [];

  for (const table of tables) {
    const result = await exportTable(table, redacted);
    if (!result) {
      missingTables.push(table.name);
      continue;
    }

    exported[table.name] = result;
  }

  const generatedAt = new Date().toISOString();
  const fileName = `${backupFilePrefix}-${input.kind}-${hnTimestamp()}.zip`;
  const payload = {
    metadata: {
      app: "Car Zone Accesorios",
      version: 1,
      generated_at: generatedAt,
      type: input.kind,
      scope,
      triggered_by: input.triggeredBy,
      created_by_user_id: input.createdBy?.id ?? null,
      tables_exported: Object.keys(exported),
      tables_missing: missingTables,
      redacted_field_count: redacted.size,
      notes: input.notes ?? null,
    },
    tables: exported,
  };
  const zip = new JSZip();
  zip.file("backup.json", JSON.stringify(payload, null, 2));
  zip.file(
    "summary.csv",
    rowsToCsv(
      Object.entries(exported).map(([name, table]) => ({
        table: name,
        rows: table.rowCount,
        truncated: table.truncated,
      })),
    ),
  );

  const csvFolder = zip.folder("csv");
  for (const [name, table] of Object.entries(exported)) {
    csvFolder?.file(`${name}.csv`, rowsToCsv(table.rows));
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  const maxBytes = Number(process.env.GOOGLE_DRIVE_BACKUP_MAX_BYTES ?? defaultMaxBytes);

  if (buffer.length <= 0) {
    throw new Error("El backup generado esta vacio.");
  }

  if (buffer.length > maxBytes) {
    throw new Error("El backup generado supera el tamano maximo configurado.");
  }

  return {
    buffer,
    fileName,
    scope,
    tablesExported: Object.keys(exported),
    tablesMissing: missingTables,
    redactedFields: Array.from(redacted).sort(),
  };
}

function multipartUploadBody(fileName: string, folderId: string, buffer: Buffer) {
  const boundary = `car-zone-backup-${Date.now()}`;
  const metadata = JSON.stringify({
    name: fileName,
    parents: [folderId],
    mimeType: "application/zip",
  });
  const start = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/zip\r\n\r\n`,
  );
  const end = Buffer.from(`\r\n--${boundary}--`);

  return {
    contentType: `multipart/related; boundary=${boundary}`,
    body: Buffer.concat([start, buffer, end]),
  };
}

async function uploadBackupToDrive(token: string, fileName: string, folderId: string, buffer: Buffer) {
  const uploadBody = multipartUploadBody(fileName, folderId, buffer);
  const uploaded = await driveUpload<DriveFileResponse>(token, uploadBody.body, uploadBody.contentType);

  if (!uploaded.id) {
    throw new Error("Google Drive no devolvio el ID del archivo de backup.");
  }

  return { fileId: uploaded.id };
}

async function applyRetention(token: string, folderId: string, kind: BackupKind) {
  const keep = retentionByKind[kind];
  if (!keep) {
    return 0;
  }

  const query = [
    `'${driveQueryValue(folderId)}' in parents`,
    `name contains '${backupFilePrefix}-${kind}-'`,
    "trashed = false",
  ].join(" and ");
  const listed = await driveFetch<{ files?: Array<{ id: string; name: string; createdTime: string }> }>(
    token,
    `/files?q=${encodeURIComponent(query)}&fields=files(id,name,createdTime)&pageSize=100&orderBy=createdTime desc`,
  );
  const files = listed.files ?? [];
  const staleFiles = files.slice(keep);

  for (const file of staleFiles) {
    await driveFetch(token, `/files/${encodeURIComponent(file.id)}`, { method: "DELETE" });
  }

  return staleFiles.length;
}

async function insertBackupRun(input: BackupRunInput, startedAt: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("backup_runs")
    .insert({
      started_at: startedAt,
      status: "running",
      type: input.kind,
      triggered_by: input.triggeredBy,
      created_by_user_id: input.createdBy?.id ?? null,
      metadata: {
        actor_email: input.createdBy?.email ?? null,
        actor_role: input.createdBy?.role ?? null,
        notes: input.notes ?? null,
      },
    })
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    if (error.code === "42P01" || error.message.toLowerCase().includes("backup_runs")) {
      return null;
    }

    throw new Error("No se pudo registrar el inicio del backup.");
  }

  return data?.id ?? null;
}

async function updateBackupRun(id: string | null, values: JsonRecord) {
  if (!id) {
    return;
  }

  const admin = getSupabaseAdminClient();
  await admin
    .from("backup_runs")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("id", id);
}

async function insertBackupLog(input: BackupRunInput, result: GoogleDriveBackupResult | null, errorMessage?: string) {
  const admin = getSupabaseAdminClient();
  await admin.from("backup_logs").insert({
    requested_by: input.createdBy?.id ?? null,
    backup_type: input.backupLogType ?? (input.triggeredBy === "cron" ? "scheduled" : "manual"),
    status: result ? "completed" : "failed",
    storage_location: result ? `google-drive:${result.googleDriveFileId}` : null,
    notes: result
      ? `Google Drive ${result.fileName} (${formatBytes(result.fileSize)}). ${input.notes ?? ""}`.trim()
      : `Google Drive backup fallido. ${errorMessage ?? ""}`.trim(),
    started_at: result?.startedAt ?? new Date().toISOString(),
    completed_at: result?.finishedAt ?? new Date().toISOString(),
  });
}

async function writeBackupAudit(input: BackupRunInput, result: GoogleDriveBackupResult | null, errorMessage?: string) {
  const admin = getSupabaseAdminClient();
  await admin.from("audit_logs").insert({
    user_id: input.createdBy?.id ?? null,
    actor_role: input.createdBy?.role ?? null,
    table_name: "backup_runs",
    record_id: null,
    action: result ? "backup.google_drive.completed" : "backup.google_drive.failed",
    new_data: result
      ? {
          type: result.type,
          scope: result.scope,
          file_name: result.fileName,
          file_size: result.fileSize,
          tables_exported: result.tablesExported,
          tables_missing: result.tablesMissing,
          retention_deleted: result.retentionDeleted,
        }
      : {
          type: input.kind,
          error: errorMessage ?? "unknown",
        },
  });
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export async function createGoogleDriveBackup(input: BackupRunInput): Promise<GoogleDriveBackupResult> {
  const startedAt = new Date().toISOString();
  const runId = await insertBackupRun(input, startedAt);

  try {
    const { token, rootFolderId } = await getDriveAccessToken();
    const { folderId, folderName } = await ensureBackupFolders(token, rootFolderId, input.kind);
    const archive = await buildBackupArchive(input);
    const { fileId } = await uploadBackupToDrive(token, archive.fileName, folderId, archive.buffer);
    const retentionDeleted = await applyRetention(token, folderId, input.kind);
    const finishedAt = new Date().toISOString();
    const result: GoogleDriveBackupResult = {
      ok: true,
      type: input.kind,
      scope: archive.scope,
      fileName: archive.fileName,
      fileSize: archive.buffer.length,
      googleDriveFileId: fileId,
      googleDriveFolderId: folderId,
      folderName,
      tablesExported: archive.tablesExported,
      tablesMissing: archive.tablesMissing,
      redactedFields: archive.redactedFields,
      retentionDeleted,
      startedAt,
      finishedAt,
    };

    await updateBackupRun(runId, {
      finished_at: finishedAt,
      status: "completed",
      file_name: result.fileName,
      file_size: result.fileSize,
      google_drive_file_id: result.googleDriveFileId,
      google_drive_folder_id: result.googleDriveFolderId,
      tables_exported: result.tablesExported,
      tables_missing: result.tablesMissing,
      retention_deleted: retentionDeleted,
      metadata: {
        scope: result.scope,
        folder_name: result.folderName,
        redacted_field_count: result.redactedFields.length,
      },
    });
    await insertBackupLog(input, result);
    await writeBackupAudit(input, result);

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo generar el backup.";
    const finishedAt = new Date().toISOString();
    await updateBackupRun(runId, {
      finished_at: finishedAt,
      status: "failed",
      error_message: message,
    });
    await insertBackupLog(input, null, message);
    await writeBackupAudit(input, null, message);
    throw new Error(message);
  }
}
