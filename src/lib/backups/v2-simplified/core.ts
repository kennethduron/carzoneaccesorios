import "server-only";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, statfs } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256Hex } from "../v2/database-artifact-format.ts";
import { BackupV2FailClosedError } from "../v2/types.ts";
import type {
  SimplifiedBackupIndex,
  SimplifiedBackupManifest,
  SimplifiedBackupManifestBody,
  SimplifiedFinalReport,
  SimplifiedSourceMeasurements,
} from "./types.ts";
import { SIMPLIFIED_COMPONENTS } from "./types.ts";

const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SIMPLIFIED_OBJECT = /^car-zone\/v2-simplified\/([^/]+)\/(database|auth|storage_metadata|storage_objects|external_assets|manifest)\/[A-Za-z0-9._-]{1,200}$/;

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

export function canonicalTimestamp(clock: () => string = () => new Date().toISOString()): string {
  const value = clock();
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("BACKUP_V2_SIMPLIFIED_INVALID_CLOCK", "Clock did not return a canonical ISO timestamp");
  }
  return value;
}

export function createSimplifiedRunId(
  clock: () => string = () => new Date().toISOString(),
  uuid: () => string = randomUUID,
): string {
  const timestamp = canonicalTimestamp(clock).replace(/:/g, "-").replace(".", "-");
  const value = `${timestamp}_${uuid()}`;
  if (!RUN_ID.test(value)) fail("BACKUP_V2_SIMPLIFIED_INVALID_RUN_ID", "Local run identity is invalid");
  return value;
}

export function requireSimplifiedRunId(value: unknown): string {
  if (typeof value !== "string" || !RUN_ID.test(value)) {
    fail("BACKUP_V2_SIMPLIFIED_INVALID_RUN_ID", "Local run identity is invalid");
  }
  return value;
}

export function simplifiedArtifactBinding(runIdValue: string): string {
  const runId = requireSimplifiedRunId(runIdValue);
  return `backup-v2-generation:${sha256Hex(`SIMPLIFIED_BACKUP_V2\n${runId}`)}`;
}

export function simplifiedRemotePrefix(runIdValue: string): string {
  return `car-zone/v2-simplified/${requireSimplifiedRunId(runIdValue)}/`;
}

export function assertSimplifiedObjectKey(value: unknown, expectedRunId?: string): string {
  if (typeof value !== "string" || value.length > 480 || value.includes("\\") || value.includes("\0") ||
      value.startsWith("/") || value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail("BACKUP_V2_SIMPLIFIED_PATH_ESCAPE", "Remote object key is unsafe");
  }
  const match = SIMPLIFIED_OBJECT.exec(value);
  if (!match || !RUN_ID.test(match[1]) || (expectedRunId !== undefined && match[1] !== expectedRunId)) {
    fail("BACKUP_V2_SIMPLIFIED_PATH_ESCAPE", "Remote object key is outside the immutable run prefix");
  }
  return value;
}

export async function createSimplifiedStateRoot(parentValue: string, runIdValue: string): Promise<string> {
  const runId = requireSimplifiedRunId(runIdValue);
  if (typeof parentValue !== "string" || parentValue.length < 1 || parentValue.includes("\0")) {
    fail("BACKUP_V2_SIMPLIFIED_INVALID_STATE_ROOT", "State parent is invalid");
  }
  await mkdir(parentValue, { recursive: true, mode: 0o700 });
  const parentStat = await lstat(parentValue);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    fail("BACKUP_V2_SIMPLIFIED_INVALID_STATE_ROOT", "State parent is unsafe");
  }
  const parent = await realpath(parentValue);
  const child = path.resolve(parent, runId);
  if (path.dirname(child) !== parent) fail("BACKUP_V2_SIMPLIFIED_PATH_ESCAPE", "Run state escaped its parent");
  await mkdir(child, { mode: 0o700 });
  return child;
}

export async function writeCanonicalJsonFile(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.partial-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function measureFile(filePath: string): Promise<{ bytes: bigint; sha256: string }> {
  const supplied = await lstat(filePath);
  if (!supplied.isFile() || supplied.isSymbolicLink()) {
    fail("BACKUP_V2_SIMPLIFIED_UNSAFE_LOCAL_FILE", "Backup file is not a safe regular file");
  }
  const hash = createHash("sha256");
  let bytes = BigInt(0);
  for await (const chunk of createReadStream(filePath)) {
    const value = Buffer.from(chunk);
    bytes += BigInt(value.byteLength);
    hash.update(value);
  }
  return { bytes, sha256: hash.digest("hex") };
}

export function safeHashEqual(left: string, right: string): boolean {
  return SHA256.test(left) && SHA256.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function createSimplifiedManifest(body: SimplifiedBackupManifestBody): SimplifiedBackupManifest {
  requireSimplifiedRunId(body.run_id);
  if (body.schema !== "car-zone-backup-v2-simplified-manifest-v1" || body.application !== "car-zone-accesorios" ||
      body.production_source_access !== "READ_ONLY" || body.production_mutations !== 0 ||
      body.independent_secondary_present !== false || body.full_dr_ready !== false ||
      body.local_artifact_binding !== simplifiedArtifactBinding(body.run_id) ||
      !Number.isFinite(Date.parse(body.created_at)) || new Date(body.created_at).toISOString() !== body.created_at ||
      body.remote_prefix !== simplifiedRemotePrefix(body.run_id) || body.components.length !== 5) {
    fail("BACKUP_V2_SIMPLIFIED_MANIFEST_INVALID", "Manifest identity or component inventory is incomplete");
  }
  const components = body.components.map(({ component }) => component);
  if (new Set(components).size !== 5 || SIMPLIFIED_COMPONENTS.some((component) => !components.includes(component))) {
    fail("BACKUP_V2_SIMPLIFIED_MANIFEST_INVALID", "Manifest components are missing, duplicate, or unknown");
  }
  return Object.freeze({ ...body, integrity: { manifest_sha256: sha256Hex(canonicalJson(body)) } });
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("BACKUP_V2_SIMPLIFIED_MANIFEST_INVALID", "Manifest is not an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail("BACKUP_V2_SIMPLIFIED_MANIFEST_INVALID", `${field} contains missing or unexpected fields`);
  }
}

export function parseSimplifiedManifest(value: string): SimplifiedBackupManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail("BACKUP_V2_SIMPLIFIED_MANIFEST_INVALID", "Manifest is not JSON"); }
  const root = record(parsed);
  exactKeys(root, ["schema", "application", "run_id", "created_at", "local_artifact_binding", "remote_prefix", "components", "production_source_access", "production_mutations", "independent_secondary_present", "full_dr_ready", "integrity"], "manifest");
  if (value !== `${canonicalJson(root)}\n`) fail("BACKUP_V2_SIMPLIFIED_MANIFEST_INVALID", "Manifest is not canonical JSON");
  const integrity = record(root.integrity);
  const { integrity: _removed, ...body } = root;
  void _removed;
  if (root.schema !== "car-zone-backup-v2-simplified-manifest-v1" || root.application !== "car-zone-accesorios" ||
      typeof integrity.manifest_sha256 !== "string" || !safeHashEqual(integrity.manifest_sha256, sha256Hex(canonicalJson(body)))) {
    fail("BACKUP_V2_SIMPLIFIED_MANIFEST_TAMPERED", "Manifest integrity verification failed");
  }
  const manifest = root as unknown as SimplifiedBackupManifest;
  if (!Array.isArray(manifest.components)) fail("BACKUP_V2_SIMPLIFIED_MANIFEST_INVALID", "Manifest components are not an array");
  createSimplifiedManifest(body as unknown as SimplifiedBackupManifestBody);
  for (const itemValue of manifest.components) {
    const item = record(itemValue);
    exactKeys(item, ["component", "artifact_id", "artifact_object_key", "artifact_bytes", "artifact_sha256", "manifest_object_key", "manifest_bytes", "manifest_sha256", "plaintext_bytes", "plaintext_sha256", "logical_count", "format_version", "encryption_envelope", "representation", "plaintext_filename", "restore_strategy", "postgres_major"], "manifest component");
    if (!DECIMAL.test(String(item.artifact_bytes)) || !DECIMAL.test(String(item.manifest_bytes)) ||
        !DECIMAL.test(String(item.plaintext_bytes)) || !DECIMAL.test(String(item.logical_count)) ||
        !SHA256.test(String(item.artifact_sha256)) || !SHA256.test(String(item.manifest_sha256)) ||
        !SHA256.test(String(item.plaintext_sha256)) || item.encryption_envelope !== "car-zone-aesgcm-envelope-v1" ||
        typeof item.component !== "string" || !SIMPLIFIED_COMPONENTS.includes(item.component as never) ||
        typeof item.artifact_id !== "string" || !new RegExp(`^${item.component}-[0-9a-f]{64}$`).test(item.artifact_id) ||
        typeof item.format_version !== "string" || item.format_version.length < 1 || item.format_version.length > 200 ||
        typeof item.representation !== "string" || item.representation.length < 1 ||
        typeof item.restore_strategy !== "string" || item.restore_strategy.length < 1 ||
        typeof item.artifact_object_key !== "string" || typeof item.manifest_object_key !== "string") {
      fail("BACKUP_V2_SIMPLIFIED_MANIFEST_INVALID", "Manifest component evidence is invalid");
    }
    if (item.component === "database" && (
      item.representation !== "postgres_plain_sql_v1" ||
      item.plaintext_filename !== "database.sql" ||
      item.restore_strategy !== "psql_file_restore_v1" ||
      item.postgres_major !== 17
    )) {
      fail("BACKUP_V2_SIMPLIFIED_MANIFEST_INVALID", "Database manifest entry is not the Plain SQL recovery contract");
    }
    assertSimplifiedObjectKey(item.artifact_object_key, manifest.run_id);
    assertSimplifiedObjectKey(item.manifest_object_key, manifest.run_id);
  }
  return manifest;
}

export function createSimplifiedIndex(
  value: Omit<SimplifiedBackupIndex, "integrity">,
): SimplifiedBackupIndex {
  requireSimplifiedRunId(value.run_id);
  assertSimplifiedObjectKey(value.manifest_object_key, value.run_id);
  if (value.schema !== "car-zone-backup-v2-simplified-index-v1" ||
      !Number.isFinite(Date.parse(value.created_at)) || new Date(value.created_at).toISOString() !== value.created_at ||
      !DECIMAL.test(value.manifest_encrypted_bytes) || !DECIMAL.test(value.manifest_plaintext_bytes) ||
      !DECIMAL.test(value.manifest_compressed_bytes) || !SHA256.test(value.manifest_encrypted_sha256) ||
      !SHA256.test(value.manifest_plaintext_sha256) || !SHA256.test(value.manifest_compressed_sha256) ||
      value.encryption.algorithm !== "aes-256-gcm" || value.encryption.envelope !== "car-zone-aesgcm-envelope-v1" ||
      !SHA256.test(value.encryption.aad_sha256)) {
    fail("BACKUP_V2_SIMPLIFIED_INDEX_INVALID", "Backup index evidence is invalid");
  }
  const body = value as unknown as Record<string, unknown>;
  return Object.freeze({ ...value, integrity: { index_sha256: sha256Hex(canonicalJson(body)) } });
}

export function parseSimplifiedIndex(value: string): SimplifiedBackupIndex {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail("BACKUP_V2_SIMPLIFIED_INDEX_INVALID", "Backup index is not JSON"); }
  const root = record(parsed);
  exactKeys(root, ["schema", "run_id", "created_at", "manifest_object_key", "manifest_encrypted_bytes", "manifest_encrypted_sha256", "manifest_plaintext_bytes", "manifest_plaintext_sha256", "manifest_compressed_bytes", "manifest_compressed_sha256", "encryption", "integrity"], "backup index");
  if (value !== `${canonicalJson(root)}\n`) fail("BACKUP_V2_SIMPLIFIED_INDEX_INVALID", "Backup index is not canonical JSON");
  const integrity = record(root.integrity);
  const { integrity: _removed, ...body } = root;
  void _removed;
  if (root.schema !== "car-zone-backup-v2-simplified-index-v1" || typeof integrity.index_sha256 !== "string" ||
      !safeHashEqual(integrity.index_sha256, sha256Hex(canonicalJson(body)))) {
    fail("BACKUP_V2_SIMPLIFIED_INDEX_TAMPERED", "Backup index integrity verification failed");
  }
  const result = root as unknown as SimplifiedBackupIndex;
  exactKeys(record(result.encryption), ["algorithm", "envelope", "nonce_base64", "auth_tag_base64", "aad_sha256"], "backup index encryption");
  createSimplifiedIndex(body as unknown as Omit<SimplifiedBackupIndex, "integrity">);
  return result;
}

export function estimatedTemporaryBytes(measurements: SimplifiedSourceMeasurements): bigint {
  const source = measurements.databaseBytes + measurements.authBytes + measurements.storageMetadataBytes +
    measurements.storageObjectBytes + measurements.externalAssetBytes;
  if (source < BigInt(0)) fail("BACKUP_V2_SIMPLIFIED_SOURCE_MEASUREMENT_INVALID", "Source byte estimate is invalid");
  return source * BigInt(3);
}

export async function availableDiskBytes(pathValue: string): Promise<bigint> {
  const info = await statfs(pathValue, { bigint: true });
  return info.bavail * info.bsize;
}

export async function assertSufficientLocalDisk(input: {
  pathValue: string;
  measurements: SimplifiedSourceMeasurements;
  available?: (pathValue: string) => Promise<bigint>;
  safetyMarginBytes?: bigint;
}): Promise<{ requiredBytes: bigint; availableBytes: bigint }> {
  const estimate = estimatedTemporaryBytes(input.measurements);
  const margin = input.safetyMarginBytes ?? BigInt(2 * 1024 * 1024 * 1024);
  const requiredBytes = estimate + margin;
  const free = await (input.available ?? availableDiskBytes)(input.pathValue);
  if (free < requiredBytes) {
    fail("BACKUP_V2_SIMPLIFIED_INSUFFICIENT_LOCAL_DISK", "Insufficient local disk space before export");
  }
  return { requiredBytes, availableBytes: free };
}

export async function readBoundedUtf8(filePath: string, maximumBytes = 2 * 1024 * 1024): Promise<string> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maximumBytes) {
    fail("BACKUP_V2_SIMPLIFIED_MANIFEST_INVALID", "Manifest file is unsafe or oversized");
  }
  return readFile(filePath, "utf8");
}

export async function writeSafeReport(filePath: string, report: SimplifiedFinalReport): Promise<void> {
  await writeCanonicalJsonFile(filePath, report);
}
