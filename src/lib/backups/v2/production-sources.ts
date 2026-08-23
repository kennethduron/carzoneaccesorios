import "server-only";

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  AUTH_DURABLE_TABLES,
  createAuthSchemaSource,
  createCloudinaryOriginalsSource,
  createStorageMetadataSource,
  createStorageObjectsSource,
  openVerifiedCloudinaryOriginal,
  type AuthSchemaReader,
  type CloudinaryOriginalRecord,
  type CloudinaryResourceReader,
  type ExternalFetchPolicy,
  type PagedRecordResult,
  type StorageMetadataReader,
  type StorageObjectReader,
  type StorageObjectRecord,
} from "./component-sources.ts";
import type { ComponentSource } from "./component-payload.ts";
import type { PostgresConnection, PostgresToolRunner } from "./postgres-tool-runner.ts";
import { PostgresToolExecutionError } from "./postgres-failure-observability.ts";
import { BackupV2FailClosedError } from "./types.ts";
import {
  createRunnerPlainSqlExporter,
  type PlainSqlDatabaseExporter,
} from "../v2-simplified/plain-sql.ts";

const PAGE_SIZE = 50;
const MAX_MEASURE_BYTES = BigInt("5368709120");

export interface ProductionBackupSources {
  readonly database: PlainSqlDatabaseExporter;
  readonly auth: ComponentSource;
  readonly storageMetadata: ComponentSource;
  readonly storageObjects: ComponentSource;
  readonly externalAssets: ComponentSource;
  readonly mutationMethods: readonly [];
  measureCanonicalSource(): Promise<ProductionSourceMeasurements>;
  cleanup(): Promise<void>;
}

export interface ReadonlyProductionTransports {
  readonly auth: AuthSchemaReader;
  readonly storageMetadata: StorageMetadataReader;
  readonly storageObjects: StorageObjectReader;
  readonly cloudinary: CloudinaryResourceReader;
  readonly externalFetchPolicy: ExternalFetchPolicy;
}

export interface ProductionSourceConfig {
  readonly databaseUrl: string;
  readonly supabaseUrl: string;
  readonly supabaseServiceRoleKey: string;
  readonly cloudinaryCloudName: string;
  readonly cloudinaryApiKey: string;
  readonly cloudinaryApiSecret: string;
  readonly postgresRunner: PostgresToolRunner;
  readonly postgresContainerName?: string;
  readonly transports?: ReadonlyProductionTransports;
  readonly measurementProbe?: () => Promise<ProductionSourceMeasurements>;
}

export interface ProductionSourceMeasurements {
  readonly databaseBytes: bigint;
  readonly databaseObjects: bigint;
  readonly authBytes: bigint;
  readonly authObjects: bigint;
  readonly storageMetadataBytes: bigint;
  readonly storageMetadataObjects: bigint;
  readonly storageObjectBytes: bigint;
  readonly storageObjects: bigint;
  readonly externalAssetBytes: bigint;
  readonly externalAssets: bigint;
}

function fail(code: string, message: string): never { throw new BackupV2FailClosedError(code, message); }

function required(value: string, name: string): string {
  if (typeof value !== "string" || value.length < 1) fail("BACKUP_V2_PRODUCTION_SOURCE_CONFIG_ABSENT", `${name} is absent`);
  if (value.length > 8_192 || /[\u0000\r\n]/.test(value)) fail("BACKUP_V2_PRODUCTION_SOURCE_CONFIG_INVALID", `${name} is invalid`);
  return value;
}

export function parseProductionDatabaseUrl(value: string): PostgresConnection {
  required(value, "SUPABASE_DB_URL");
  let url: URL;
  try { url = new URL(value); } catch { fail("BACKUP_V2_PRODUCTION_SOURCE_CONFIG_INVALID", "SUPABASE_DB_URL is invalid"); }
  if (!new Set(["postgres:", "postgresql:"]).has(url.protocol) || !url.hostname || !url.username || !url.password ||
      url.pathname.length < 2 || url.searchParams.has("host") || url.hash) {
    fail("BACKUP_V2_PRODUCTION_SOURCE_CONFIG_INVALID", "SUPABASE_DB_URL must be a complete PostgreSQL URL");
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) fail("BACKUP_V2_PRODUCTION_SOURCE_CONFIG_INVALID", "SUPABASE_DB_URL port is invalid");
  return Object.freeze({ host: url.hostname, port, database: decodeURIComponent(url.pathname.slice(1)), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password) });
}

function cursorOffset(cursor: string | null): number {
  if (cursor === null) return 0;
  if (!/^(0|[1-9][0-9]{0,8})$/.test(cursor)) fail("BACKUP_V2_INVALID_PAGINATION_CURSOR", "Production source cursor is invalid");
  return Number(cursor);
}

interface DatabaseReaderBundle extends Pick<ReadonlyProductionTransports, "auth" | "storageMetadata"> {
  listStorageObjectsPage(cursor: string | null): Promise<PagedRecordResult<{ bucket: string; key: string; metadata: Record<string, unknown> }>>;
}

interface ProductionSnapshot {
  readonly id: string;
  close(): Promise<void>;
}

async function openProductionSnapshot(runner: PostgresToolRunner, connection: PostgresConnection, containerName?: string): Promise<ProductionSnapshot> {
  const controller = new AbortController();
  const session = runner.open({
    tool: "psql",
    operation: "PRODUCTION_DB_SNAPSHOT_BEGIN",
    args: ["--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1"],
    connection,
    containerName,
    signal: controller.signal,
  });
  await session.writeInput("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\nSELECT 'BACKUP_V2_SNAPSHOT_BEGIN_OK';\n");
  const id = await new Promise<string>((resolve, reject) => {
    let output = "";
    let began = false;
    const timeout = setTimeout(() => controller.abort(new DOMException("Snapshot probe timed out", "TimeoutError")), 15_000);
    session.stdout.setEncoding("utf8");
    session.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (!began && output.split(/\r?\n/).some((line) => line.trim() === "BACKUP_V2_SNAPSHOT_BEGIN_OK")) {
        began = true;
        session.setOperation("PRODUCTION_DB_SNAPSHOT_EXPORT");
        void session.writeInput("SELECT pg_export_snapshot();\n").catch((error) => {
          clearTimeout(timeout);
          reject(error);
        });
      }
      const candidate = output.split(/\r?\n/).map((line) => line.trim()).find((line) => /^[0-9A-Fa-f-]{8,128}$/.test(line));
      if (candidate) { clearTimeout(timeout); resolve(candidate); }
      else if (output.length > 4096) {
        clearTimeout(timeout); session.cancel(); reject(new PostgresToolExecutionError({
          failureOperation: "PRODUCTION_DB_SNAPSHOT_VALIDATION", failureTool: "psql", exitCode: 0,
          signalClass: "NONE", stderrClass: "UNKNOWN_SANITIZED", retryability: "HUMAN_REVIEW_REQUIRED",
        }, "BACKUP_V2_SOURCE_SNAPSHOT_FAILED"));
      }
    });
    session.completed.catch((error) => { clearTimeout(timeout); reject(error); });
  });
  let closed = false;
  return Object.freeze({
    id,
    async close() {
      if (closed) return;
      closed = true; session.setOperation("PRODUCTION_DB_SNAPSHOT_RELEASE"); session.cancel(); await session.completed.catch(() => undefined);
    },
  });
}

function createDatabaseReaders(runner: PostgresToolRunner, connection: PostgresConnection, snapshotId: string, containerName?: string): DatabaseReaderBundle {
  const query = async (sql: string): Promise<Record<string, unknown>[]> => {
    const output = await runner.capture({ tool: "psql", operation: "PRODUCTION_DB_READ_QUERY", args: ["--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", `--command=BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '${snapshotId}'; ${sql}; COMMIT`], connection, containerName });
    let parsed: unknown;
    try { parsed = JSON.parse(output.trim() || "[]"); } catch { fail("BACKUP_V2_PRODUCTION_SOURCE_RESPONSE_INVALID", "Read-only PostgreSQL source returned invalid JSON"); }
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "object" || item === null || Array.isArray(item))) fail("BACKUP_V2_PRODUCTION_SOURCE_RESPONSE_INVALID", "Read-only PostgreSQL source rows are invalid");
    return parsed as Record<string, unknown>[];
  };
  return Object.freeze({
    auth: Object.freeze({
      async listTablePage(table: (typeof AUTH_DURABLE_TABLES)[number], cursor: string | null) {
        if (!AUTH_DURABLE_TABLES.includes(table)) fail("BACKUP_V2_AUTH_TABLE_DENIED", "Auth table is outside the durable allowlist");
        const offset = cursorOffset(cursor);
        const rows = await query(`SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json)::text FROM (SELECT * FROM auth.${table} ORDER BY id LIMIT ${PAGE_SIZE} OFFSET ${offset}) q`);
        const complete = rows.length < PAGE_SIZE;
        return { records: rows, nextCursor: complete ? null : String(offset + rows.length), snapshotId, complete };
      },
    }),
    storageMetadata: Object.freeze({
      async listPage(cursor: string | null) {
        const offset = cursorOffset(cursor);
        const rows = await query(`SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json)::text FROM (SELECT bucket, key, metadata FROM (SELECT id AS bucket, NULL::text AS key, to_jsonb(b) - 'id' AS metadata FROM storage.buckets b UNION ALL SELECT bucket_id AS bucket, name AS key, to_jsonb(o) - 'bucket_id' - 'name' AS metadata FROM storage.objects o) inventory ORDER BY bucket, key NULLS FIRST LIMIT ${PAGE_SIZE} OFFSET ${offset}) q`);
        const records = rows.map((row) => ({ bucket: String(row.bucket), key: row.key === null ? null : String(row.key), metadata: row.metadata as Record<string, unknown> }));
        const complete = records.length < PAGE_SIZE;
        return { records, nextCursor: complete ? null : String(offset + records.length), snapshotId, complete };
      },
    }),
    async listStorageObjectsPage(cursor: string | null) {
      const offset = cursorOffset(cursor);
      const rows = await query(`SELECT COALESCE(json_agg(row_to_json(q)), '[]'::json)::text FROM (SELECT bucket_id AS bucket, name AS key, to_jsonb(o) - 'bucket_id' - 'name' AS metadata FROM storage.objects o ORDER BY bucket_id, name LIMIT ${PAGE_SIZE} OFFSET ${offset}) q`);
      const records = rows.map((row) => ({ bucket: String(row.bucket), key: String(row.key), metadata: row.metadata as Record<string, unknown> }));
      const complete = records.length < PAGE_SIZE;
      return { records, nextCursor: complete ? null : String(offset + records.length), snapshotId, complete };
    },
  });
}

async function spool(
  stream: Readable,
  filePath: string,
  expected?: { readonly bytes: bigint; readonly component: "external_assets" },
): Promise<{ bytes: bigint; sha256: string; filePath: string }> {
  const handle = await open(filePath, "wx", 0o600); let bytes = BigInt(0); const hash = createHash("sha256");
  let complete = false;
  try {
  for await (const chunk of stream) {
    const value = Buffer.from(chunk); bytes += BigInt(value.byteLength);
    if (bytes > MAX_MEASURE_BYTES) fail("BACKUP_V2_SOURCE_LIMIT_EXCEEDED", "Production source object exceeded the approved limit");
      hash.update(value); await handle.write(value);
  }
  if (expected && bytes !== expected.bytes) {
    fail("BACKUP_V2_SOURCE_OBJECT_CHANGED", "External asset byte count changed during read-only export");
  }
    await handle.sync(); complete = true;
    return { bytes, sha256: hash.digest("hex"), filePath };
  } finally {
    await handle.close();
    if (!complete) await rm(filePath, { force: true });
  }
}

function safeSupabaseUrl(value: string): URL {
  let url: URL; try { url = new URL(required(value, "NEXT_PUBLIC_SUPABASE_URL")); } catch { fail("BACKUP_V2_PRODUCTION_SOURCE_CONFIG_INVALID", "Supabase URL is invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/" || url.hash) fail("BACKUP_V2_PRODUCTION_SOURCE_CONFIG_INVALID", "Supabase URL must be an HTTPS origin");
  return url;
}

function exactCount(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail("BACKUP_V2_SOURCE_MEASUREMENT_INVALID", `${field} was invalid`);
  return BigInt(value);
}

export async function measureDatabaseSource(
  runner: PostgresToolRunner,
  connection: PostgresConnection,
  snapshotId: string,
  containerName?: string,
): Promise<Omit<ProductionSourceMeasurements, "externalAssetBytes" | "externalAssets">> {
  if (!/^[0-9A-Fa-f-]{8,128}$/.test(snapshotId)) {
    fail("BACKUP_V2_INVALID_EXPORT_SNAPSHOT", "PostgreSQL exported snapshot identity is invalid");
  }
  const authUnion = AUTH_DURABLE_TABLES.map((table) => `SELECT pg_column_size(t)::bigint AS bytes FROM auth.${table} t`).join(" UNION ALL ");
  const sql = `WITH auth_rows AS (${authUnion}), storage_metadata_rows AS (
    SELECT pg_column_size(t)::bigint AS bytes FROM storage.buckets t
    UNION ALL SELECT pg_column_size(t)::bigint AS bytes FROM storage.objects t
  ), storage_objects_checked AS (
    SELECT CASE WHEN metadata->>'size' ~ '^(0|[1-9][0-9]*)$' THEN (metadata->>'size')::numeric ELSE NULL END AS bytes
    FROM storage.objects
  ) SELECT json_build_object(
    'databaseBytes',pg_database_size(current_database())::text,
    'databaseObjects','1',
    'authBytes',(SELECT coalesce(sum(bytes),0)::text FROM auth_rows),
    'authObjects',(SELECT count(*)::text FROM auth_rows),
    'storageMetadataBytes',(SELECT coalesce(sum(bytes),0)::text FROM storage_metadata_rows),
    'storageMetadataObjects',(SELECT count(*)::text FROM storage_metadata_rows),
    'storageObjectBytes',(SELECT coalesce(sum(bytes),0)::text FROM storage_objects_checked),
    'storageObjects',(SELECT count(*)::text FROM storage_objects_checked),
    'storageObjectsMissingSize',(SELECT count(*)::text FROM storage_objects_checked WHERE bytes IS NULL)
  )::text`.replace(/\s+/g, " ").trim();
  const raw = (await runner.capture({
    tool: "psql", operation: "PRODUCTION_DB_SOURCE_MEASUREMENT",
    args: ["--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1"],
    connection, containerName,
    stdin: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET TRANSACTION SNAPSHOT '${snapshotId}'; ${sql}; COMMIT`,
  })).trim();
  let value: Record<string, unknown>;
  try { value = JSON.parse(raw); } catch { fail("BACKUP_V2_SOURCE_MEASUREMENT_INVALID", "Database source measurement was not valid JSON"); }
  if (exactCount(value.storageObjectsMissingSize, "storageObjectsMissingSize") !== BigInt(0)) {
    fail("BACKUP_V2_SOURCE_MEASUREMENT_INCOMPLETE", "Storage object byte evidence is incomplete");
  }
  return Object.freeze({
    databaseBytes: exactCount(value.databaseBytes, "databaseBytes"),
    databaseObjects: exactCount(value.databaseObjects, "databaseObjects"),
    authBytes: exactCount(value.authBytes, "authBytes"),
    authObjects: exactCount(value.authObjects, "authObjects"),
    storageMetadataBytes: exactCount(value.storageMetadataBytes, "storageMetadataBytes"),
    storageMetadataObjects: exactCount(value.storageMetadataObjects, "storageMetadataObjects"),
    storageObjectBytes: exactCount(value.storageObjectBytes, "storageObjectBytes"),
    storageObjects: exactCount(value.storageObjects, "storageObjects"),
  });
}

async function measureCloudinarySource(config: ProductionSourceConfig): Promise<{ externalAssetBytes: bigint; externalAssets: bigint }> {
  const cloudName = required(config.cloudinaryCloudName, "CLOUDINARY_CLOUD_NAME");
  const cloudinaryKey = required(config.cloudinaryApiKey, "CLOUDINARY_API_KEY");
  const cloudinarySecret = required(config.cloudinaryApiSecret, "CLOUDINARY_API_SECRET");
  const authorization = Buffer.from(`${cloudinaryKey}:${cloudinarySecret}`).toString("base64");
  let externalAssetBytes = BigInt(0);
  let externalAssets = BigInt(0);
  for (const resourceType of ["image", "video", "raw"] as const) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let page = 0; ; page += 1) {
      if (page >= 10_000) fail("BACKUP_V2_SOURCE_MEASUREMENT_LIMIT", "Cloudinary measurement pagination exceeded its limit");
      const url = new URL(`/v1_1/${encodeURIComponent(cloudName)}/resources/${resourceType}/upload`, "https://api.cloudinary.com");
      url.searchParams.set("max_results", String(PAGE_SIZE));
      if (cursor) url.searchParams.set("next_cursor", cursor);
      const response = await fetch(url, { headers: { authorization: `Basic ${authorization}` } });
      if (!response.ok) fail("BACKUP_V2_PRODUCTION_SOURCE_READ_FAILED", `Cloudinary measurement returned HTTP ${response.status}`);
      const body = await response.json() as { resources?: Array<Record<string, unknown>>; next_cursor?: unknown };
      if (!Array.isArray(body.resources)) fail("BACKUP_V2_SOURCE_MEASUREMENT_INVALID", "Cloudinary measurement response was invalid");
      for (const resource of body.resources) {
        externalAssetBytes += exactCount(String(resource.bytes), "externalAssetBytes");
        externalAssets += BigInt(1);
      }
      if (body.next_cursor === undefined || body.next_cursor === null) break;
      if (typeof body.next_cursor !== "string" || body.next_cursor.length < 1 || body.next_cursor.length > 2_048 || /[\u0000-\u001f\u007f]/.test(body.next_cursor) || seen.has(body.next_cursor)) {
        fail("BACKUP_V2_SOURCE_MEASUREMENT_INVALID", "Cloudinary measurement cursor was invalid");
      }
      seen.add(body.next_cursor); cursor = body.next_cursor;
    }
  }
  return Object.freeze({ externalAssetBytes, externalAssets });
}

function defaultTransports(config: ProductionSourceConfig, connection: PostgresConnection, snapshotId: string, spoolRoot: string): ReadonlyProductionTransports {
  const database = createDatabaseReaders(config.postgresRunner, connection, snapshotId, config.postgresContainerName);
  const supabase = safeSupabaseUrl(config.supabaseUrl);
  const serviceKey = required(config.supabaseServiceRoleKey, "SUPABASE_SERVICE_ROLE_KEY");
  const cloudName = required(config.cloudinaryCloudName, "CLOUDINARY_CLOUD_NAME");
  const cloudinaryKey = required(config.cloudinaryApiKey, "CLOUDINARY_API_KEY");
  const cloudinarySecret = required(config.cloudinaryApiSecret, "CLOUDINARY_API_SECRET");
  const headers = Object.freeze({ authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "content-type": "application/json" });
  const storageObjects: StorageObjectReader = Object.freeze({
    async listPage(cursor: string | null, signal?: AbortSignal): Promise<PagedRecordResult<StorageObjectRecord>> {
      const listed = await database.listStorageObjectsPage(cursor);
      const records: StorageObjectRecord[] = [];
      for (const item of listed.records) {
        const download = await fetch(new URL(`/storage/v1/object/authenticated/${encodeURIComponent(item.bucket)}/${item.key.split("/").map(encodeURIComponent).join("/")}`, supabase), { headers, signal });
        if (!download.ok || !download.body) fail("BACKUP_V2_PRODUCTION_SOURCE_READ_FAILED", `Supabase object download returned HTTP ${download.status}`);
        const filePath = path.join(spoolRoot, `${createHash("sha256").update(`${item.bucket}\0${item.key}`).digest("hex")}.storage-object`);
        const measured = await spool(Readable.fromWeb(download.body as never), filePath);
        records.push({ bucket: item.bucket, key: item.key, metadata: item.metadata, bytes: measured.bytes, sha256: measured.sha256, open: () => createReadStream(measured.filePath) });
      }
      return { records, nextCursor: listed.nextCursor, snapshotId: listed.snapshotId, complete: listed.complete };
    },
  });
  const policy: ExternalFetchPolicy = Object.freeze({ fetch, resolve: async (hostname: string) => (await lookup(hostname, { all: true })).map(({ address }) => address) });
  const cloudinary: CloudinaryResourceReader = Object.freeze({
    cloudName,
    async listOriginalsPage(cursor: string | null, signal?: AbortSignal) {
      const [resourceType = "image", providerCursor = ""] = cursor?.split(":", 2) ?? ["image", ""];
      if (!["image", "video", "raw"].includes(resourceType)) fail("BACKUP_V2_INVALID_PAGINATION_CURSOR", "Cloudinary cursor is invalid");
      const url = new URL(`/v1_1/${encodeURIComponent(cloudName)}/resources/${resourceType}/upload`, "https://api.cloudinary.com");
      url.searchParams.set("max_results", String(PAGE_SIZE)); if (providerCursor) url.searchParams.set("next_cursor", providerCursor);
      const authorization = Buffer.from(`${cloudinaryKey}:${cloudinarySecret}`).toString("base64");
      const response = await fetch(url, { headers: { authorization: `Basic ${authorization}` }, signal });
      if (!response.ok) fail("BACKUP_V2_PRODUCTION_SOURCE_READ_FAILED", `Cloudinary listing returned HTTP ${response.status}`);
      const body = await response.json() as { resources?: Array<Record<string, unknown>>; next_cursor?: string };
      const records: CloudinaryOriginalRecord[] = [];
      for (const raw of body.resources ?? []) {
        const provisional: CloudinaryOriginalRecord = {
          publicId: String(raw.public_id), resourceType: resourceType as "image" | "video" | "raw", type: String(raw.type ?? "upload"),
          version: String(raw.version), format: raw.format == null ? null : String(raw.format), bytes: BigInt(String(raw.bytes)), sha256: "0".repeat(64),
          secureUrl: String(raw.secure_url), metadata: raw,
        };
        const measurePath = path.join(spoolRoot, `${createHash("sha256").update(`${resourceType}\0${provisional.publicId}\0${provisional.version}`).digest("hex")}.cloudinary-measure`);
        const measured = await spool(
          openVerifiedCloudinaryOriginal(provisional, cloudName, policy, signal),
          measurePath,
          { bytes: provisional.bytes, component: "external_assets" },
        );
        await rm(measurePath, { force: true });
        records.push({ ...provisional, sha256: measured.sha256 });
      }
      const types = ["image", "video", "raw"] as const; const index = types.indexOf(resourceType as never);
      const nextCursor = body.next_cursor ? `${resourceType}:${body.next_cursor}` : index + 1 < types.length ? `${types[index + 1]}:` : null;
      return { records, nextCursor, snapshotId, complete: nextCursor === null };
    },
  });
  return Object.freeze({ ...database, storageObjects, cloudinary, externalFetchPolicy: policy });
}

export async function createProductionBackupSources(config: ProductionSourceConfig): Promise<ProductionBackupSources> {
  const connection = parseProductionDatabaseUrl(config.databaseUrl);
  const spoolRoot = await mkdtemp(path.join(os.tmpdir(), "carzone-backup-v2-production-sources-"));
  let snapshot: ProductionSnapshot | null = null;
  try {
  snapshot = config.transports ? null : await openProductionSnapshot(config.postgresRunner, connection, config.postgresContainerName);
  const transports = config.transports ?? defaultTransports(config, connection, snapshot!.id, spoolRoot);
  const database = await createRunnerPlainSqlExporter({
    connection,
    runner: config.postgresRunner,
    snapshotId: snapshot?.id,
    containerName: config.postgresContainerName,
  });
  let measurement: Promise<ProductionSourceMeasurements> | null = null;
  return Object.freeze({
    database,
    auth: createAuthSchemaSource(transports.auth),
    storageMetadata: createStorageMetadataSource(transports.storageMetadata),
    storageObjects: createStorageObjectsSource(transports.storageObjects),
    externalAssets: createCloudinaryOriginalsSource(transports.cloudinary, transports.externalFetchPolicy),
    mutationMethods: Object.freeze([]) as readonly [],
    measureCanonicalSource() {
      measurement ??= config.measurementProbe
        ? config.measurementProbe()
        : Promise.all([
            measureDatabaseSource(config.postgresRunner, connection, snapshot!.id, config.postgresContainerName),
            measureCloudinarySource(config),
          ]).then(([databaseMeasurement, cloudinaryMeasurement]) => Object.freeze({ ...databaseMeasurement, ...cloudinaryMeasurement }));
      return measurement;
    },
    async cleanup() { await snapshot?.close(); await rm(spoolRoot, { recursive: true, force: true }); },
  });
  } catch (error) {
    await snapshot?.close(); await rm(spoolRoot, { recursive: true, force: true }); throw error;
  }
}
