import "server-only";

import { createHash } from "node:crypto";

import { BackupV2FailClosedError } from "./types.ts";

export const DATABASE_MANIFEST_VERSION = "car-zone-backup-v2-manifest-v1" as const;
export const DATABASE_BACKUP_VERSION = "phase4b2" as const;
export const DATABASE_EXPORT_FORMAT = "postgresql_custom" as const;
export const DATABASE_EXPORT_FORMAT_VERSION = "pg_dump-custom-v1" as const;
export const DATABASE_COMPRESSION_ALGORITHM = "gzip" as const;
export const DATABASE_COMPRESSION_FORMAT_VERSION = "rfc1952" as const;
export const DATABASE_ENCRYPTION_ALGORITHM = "aes-256-gcm" as const;
export const DATABASE_ENCRYPTION_FORMAT_VERSION = "car-zone-aesgcm-envelope-v1" as const;
export const DATABASE_HASH_ALGORITHM = "sha256" as const;
export const DATABASE_ARTIFACT_CONTENT_TYPE = "application/vnd.car-zone.backup-v2.database" as const;
export const DATABASE_ARTIFACT_MAGIC = Buffer.from("CZB2DB01", "ascii");
export const DATABASE_NONCE_BYTES = 12;
export const DATABASE_AUTH_TAG_BYTES = 16;
export const DATABASE_ARTIFACT_HEADER_BYTES = DATABASE_ARTIFACT_MAGIC.length + DATABASE_NONCE_BYTES;
export const DATABASE_ARTIFACT_MIN_BYTES = DATABASE_ARTIFACT_HEADER_BYTES + DATABASE_AUTH_TAG_BYTES + 1;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GENERATION_PATTERN = /^backup-v2-generation:[0-9a-f]{64}$/;
const SAFE_REFERENCE_PATTERN = /^[A-Za-z0-9._:@/-]{1,200}$/;
const CANONICAL_BYTES_PATTERN = /^(0|[1-9][0-9]*)$/;

export interface DatabaseArtifactAadInput {
  runId: string;
  generationKey: string;
  artifactId: string;
  createdAt: string;
  catalogFingerprint: string;
  catalogPolicyVersion: string;
  preflightSnapshotId: string;
  keyVersion: string;
  keyReference: string;
  keyFingerprint: string;
  exportTool: "pg_dump";
  exportToolVersion: string;
  compressionLevel: number;
}

export interface DatabaseArtifactManifest {
  manifest_version: typeof DATABASE_MANIFEST_VERSION;
  backup_v2_version: typeof DATABASE_BACKUP_VERSION;
  run_id: string;
  generation_key: string;
  artifact_id: string;
  component: "database";
  created_at: string;
  catalog: {
    fingerprint: string;
    policy_version: string;
  };
  preflight: {
    snapshot_id: string;
    outcome: "go";
  };
  export: {
    format: typeof DATABASE_EXPORT_FORMAT;
    format_version: typeof DATABASE_EXPORT_FORMAT_VERSION;
    tool: "pg_dump";
    tool_version: string;
  };
  compression: {
    algorithm: typeof DATABASE_COMPRESSION_ALGORITHM;
    format_version: typeof DATABASE_COMPRESSION_FORMAT_VERSION;
    level: number;
  };
  encryption: {
    algorithm: typeof DATABASE_ENCRYPTION_ALGORITHM;
    format_version: typeof DATABASE_ENCRYPTION_FORMAT_VERSION;
    nonce_base64: string;
    auth_tag_base64: string;
    key_version: string;
    key_reference: string;
    key_fingerprint: string;
    aad_sha256: string;
  };
  byte_counts: {
    plaintext_export: string;
    compressed: string;
    encrypted_artifact: string;
  };
  hashes: {
    algorithm: typeof DATABASE_HASH_ALGORITHM;
    plaintext_export: string;
    compressed: string;
    encrypted_artifact: string;
  };
  artifact: {
    filename: string;
    content_type: typeof DATABASE_ARTIFACT_CONTENT_TYPE;
  };
  compatibility_ref: string;
  integrity: {
    manifest_sha256: string;
  };
}

export interface CreateDatabaseArtifactManifestInput extends DatabaseArtifactAadInput {
  nonce: Uint8Array;
  authTag: Uint8Array;
  plaintextBytes: bigint;
  compressedBytes: bigint;
  encryptedArtifactBytes: bigint;
  plaintextHash: string;
  compressedHash: string;
  encryptedArtifactHash: string;
  compatibilityRef: string;
}

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) fail("BACKUP_V2_INVALID_DATABASE_MANIFEST", `${field} must be an object`);
  return value;
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("BACKUP_V2_INVALID_DATABASE_MANIFEST", `${field} contains missing or unknown fields`);
  }
}

function requireString(value: unknown, field: string, pattern = SAFE_REFERENCE_PATTERN): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail("BACKUP_V2_INVALID_DATABASE_MANIFEST", `${field} is invalid`);
  }
  return value;
}

function requireIsoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("BACKUP_V2_INVALID_DATABASE_MANIFEST", `${field} must be a canonical ISO timestamp`);
  }
  return value;
}

function requireSha256(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("BACKUP_V2_INVALID_DATABASE_MANIFEST", `${field} must be a SHA-256 digest`);
  }
  return value;
}

function requireCanonicalBytes(value: unknown, field: string, allowZero = false): string {
  if (typeof value !== "string" || !CANONICAL_BYTES_PATTERN.test(value) || (!allowZero && value === "0")) {
    fail("BACKUP_V2_INVALID_DATABASE_MANIFEST", `${field} must be a positive canonical byte count`);
  }
  return value;
}

function requireCompressionLevel(value: unknown): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 1 || value > 9) {
    fail("BACKUP_V2_INVALID_DATABASE_MANIFEST", "compression.level must be an integer from 1 through 9");
  }
  return value;
}

function requireBase64Bytes(value: unknown, field: string, expectedBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("BACKUP_V2_INVALID_DATABASE_MANIFEST", `${field} must be base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== expectedBytes || decoded.toString("base64") !== value) {
    fail("BACKUP_V2_INVALID_DATABASE_MANIFEST", `${field} has an invalid encoded length`);
  }
  return value;
}

function canonicalValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      fail("BACKUP_V2_NON_CANONICAL_JSON", "Canonical JSON accepts only finite safe integers");
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(",")}]`;
  if (!isRecord(value)) fail("BACKUP_V2_NON_CANONICAL_JSON", "Unsupported canonical JSON value");
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return canonicalValue(value);
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function requireCanonicalGenerationKey(value: unknown): string {
  if (typeof value !== "string" || !GENERATION_PATTERN.test(value)) {
    fail("BACKUP_V2_INVALID_GENERATION_KEY", "Database artifact generation key is not canonical");
  }
  return value;
}

export function databaseArtifactId(generationKeyValue: string): string {
  const generationKey = requireCanonicalGenerationKey(generationKeyValue);
  return `database-${sha256Hex(`backup-v2-database-artifact-v1\n${generationKey}`)}`;
}

export function databaseArtifactFilename(artifactId: string): string {
  if (!/^database-[0-9a-f]{64}$/.test(artifactId)) {
    fail("BACKUP_V2_INVALID_ARTIFACT_ID", "Database artifact ID is not canonical");
  }
  return `${artifactId}.czb2`;
}

export function databaseArtifactAadBytes(input: DatabaseArtifactAadInput): Buffer {
  requireString(input.runId, "run_id");
  requireCanonicalGenerationKey(input.generationKey);
  if (databaseArtifactId(input.generationKey) !== input.artifactId) {
    fail("BACKUP_V2_ARTIFACT_GENERATION_MISMATCH", "Artifact ID does not belong to the generation");
  }
  requireIsoTimestamp(input.createdAt, "created_at");
  requireSha256(input.catalogFingerprint, "catalog.fingerprint");
  requireString(input.catalogPolicyVersion, "catalog.policy_version");
  requireString(input.preflightSnapshotId, "preflight.snapshot_id");
  requireString(input.keyVersion, "encryption.key_version");
  requireString(input.keyReference, "encryption.key_reference");
  requireString(input.keyFingerprint, "encryption.key_fingerprint");
  requireString(input.exportToolVersion, "export.tool_version", /^[A-Za-z0-9 ._()+-]{1,160}$/);
  requireCompressionLevel(input.compressionLevel);
  if (input.exportTool !== "pg_dump") {
    fail("BACKUP_V2_UNKNOWN_EXPORT_TOOL", "Only pg_dump is supported for database artifacts");
  }
  return Buffer.from(canonicalJson({
    artifact_id: input.artifactId,
    backup_v2_version: DATABASE_BACKUP_VERSION,
    catalog_fingerprint: input.catalogFingerprint,
    catalog_policy_version: input.catalogPolicyVersion,
    component: "database",
    compression_algorithm: DATABASE_COMPRESSION_ALGORITHM,
    compression_format_version: DATABASE_COMPRESSION_FORMAT_VERSION,
    compression_level: input.compressionLevel,
    created_at: input.createdAt,
    encryption_algorithm: DATABASE_ENCRYPTION_ALGORITHM,
    encryption_format_version: DATABASE_ENCRYPTION_FORMAT_VERSION,
    export_format: DATABASE_EXPORT_FORMAT,
    export_format_version: DATABASE_EXPORT_FORMAT_VERSION,
    export_tool: input.exportTool,
    export_tool_version: input.exportToolVersion,
    generation_key: input.generationKey,
    key_fingerprint: input.keyFingerprint,
    key_reference: input.keyReference,
    key_version: input.keyVersion,
    manifest_version: DATABASE_MANIFEST_VERSION,
    preflight_outcome: "go",
    preflight_snapshot_id: input.preflightSnapshotId,
    run_id: input.runId,
  }), "utf8");
}

function manifestHashPayload(manifest: Omit<DatabaseArtifactManifest, "integrity">): string {
  return canonicalJson(manifest);
}

export function createDatabaseArtifactManifest(
  input: CreateDatabaseArtifactManifestInput,
): DatabaseArtifactManifest {
  if (input.nonce.byteLength !== DATABASE_NONCE_BYTES || input.authTag.byteLength !== DATABASE_AUTH_TAG_BYTES) {
    fail("BACKUP_V2_INVALID_ENCRYPTION_METADATA", "AES-GCM nonce or authentication tag length is invalid");
  }
  const artifactFilename = databaseArtifactFilename(input.artifactId);
  const aad = databaseArtifactAadBytes(input);
  const withoutIntegrity: Omit<DatabaseArtifactManifest, "integrity"> = {
    manifest_version: DATABASE_MANIFEST_VERSION,
    backup_v2_version: DATABASE_BACKUP_VERSION,
    run_id: input.runId,
    generation_key: input.generationKey,
    artifact_id: input.artifactId,
    component: "database",
    created_at: input.createdAt,
    catalog: { fingerprint: input.catalogFingerprint, policy_version: input.catalogPolicyVersion },
    preflight: { snapshot_id: input.preflightSnapshotId, outcome: "go" },
    export: {
      format: DATABASE_EXPORT_FORMAT,
      format_version: DATABASE_EXPORT_FORMAT_VERSION,
      tool: input.exportTool,
      tool_version: input.exportToolVersion,
    },
    compression: {
      algorithm: DATABASE_COMPRESSION_ALGORITHM,
      format_version: DATABASE_COMPRESSION_FORMAT_VERSION,
      level: input.compressionLevel,
    },
    encryption: {
      algorithm: DATABASE_ENCRYPTION_ALGORITHM,
      format_version: DATABASE_ENCRYPTION_FORMAT_VERSION,
      nonce_base64: Buffer.from(input.nonce).toString("base64"),
      auth_tag_base64: Buffer.from(input.authTag).toString("base64"),
      key_version: input.keyVersion,
      key_reference: input.keyReference,
      key_fingerprint: input.keyFingerprint,
      aad_sha256: sha256Hex(aad),
    },
    byte_counts: {
      plaintext_export: input.plaintextBytes.toString(),
      compressed: input.compressedBytes.toString(),
      encrypted_artifact: input.encryptedArtifactBytes.toString(),
    },
    hashes: {
      algorithm: DATABASE_HASH_ALGORITHM,
      plaintext_export: input.plaintextHash,
      compressed: input.compressedHash,
      encrypted_artifact: input.encryptedArtifactHash,
    },
    artifact: { filename: artifactFilename, content_type: DATABASE_ARTIFACT_CONTENT_TYPE },
    compatibility_ref: input.compatibilityRef,
  };
  return {
    ...withoutIntegrity,
    integrity: { manifest_sha256: sha256Hex(manifestHashPayload(withoutIntegrity)) },
  };
}

export function serializeDatabaseArtifactManifest(manifest: DatabaseArtifactManifest): string {
  validateDatabaseArtifactManifest(manifest);
  return `${canonicalJson(manifest)}\n`;
}

export function parseDatabaseArtifactManifest(value: string): DatabaseArtifactManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("BACKUP_V2_INVALID_DATABASE_MANIFEST", "Manifest is not valid JSON");
  }
  const manifest = validateDatabaseArtifactManifest(parsed);
  if (value !== `${canonicalJson(manifest)}\n`) {
    fail("BACKUP_V2_NON_CANONICAL_MANIFEST", "Manifest bytes are not in canonical JSON form");
  }
  return manifest;
}

export function validateDatabaseArtifactManifest(value: unknown): DatabaseArtifactManifest {
  const root = requireRecord(value, "manifest");
  requireExactKeys(root, [
    "manifest_version", "backup_v2_version", "run_id", "generation_key", "artifact_id", "component",
    "created_at", "catalog", "preflight", "export", "compression", "encryption", "byte_counts", "hashes",
    "artifact", "compatibility_ref", "integrity",
  ], "manifest");
  if (root.manifest_version !== DATABASE_MANIFEST_VERSION) {
    fail("BACKUP_V2_UNKNOWN_MANIFEST_VERSION", "Unsupported database manifest version");
  }
  if (root.backup_v2_version !== DATABASE_BACKUP_VERSION || root.component !== "database") {
    fail("BACKUP_V2_INVALID_DATABASE_MANIFEST", "Manifest component or Backup V2 version is invalid");
  }
  const runId = requireString(root.run_id, "run_id");
  const generationKey = requireCanonicalGenerationKey(root.generation_key);
  const artifactId = requireString(root.artifact_id, "artifact_id", /^database-[0-9a-f]{64}$/);
  if (databaseArtifactId(generationKey) !== artifactId) {
    fail("BACKUP_V2_ARTIFACT_GENERATION_MISMATCH", "Manifest artifact ID is cross-generation");
  }
  const createdAt = requireIsoTimestamp(root.created_at, "created_at");

  const catalog = requireRecord(root.catalog, "catalog");
  requireExactKeys(catalog, ["fingerprint", "policy_version"], "catalog");
  const catalogFingerprint = requireSha256(catalog.fingerprint, "catalog.fingerprint");
  const catalogPolicyVersion = requireString(catalog.policy_version, "catalog.policy_version");

  const preflight = requireRecord(root.preflight, "preflight");
  requireExactKeys(preflight, ["snapshot_id", "outcome"], "preflight");
  const preflightSnapshotId = requireString(preflight.snapshot_id, "preflight.snapshot_id");
  if (preflight.outcome !== "go") fail("BACKUP_V2_PREFLIGHT_NOT_GO", "Artifact preflight is not authoritative");

  const exportValue = requireRecord(root.export, "export");
  requireExactKeys(exportValue, ["format", "format_version", "tool", "tool_version"], "export");
  if (exportValue.format !== DATABASE_EXPORT_FORMAT || exportValue.format_version !== DATABASE_EXPORT_FORMAT_VERSION) {
    fail("BACKUP_V2_UNKNOWN_EXPORT_FORMAT", "Unsupported database export format");
  }
  if (exportValue.tool !== "pg_dump") fail("BACKUP_V2_UNKNOWN_EXPORT_TOOL", "Unsupported export tool");
  const exportToolVersion = requireString(
    exportValue.tool_version, "export.tool_version", /^[A-Za-z0-9 ._()+-]{1,160}$/,
  );

  const compression = requireRecord(root.compression, "compression");
  requireExactKeys(compression, ["algorithm", "format_version", "level"], "compression");
  if (compression.algorithm !== DATABASE_COMPRESSION_ALGORITHM ||
      compression.format_version !== DATABASE_COMPRESSION_FORMAT_VERSION) {
    fail("BACKUP_V2_UNKNOWN_COMPRESSION_ALGORITHM", "Unsupported compression algorithm or version");
  }
  const compressionLevel = requireCompressionLevel(compression.level);

  const encryption = requireRecord(root.encryption, "encryption");
  requireExactKeys(encryption, [
    "algorithm", "format_version", "nonce_base64", "auth_tag_base64", "key_version", "key_reference",
    "key_fingerprint", "aad_sha256",
  ], "encryption");
  if (encryption.algorithm !== DATABASE_ENCRYPTION_ALGORITHM ||
      encryption.format_version !== DATABASE_ENCRYPTION_FORMAT_VERSION) {
    fail("BACKUP_V2_UNKNOWN_ENCRYPTION_ALGORITHM", "Unsupported encryption algorithm or version");
  }
  requireBase64Bytes(encryption.nonce_base64, "encryption.nonce_base64", DATABASE_NONCE_BYTES);
  requireBase64Bytes(encryption.auth_tag_base64, "encryption.auth_tag_base64", DATABASE_AUTH_TAG_BYTES);
  const keyVersion = requireString(encryption.key_version, "encryption.key_version");
  const keyReference = requireString(encryption.key_reference, "encryption.key_reference");
  const keyFingerprint = requireString(encryption.key_fingerprint, "encryption.key_fingerprint");
  const aadHash = requireSha256(encryption.aad_sha256, "encryption.aad_sha256");

  const byteCounts = requireRecord(root.byte_counts, "byte_counts");
  requireExactKeys(byteCounts, ["plaintext_export", "compressed", "encrypted_artifact"], "byte_counts");
  requireCanonicalBytes(byteCounts.plaintext_export, "byte_counts.plaintext_export");
  requireCanonicalBytes(byteCounts.compressed, "byte_counts.compressed");
  const encryptedArtifactBytes = requireCanonicalBytes(
    byteCounts.encrypted_artifact, "byte_counts.encrypted_artifact",
  );
  if (BigInt(encryptedArtifactBytes) < BigInt(DATABASE_ARTIFACT_MIN_BYTES)) {
    fail("BACKUP_V2_TRUNCATED_DATABASE_ARTIFACT", "Encrypted artifact byte count is below the format minimum");
  }

  const hashes = requireRecord(root.hashes, "hashes");
  requireExactKeys(hashes, ["algorithm", "plaintext_export", "compressed", "encrypted_artifact"], "hashes");
  if (hashes.algorithm !== DATABASE_HASH_ALGORITHM) {
    fail("BACKUP_V2_UNKNOWN_HASH_ALGORITHM", "Unsupported manifest hash algorithm");
  }
  requireSha256(hashes.plaintext_export, "hashes.plaintext_export");
  requireSha256(hashes.compressed, "hashes.compressed");
  requireSha256(hashes.encrypted_artifact, "hashes.encrypted_artifact");

  const artifact = requireRecord(root.artifact, "artifact");
  requireExactKeys(artifact, ["filename", "content_type"], "artifact");
  if (artifact.filename !== databaseArtifactFilename(artifactId) ||
      artifact.content_type !== DATABASE_ARTIFACT_CONTENT_TYPE) {
    fail("BACKUP_V2_INVALID_ARTIFACT_ID", "Manifest artifact filename or content type is invalid");
  }
  requireString(root.compatibility_ref, "compatibility_ref");

  const integrity = requireRecord(root.integrity, "integrity");
  requireExactKeys(integrity, ["manifest_sha256"], "integrity");
  const manifestHash = requireSha256(integrity.manifest_sha256, "integrity.manifest_sha256");
  const withoutIntegrity = { ...root };
  delete withoutIntegrity.integrity;
  if (sha256Hex(manifestHashPayload(withoutIntegrity as Omit<DatabaseArtifactManifest, "integrity">)) !== manifestHash) {
    fail("BACKUP_V2_MANIFEST_INTEGRITY_FAILED", "Manifest canonical hash does not match its content");
  }

  const aad = databaseArtifactAadBytes({
    runId,
    generationKey,
    artifactId,
    createdAt,
    catalogFingerprint,
    catalogPolicyVersion,
    preflightSnapshotId,
    keyVersion,
    keyReference,
    keyFingerprint,
    exportTool: "pg_dump",
    exportToolVersion,
    compressionLevel,
  });
  if (sha256Hex(aad) !== aadHash) {
    fail("BACKUP_V2_AAD_MISMATCH", "Manifest authenticated metadata is not canonical");
  }
  return root as unknown as DatabaseArtifactManifest;
}
