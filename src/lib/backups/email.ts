import "server-only";

import JSZip from "jszip";
import { sendTransactionalEmail } from "@/lib/email/email-provider";
import { getSupabaseAdminClient } from "@/lib/supabase";
import type { AuthProfile } from "@/types/auth";
import type { BackupType } from "@/types/security";

type BackupTrigger = "manual" | "cron" | "system";
type JsonRecord = Record<string, unknown>;

type BackupTable = {
  name: string;
  limit?: number;
  orderBy?: string;
};

type ExportedTable = {
  rows: JsonRecord[];
  rowCount: number;
  truncated: boolean;
};

type EmailBackupInput = {
  triggeredBy: BackupTrigger;
  createdBy?: Pick<AuthProfile, "id" | "email" | "role"> | null;
  notes?: string | null;
  backupLogType?: BackupType;
  purpose?: BackupType;
};

export type EmailBackupResult = {
  ok: true;
  type: "manual_email" | "scheduled_email";
  fileName: string;
  fileSize: number;
  recipientEmail: string;
  deliveryProvider: string;
  deliveryMessageId: string | null;
  tablesExported: string[];
  tablesMissing: string[];
  redactedFields: string[];
  totalRecords: number;
  startedAt: string;
  finishedAt: string;
};

const pageSize = 1000;
const defaultMaxBytes = 15_000_000;
const recipientEmail = "carzonetech0@gmail.com";
const appName = "Car Zone Accesorios";

const backupTables: BackupTable[] = [
  { name: "products" },
  { name: "product_images" },
  { name: "categories" },
  { name: "inventory_movements" },
  { name: "inventory_reservations" },
  { name: "orders" },
  { name: "order_items" },
  { name: "payments" },
  { name: "invoices" },
  { name: "invoice_items" },
  { name: "customers" },
  { name: "users" },
  { name: "wholesale_codes" },
  { name: "crm_notes" },
  { name: "crm_followups" },
  { name: "holiday_banners" },
  { name: "fiscal_settings" },
  { name: "business_settings" },
  { name: "company_settings" },
  { name: "audit_logs", limit: 5000, orderBy: "created_at" },
  { name: "notification_logs", limit: 1000, orderBy: "created_at" },
];

const sensitiveFieldPattern =
  /(^|_)(password|passcode|token|secret|authorization|credential|private_key|api_key|service_role|refresh_token|access_token|cron_secret|cvv|card_number|card|tarjeta|cookie|session|bank_reference|bank_account|account_number|routing_number|iban|swift|transfer_receipt)(_|$)/i;

function hnParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  return Object.fromEntries(parts.map((part) => [part.type, part.value])) as Record<string, string>;
}

function fileTimestamp(date = new Date()) {
  const value = hnParts(date);
  return `${value.year}-${value.month}-${value.day}-${value.hour}-${value.minute}`;
}

function emailTimestamp(date = new Date()) {
  const value = hnParts(date);
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}`;
}

function getSiteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "https://carzoneaccesorios.com";
}

function getCommit() {
  return process.env.VERCEL_GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || null;
}

function getMaxBytes() {
  const value = Number(process.env.EMAIL_BACKUP_MAX_BYTES ?? defaultMaxBytes);
  return Number.isFinite(value) && value > 0 ? value : defaultMaxBytes;
}

function exportErrorMessage(tableName: string, error: { code?: string; message?: string; hint?: string }) {
  const detail = [error.message, error.code ? `code ${error.code}` : null, error.hint ? `hint: ${error.hint}` : null]
    .filter(Boolean)
    .join("; ");
  return detail ? `No se pudo exportar ${tableName}: ${detail}.` : `No se pudo exportar ${tableName}.`;
}

function isMissingRelationError(error: { code?: string; message?: string }) {
  const message = String(error.message ?? "").toLowerCase();
  return (
    error.code === "42P01" ||
    message.includes("does not exist") ||
    message.includes("could not find the table") ||
    message.includes("schema cache")
  );
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

async function exportTable(table: BackupTable, redacted: Set<string>): Promise<ExportedTable | null> {
  const admin = getSupabaseAdminClient();

  if (table.limit && table.orderBy) {
    const { data, error } = await admin
      .from(table.name)
      .select("*")
      .order(table.orderBy, { ascending: false })
      .limit(table.limit)
      .returns<JsonRecord[]>();

    if (error) {
      if (isMissingRelationError(error)) {
        return null;
      }

      throw new Error(exportErrorMessage(table.name, error));
    }

    const rows = (data ?? []).map((row) => sanitizeValue(row, redacted, table.name) as JsonRecord);
    return {
      rows,
      rowCount: rows.length,
      truncated: rows.length >= table.limit,
    };
  }

  const rows: JsonRecord[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await admin
      .from(table.name)
      .select("*")
      .range(offset, offset + pageSize - 1)
      .returns<JsonRecord[]>();

    if (error) {
      if (isMissingRelationError(error)) {
        return null;
      }

      throw new Error(exportErrorMessage(table.name, error));
    }

    const page = data ?? [];
    rows.push(...page.map((row) => sanitizeValue(row, redacted, table.name) as JsonRecord));

    if (page.length < pageSize) {
      break;
    }
  }

  return { rows, rowCount: rows.length, truncated: false };
}

function buildMetadata(input: {
  generatedAt: string;
  runType: "manual_email" | "scheduled_email";
  trigger: BackupTrigger;
  createdBy?: Pick<AuthProfile, "id" | "email" | "role"> | null;
  notes?: string | null;
  exported: Record<string, ExportedTable>;
  missingTables: string[];
  redactedFields: string[];
  archiveSizeBytes: number;
  purpose?: BackupType;
}) {
  const counts = Object.fromEntries(Object.entries(input.exported).map(([name, table]) => [name, table.rowCount]));
  const truncatedTables = Object.entries(input.exported)
    .filter(([, table]) => table.truncated)
    .map(([name]) => name);

  return {
    app: appName,
    format_version: 1,
    created_at: input.generatedAt,
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
    system_url: getSiteUrl(),
    backup_type: input.runType,
    backup_purpose: input.purpose ?? (input.runType === "scheduled_email" ? "scheduled" : "manual"),
    triggered_by: input.trigger,
    created_by_user_id: input.createdBy?.id ?? null,
    created_by_email: input.createdBy?.email ?? null,
    created_by_role: input.createdBy?.role ?? null,
    file_name_pattern: "car-zone-backup-YYYY-MM-DD-HH-mm.zip",
    tables_included: Object.keys(input.exported),
    tables_omitted: input.missingTables,
    counts_by_table: counts,
    total_records: Object.values(counts).reduce((total, count) => total + Number(count), 0),
    archive_size_bytes: input.archiveSizeBytes,
    commit: getCommit(),
    notes: input.notes ?? null,
    dependencies: {
      ids_preserved: true,
      timestamps_preserved: true,
      relationships_preserved_by_ids: true,
      recommended_restore_order: backupTables.map((table) => table.name),
    },
    truncation: {
      truncated_tables: truncatedTables,
      audit_logs_limit: 5000,
      notification_logs_limit: 1000,
    },
    security_note: "This backup contains operational business data only.",
    warning: "This backup does not include passwords, API keys, private keys, environment variables, sessions, cookies, card CVV or secrets.",
    redacted_field_count: input.redactedFields.length,
    redacted_fields: input.redactedFields,
  };
}

async function zipWithMetadata(exported: Record<string, ExportedTable>, metadata: Record<string, unknown>) {
  const zip = new JSZip();
  zip.file("metadata.json", JSON.stringify(metadata, null, 2));
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
  for (const table of backupTables) {
    const exportedTable = exported[table.name];
    if (!exportedTable) {
      continue;
    }

    zip.file(`${table.name}.json`, JSON.stringify(exportedTable.rows, null, 2));
    csvFolder?.file(`${table.name}.csv`, rowsToCsv(exportedTable.rows));
  }

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

async function buildBackupArchive(input: EmailBackupInput, runType: "manual_email" | "scheduled_email") {
  const redacted = new Set<string>();
  const exported: Record<string, ExportedTable> = {};
  const missingTables: string[] = [];

  for (const table of backupTables) {
    const result = await exportTable(table, redacted);
    if (!result) {
      missingTables.push(table.name);
      continue;
    }

    exported[table.name] = result;
  }

  const generatedAt = new Date().toISOString();
  const fileName = `car-zone-backup-${fileTimestamp()}.zip`;
  const redactedFields = Array.from(redacted).sort();
  let metadata = buildMetadata({
    generatedAt,
    runType,
    trigger: input.triggeredBy,
    createdBy: input.createdBy,
    notes: input.notes,
    exported,
    missingTables,
    redactedFields,
    archiveSizeBytes: 0,
    purpose: input.purpose,
  });
  let buffer = await zipWithMetadata(exported, metadata);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    metadata = buildMetadata({
      generatedAt,
      runType,
      trigger: input.triggeredBy,
      createdBy: input.createdBy,
      notes: input.notes,
      exported,
      missingTables,
      redactedFields,
      archiveSizeBytes: buffer.length,
      purpose: input.purpose,
    });
    const nextBuffer = await zipWithMetadata(exported, metadata);
    if (nextBuffer.length === buffer.length) {
      buffer = nextBuffer;
      break;
    }
    buffer = nextBuffer;
  }

  if (buffer.length <= 0) {
    throw new Error("La copia de seguridad generada está vacía.");
  }

  return {
    buffer,
    fileName,
    metadata,
    tablesExported: Object.keys(exported),
    tablesMissing: missingTables,
    redactedFields,
    totalRecords: Number(metadata.total_records ?? 0),
  };
}

function htmlEscape(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function emailBody(input: {
  timestamp: string;
  environment: string;
  tablesExported: string[];
  totalRecords: number;
  fileSizeLabel: string;
}) {
  return `
    <div style="font-family:Arial,sans-serif;color:#111;line-height:1.6;">
      <p>Hola,</p>
      <p>Se adjunta la copia de seguridad de Car Zone Accesorios.</p>
      <p>
        <strong>Fecha:</strong> ${htmlEscape(input.timestamp)}<br />
        <strong>Entorno:</strong> ${htmlEscape(input.environment)}<br />
        <strong>Tablas incluidas:</strong> ${htmlEscape(input.tablesExported.join(", "))}<br />
        <strong>Total de registros:</strong> ${htmlEscape(input.totalRecords)}<br />
        <strong>Tamaño del archivo:</strong> ${htmlEscape(input.fileSizeLabel)}
      </p>
      <p>Esta copia de seguridad no contiene contraseñas, claves de API ni secretos.</p>
      <p>Para restaurarla, entrega este archivo al soporte técnico o a Codex/ChatGPT con acceso autorizado al proyecto.</p>
      <p>Atentamente,<br />Sistema Car Zone Accesorios</p>
    </div>
  `;
}

async function insertBackupRun(input: EmailBackupInput, startedAt: string, runType: "manual_email" | "scheduled_email") {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("backup_runs")
    .insert({
      started_at: startedAt,
      status: "running",
      type: runType,
      triggered_by: input.triggeredBy,
      created_by_user_id: input.createdBy?.id ?? null,
      recipient_email: recipientEmail,
      delivery_provider: "email",
      metadata: {
        delivery: "email",
        actor_email: input.createdBy?.email ?? null,
        actor_role: input.createdBy?.role ?? null,
        notes: input.notes ?? null,
        purpose: input.purpose ?? runType,
      },
    })
    .select("id")
    .maybeSingle<{ id: string }>();

  if (error) {
    if (error.code === "42P01" || error.message.toLowerCase().includes("backup_runs")) {
      return null;
    }

    throw new Error("No se pudo registrar el inicio de la copia de seguridad.");
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

async function insertBackupLog(input: EmailBackupInput, result: EmailBackupResult | null, errorMessage?: string) {
  const admin = getSupabaseAdminClient();
  await admin.from("backup_logs").insert({
    requested_by: input.createdBy?.id ?? null,
    backup_type: input.backupLogType ?? (input.triggeredBy === "cron" ? "scheduled" : "manual"),
    status: result ? "completed" : "failed",
    storage_location: result ? `email:${result.recipientEmail}` : null,
    notes: result
      ? `Email ${result.fileName} (${formatBytes(result.fileSize)}) enviado a ${result.recipientEmail}. ${input.notes ?? ""}`.trim()
      : `Backup por correo fallido. ${errorMessage ?? ""}`.trim(),
    started_at: result?.startedAt ?? new Date().toISOString(),
    completed_at: result?.finishedAt ?? new Date().toISOString(),
  });
}

async function writeBackupAudit(input: EmailBackupInput, result: EmailBackupResult | null, errorMessage?: string) {
  const admin = getSupabaseAdminClient();
  await admin.from("audit_logs").insert({
    user_id: input.createdBy?.id ?? null,
    actor_role: input.createdBy?.role ?? "system",
    table_name: "backup_runs",
    record_id: null,
    action: result ? "backup.email.completed" : "backup.email.failed",
    new_data: result
      ? {
          type: result.type,
          file_name: result.fileName,
          file_size: result.fileSize,
          recipient_email: result.recipientEmail,
          delivery_provider: result.deliveryProvider,
          delivery_message_id_present: Boolean(result.deliveryMessageId),
          tables_exported: result.tablesExported,
          tables_missing: result.tablesMissing,
        }
      : {
          type: input.triggeredBy === "cron" ? "scheduled_email" : "manual_email",
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

export async function createEmailBackup(input: EmailBackupInput): Promise<EmailBackupResult> {
  const startedAt = new Date().toISOString();
  const runType = input.triggeredBy === "cron" ? "scheduled_email" : "manual_email";
  const runId = await insertBackupRun(input, startedAt, runType);

  try {
    const archive = await buildBackupArchive(input, runType);
    const maxBytes = getMaxBytes();

    if (archive.buffer.length > maxBytes) {
      throw new Error("La copia de seguridad supera el tamaño permitido para el correo electrónico. Descárgala manualmente o configura un almacenamiento externo.");
    }

    const timestamp = emailTimestamp();
    const subject = `Backup Car Zone Accesorios - ${timestamp}`;
    const delivery = await sendTransactionalEmail({
      to: recipientEmail,
      subject,
      html: emailBody({
        timestamp,
        environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "unknown",
        tablesExported: archive.tablesExported,
        totalRecords: archive.totalRecords,
        fileSizeLabel: formatBytes(archive.buffer.length),
      }),
      attachments: [
        {
          filename: archive.fileName,
          content: archive.buffer.toString("base64"),
          contentType: "application/zip",
        },
      ],
      idempotencyKey: `backup-email:${startedAt}:${runType}:${input.purpose ?? runType}`,
      metadata: {
        backup_file_name: archive.fileName,
        backup_file_size: archive.buffer.length,
      },
    });

    if (!delivery.ok) {
      throw new Error(delivery.errorMessage ?? "No se pudo enviar la copia de seguridad por correo electrónico.");
    }

    const finishedAt = new Date().toISOString();
    const result: EmailBackupResult = {
      ok: true,
      type: runType,
      fileName: archive.fileName,
      fileSize: archive.buffer.length,
      recipientEmail,
      deliveryProvider: delivery.provider,
      deliveryMessageId: delivery.providerMessageId,
      tablesExported: archive.tablesExported,
      tablesMissing: archive.tablesMissing,
      redactedFields: archive.redactedFields,
      totalRecords: archive.totalRecords,
      startedAt,
      finishedAt,
    };

    await updateBackupRun(runId, {
      finished_at: finishedAt,
      status: "completed",
      file_name: result.fileName,
      file_size: result.fileSize,
      tables_exported: result.tablesExported,
      tables_missing: result.tablesMissing,
      recipient_email: result.recipientEmail,
      delivery_provider: result.deliveryProvider,
      delivery_message_id: result.deliveryMessageId,
      metadata: {
        delivery: "email",
        total_records: result.totalRecords,
        redacted_field_count: result.redactedFields.length,
        notes: input.notes ?? null,
        purpose: input.purpose ?? result.type,
      },
    });
    await insertBackupLog(input, result);
    await writeBackupAudit(input, result);

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo generar la copia de seguridad por correo electrónico.";
    const finishedAt = new Date().toISOString();
    await updateBackupRun(runId, {
      finished_at: finishedAt,
      status: "failed",
      error_message: message,
      recipient_email: recipientEmail,
      delivery_provider: "email",
    });
    await insertBackupLog(input, null, message);
    await writeBackupAudit(input, null, message);
    throw new Error(message);
  }
}

export async function buildEmailBackupArchiveForAudit(input: EmailBackupInput = { triggeredBy: "system" }) {
  return buildBackupArchive(input, input.triggeredBy === "cron" ? "scheduled_email" : "manual_email");
}
