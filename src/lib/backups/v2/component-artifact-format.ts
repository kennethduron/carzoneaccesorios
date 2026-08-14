import "server-only";

import { timingSafeEqual } from "node:crypto";

import {
  DATABASE_AUTH_TAG_BYTES,
  DATABASE_BACKUP_VERSION,
  DATABASE_COMPRESSION_ALGORITHM,
  DATABASE_COMPRESSION_FORMAT_VERSION,
  DATABASE_ENCRYPTION_ALGORITHM,
  DATABASE_ENCRYPTION_FORMAT_VERSION,
  DATABASE_HASH_ALGORITHM,
  DATABASE_MANIFEST_VERSION,
  DATABASE_NONCE_BYTES,
  canonicalJson,
  requireCanonicalGenerationKey,
  sha256Hex,
} from "./database-artifact-format.ts";
import { BackupV2FailClosedError, type BackupV2Scope } from "./types.ts";

export const COMPONENT_BACKUP_VERSION = "phase4b3" as const;
export const COMPONENT_PAYLOAD_FORMAT = "car-zone-record-stream" as const;
export const COMPONENT_PAYLOAD_VERSION = "car-zone-record-stream-v1" as const;
export const COMPONENT_ARTIFACT_MAGIC = Buffer.from("CZB2CP01", "ascii");
export const COMPONENT_PAYLOAD_MAGIC = "CZB2-RECORDS-V1";
export const COMPONENT_CONTENT_TYPE = "application/vnd.car-zone.backup-v2.component" as const;
export const BACKUP_V2_COMPONENT_SCOPES = [
  "auth", "storage_metadata", "storage_objects", "external_assets",
] as const satisfies readonly BackupV2Scope[];
export type BackupV2ComponentScope = (typeof BACKUP_V2_COMPONENT_SCOPES)[number];

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE = /^[A-Za-z0-9._:@/-]{1,200}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

export interface ComponentArtifactAadInput {
  runId: string;
  generationKey: string;
  artifactId: string;
  component: BackupV2ComponentScope;
  createdAt: string;
  catalogFingerprint: string;
  catalogPolicyVersion: string;
  preflightSnapshotId: string;
  sourceSnapshotId: string;
  inventoryFingerprint: string;
  bindingFingerprint: string | null;
  keyVersion: string;
  keyReference: string;
  keyFingerprint: string;
  compressionLevel: number;
}

export interface ComponentArtifactManifest {
  manifest_version: typeof DATABASE_MANIFEST_VERSION;
  backup_v2_version: typeof DATABASE_BACKUP_VERSION;
  phase: typeof COMPONENT_BACKUP_VERSION;
  run_id: string;
  generation_key: string;
  artifact_id: string;
  component: BackupV2ComponentScope;
  created_at: string;
  catalog: { fingerprint: string; policy_version: string };
  preflight: { snapshot_id: string; outcome: "go" };
  payload: {
    format: typeof COMPONENT_PAYLOAD_FORMAT;
    format_version: typeof COMPONENT_PAYLOAD_VERSION;
    source_snapshot_id: string;
    inventory_fingerprint: string;
    binding_fingerprint: string | null;
    record_count: string;
    body_bytes: string;
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
  byte_counts: { plaintext_export: string; compressed: string; encrypted_artifact: string };
  hashes: {
    algorithm: typeof DATABASE_HASH_ALGORITHM;
    plaintext_export: string;
    compressed: string;
    encrypted_artifact: string;
  };
  artifact: { filename: string; content_type: typeof COMPONENT_CONTENT_TYPE };
  compatibility_ref: string;
  integrity: { manifest_sha256: string };
}

export interface CreateComponentArtifactManifestInput extends ComponentArtifactAadInput {
  nonce: Uint8Array;
  authTag: Uint8Array;
  recordCount: bigint;
  bodyBytes: bigint;
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

function component(value: unknown): BackupV2ComponentScope {
  if (!BACKUP_V2_COMPONENT_SCOPES.includes(value as BackupV2ComponentScope)) {
    fail("BACKUP_V2_UNKNOWN_COMPONENT", "Unsupported Phase 4B.3 component");
  }
  return value as BackupV2ComponentScope;
}

function safe(value: unknown, field: string): string {
  if (typeof value !== "string" || !SAFE.test(value)) fail("BACKUP_V2_INVALID_COMPONENT_MANIFEST", `${field} is invalid`);
  return value;
}

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail("BACKUP_V2_INVALID_COMPONENT_MANIFEST", `${field} is invalid`);
  return value;
}

function decimal(value: unknown, field: string): string {
  if (typeof value !== "string" || !DECIMAL.test(value)) fail("BACKUP_V2_INVALID_COMPONENT_MANIFEST", `${field} is invalid`);
  return value;
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail("BACKUP_V2_INVALID_COMPONENT_MANIFEST", "created_at is not canonical ISO");
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail("BACKUP_V2_INVALID_COMPONENT_MANIFEST", `${field} contains missing or unknown fields`);
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("BACKUP_V2_INVALID_COMPONENT_MANIFEST", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function componentArtifactId(scopeValue: BackupV2ComponentScope, generationValue: string): string {
  const scope = component(scopeValue);
  const generation = requireCanonicalGenerationKey(generationValue);
  return `${scope}-${sha256Hex(`backup-v2-component-artifact-v1\n${scope}\n${generation}`)}`;
}

export function componentFilename(scope: BackupV2ComponentScope, artifactId: string): string {
  component(scope);
  if (!new RegExp(`^${scope}-[0-9a-f]{64}$`).test(artifactId)) fail("BACKUP_V2_INVALID_ARTIFACT_ID", "Invalid component artifact ID");
  return `${artifactId}.czb2`;
}

export function componentArtifactAadBytes(input: ComponentArtifactAadInput): Buffer {
  const scope = component(input.component);
  safe(input.runId, "run_id");
  requireCanonicalGenerationKey(input.generationKey);
  if (componentArtifactId(scope, input.generationKey) !== input.artifactId) fail("BACKUP_V2_ARTIFACT_GENERATION_MISMATCH", "Cross-generation component artifact");
  timestamp(input.createdAt);
  hash(input.catalogFingerprint, "catalog.fingerprint");
  safe(input.catalogPolicyVersion, "catalog.policy_version");
  safe(input.preflightSnapshotId, "preflight.snapshot_id");
  safe(input.sourceSnapshotId, "payload.source_snapshot_id");
  hash(input.inventoryFingerprint, "payload.inventory_fingerprint");
  if (input.bindingFingerprint !== null) hash(input.bindingFingerprint, "payload.binding_fingerprint");
  safe(input.keyVersion, "encryption.key_version");
  safe(input.keyReference, "encryption.key_reference");
  hash(input.keyFingerprint, "encryption.key_fingerprint");
  if (!Number.isSafeInteger(input.compressionLevel) || input.compressionLevel < 1 || input.compressionLevel > 9) fail("BACKUP_V2_INVALID_COMPRESSION_LEVEL", "Invalid compression level");
  return Buffer.from(canonicalJson({
    artifact_id: input.artifactId,
    backup_v2_version: DATABASE_BACKUP_VERSION,
    binding_fingerprint: input.bindingFingerprint,
    catalog_fingerprint: input.catalogFingerprint,
    catalog_policy_version: input.catalogPolicyVersion,
    component: scope,
    compression_algorithm: DATABASE_COMPRESSION_ALGORITHM,
    compression_format_version: DATABASE_COMPRESSION_FORMAT_VERSION,
    compression_level: input.compressionLevel,
    created_at: input.createdAt,
    encryption_algorithm: DATABASE_ENCRYPTION_ALGORITHM,
    encryption_format_version: DATABASE_ENCRYPTION_FORMAT_VERSION,
    generation_key: input.generationKey,
    inventory_fingerprint: input.inventoryFingerprint,
    key_fingerprint: input.keyFingerprint,
    key_reference: input.keyReference,
    key_version: input.keyVersion,
    manifest_version: DATABASE_MANIFEST_VERSION,
    payload_format: COMPONENT_PAYLOAD_FORMAT,
    payload_format_version: COMPONENT_PAYLOAD_VERSION,
    phase: COMPONENT_BACKUP_VERSION,
    preflight_outcome: "go",
    preflight_snapshot_id: input.preflightSnapshotId,
    run_id: input.runId,
    source_snapshot_id: input.sourceSnapshotId,
  }), "utf8");
}

export function createComponentArtifactManifest(input: CreateComponentArtifactManifestInput): ComponentArtifactManifest {
  const aad = componentArtifactAadBytes(input);
  if (input.nonce.byteLength !== DATABASE_NONCE_BYTES || input.authTag.byteLength !== DATABASE_AUTH_TAG_BYTES) fail("BACKUP_V2_INVALID_ENCRYPTION_METADATA", "Invalid AES-GCM envelope metadata");
  for (const [name, value] of [["plaintext", input.plaintextHash], ["compressed", input.compressedHash], ["encrypted", input.encryptedArtifactHash]] as const) hash(value, name);
  const withoutIntegrity: Omit<ComponentArtifactManifest, "integrity"> = {
    manifest_version: DATABASE_MANIFEST_VERSION,
    backup_v2_version: DATABASE_BACKUP_VERSION,
    phase: COMPONENT_BACKUP_VERSION,
    run_id: input.runId,
    generation_key: input.generationKey,
    artifact_id: input.artifactId,
    component: input.component,
    created_at: input.createdAt,
    catalog: { fingerprint: input.catalogFingerprint, policy_version: input.catalogPolicyVersion },
    preflight: { snapshot_id: input.preflightSnapshotId, outcome: "go" },
    payload: {
      format: COMPONENT_PAYLOAD_FORMAT,
      format_version: COMPONENT_PAYLOAD_VERSION,
      source_snapshot_id: input.sourceSnapshotId,
      inventory_fingerprint: input.inventoryFingerprint,
      binding_fingerprint: input.bindingFingerprint,
      record_count: input.recordCount.toString(),
      body_bytes: input.bodyBytes.toString(),
    },
    compression: { algorithm: DATABASE_COMPRESSION_ALGORITHM, format_version: DATABASE_COMPRESSION_FORMAT_VERSION, level: input.compressionLevel },
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
    byte_counts: { plaintext_export: input.plaintextBytes.toString(), compressed: input.compressedBytes.toString(), encrypted_artifact: input.encryptedArtifactBytes.toString() },
    hashes: { algorithm: DATABASE_HASH_ALGORITHM, plaintext_export: input.plaintextHash, compressed: input.compressedHash, encrypted_artifact: input.encryptedArtifactHash },
    artifact: { filename: componentFilename(input.component, input.artifactId), content_type: COMPONENT_CONTENT_TYPE },
    compatibility_ref: input.compatibilityRef,
  };
  return { ...withoutIntegrity, integrity: { manifest_sha256: sha256Hex(canonicalJson(withoutIntegrity)) } };
}

export function serializeComponentArtifactManifest(manifest: ComponentArtifactManifest): string {
  validateComponentArtifactManifest(manifest);
  return `${canonicalJson(manifest)}\n`;
}

export function parseComponentArtifactManifest(value: string): ComponentArtifactManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { fail("BACKUP_V2_INVALID_COMPONENT_MANIFEST", "Manifest is not JSON"); }
  const manifest = validateComponentArtifactManifest(parsed);
  if (value !== `${canonicalJson(manifest)}\n`) fail("BACKUP_V2_NON_CANONICAL_MANIFEST", "Manifest bytes are not canonical");
  return manifest;
}

export function validateComponentArtifactManifest(value: unknown): ComponentArtifactManifest {
  const root = record(value, "manifest");
  exactKeys(root, ["manifest_version", "backup_v2_version", "phase", "run_id", "generation_key", "artifact_id", "component", "created_at", "catalog", "preflight", "payload", "compression", "encryption", "byte_counts", "hashes", "artifact", "compatibility_ref", "integrity"], "manifest");
  if (root.manifest_version !== DATABASE_MANIFEST_VERSION || root.backup_v2_version !== DATABASE_BACKUP_VERSION || root.phase !== COMPONENT_BACKUP_VERSION) fail("BACKUP_V2_UNKNOWN_MANIFEST_VERSION", "Unsupported component manifest version");
  const scope = component(root.component);
  const generationKey = requireCanonicalGenerationKey(root.generation_key);
  const artifactId = safe(root.artifact_id, "artifact_id");
  if (componentArtifactId(scope, generationKey) !== artifactId) fail("BACKUP_V2_ARTIFACT_GENERATION_MISMATCH", "Cross-generation component manifest");
  const catalog = record(root.catalog, "catalog"); exactKeys(catalog, ["fingerprint", "policy_version"], "catalog");
  const preflight = record(root.preflight, "preflight"); exactKeys(preflight, ["snapshot_id", "outcome"], "preflight");
  const payload = record(root.payload, "payload"); exactKeys(payload, ["format", "format_version", "source_snapshot_id", "inventory_fingerprint", "binding_fingerprint", "record_count", "body_bytes"], "payload");
  const compression = record(root.compression, "compression"); exactKeys(compression, ["algorithm", "format_version", "level"], "compression");
  const encryption = record(root.encryption, "encryption"); exactKeys(encryption, ["algorithm", "format_version", "nonce_base64", "auth_tag_base64", "key_version", "key_reference", "key_fingerprint", "aad_sha256"], "encryption");
  const counts = record(root.byte_counts, "byte_counts"); exactKeys(counts, ["plaintext_export", "compressed", "encrypted_artifact"], "byte_counts");
  const hashes = record(root.hashes, "hashes"); exactKeys(hashes, ["algorithm", "plaintext_export", "compressed", "encrypted_artifact"], "hashes");
  const artifact = record(root.artifact, "artifact"); exactKeys(artifact, ["filename", "content_type"], "artifact");
  const integrity = record(root.integrity, "integrity"); exactKeys(integrity, ["manifest_sha256"], "integrity");
  const runId = safe(root.run_id, "run_id"); timestamp(root.created_at);
  hash(catalog.fingerprint, "catalog.fingerprint"); safe(catalog.policy_version, "catalog.policy_version");
  if (preflight.outcome !== "go") fail("BACKUP_V2_PREFLIGHT_NOT_GO", "Manifest preflight is not go"); safe(preflight.snapshot_id, "preflight.snapshot_id");
  if (payload.format !== COMPONENT_PAYLOAD_FORMAT || payload.format_version !== COMPONENT_PAYLOAD_VERSION) fail("BACKUP_V2_UNKNOWN_EXPORT_FORMAT", "Unknown component payload format");
  safe(payload.source_snapshot_id, "payload.source_snapshot_id"); hash(payload.inventory_fingerprint, "payload.inventory_fingerprint");
  if (payload.binding_fingerprint !== null) hash(payload.binding_fingerprint, "payload.binding_fingerprint");
  decimal(payload.record_count, "payload.record_count"); decimal(payload.body_bytes, "payload.body_bytes");
  if (compression.algorithm !== DATABASE_COMPRESSION_ALGORITHM || compression.format_version !== DATABASE_COMPRESSION_FORMAT_VERSION || !Number.isSafeInteger(compression.level) || (compression.level as number) < 1 || (compression.level as number) > 9) fail("BACKUP_V2_UNKNOWN_COMPRESSION_ALGORITHM", "Invalid compression contract");
  if (encryption.algorithm !== DATABASE_ENCRYPTION_ALGORITHM || encryption.format_version !== DATABASE_ENCRYPTION_FORMAT_VERSION) fail("BACKUP_V2_UNKNOWN_ENCRYPTION_ALGORITHM", "Invalid encryption contract");
  const nonce = Buffer.from(String(encryption.nonce_base64), "base64"); const tag = Buffer.from(String(encryption.auth_tag_base64), "base64");
  if (nonce.length !== DATABASE_NONCE_BYTES || nonce.toString("base64") !== encryption.nonce_base64 || tag.length !== DATABASE_AUTH_TAG_BYTES || tag.toString("base64") !== encryption.auth_tag_base64) fail("BACKUP_V2_INVALID_ENCRYPTION_METADATA", "Invalid envelope metadata");
  safe(encryption.key_version, "encryption.key_version"); safe(encryption.key_reference, "encryption.key_reference"); hash(encryption.key_fingerprint, "encryption.key_fingerprint"); hash(encryption.aad_sha256, "encryption.aad_sha256");
  decimal(counts.plaintext_export, "byte_counts.plaintext_export"); decimal(counts.compressed, "byte_counts.compressed"); decimal(counts.encrypted_artifact, "byte_counts.encrypted_artifact");
  if (hashes.algorithm !== DATABASE_HASH_ALGORITHM) fail("BACKUP_V2_UNKNOWN_HASH_ALGORITHM", "Invalid hash algorithm"); hash(hashes.plaintext_export, "hashes.plaintext_export"); hash(hashes.compressed, "hashes.compressed"); hash(hashes.encrypted_artifact, "hashes.encrypted_artifact");
  if (artifact.filename !== componentFilename(scope, artifactId) || artifact.content_type !== COMPONENT_CONTENT_TYPE) fail("BACKUP_V2_INVALID_ARTIFACT_ID", "Invalid artifact filename or type");
  safe(root.compatibility_ref, "compatibility_ref");
  const integrityHash = hash(integrity.manifest_sha256, "integrity.manifest_sha256"); const copy = { ...root }; delete copy.integrity;
  if (!timingSafeEqual(Buffer.from(integrityHash, "hex"), Buffer.from(sha256Hex(canonicalJson(copy)), "hex"))) fail("BACKUP_V2_MANIFEST_INTEGRITY_FAILED", "Manifest hash mismatch");
  const aad = componentArtifactAadBytes({
    runId, generationKey, artifactId, component: scope, createdAt: root.created_at as string,
    catalogFingerprint: catalog.fingerprint as string, catalogPolicyVersion: catalog.policy_version as string,
    preflightSnapshotId: preflight.snapshot_id as string, sourceSnapshotId: payload.source_snapshot_id as string,
    inventoryFingerprint: payload.inventory_fingerprint as string, bindingFingerprint: payload.binding_fingerprint as string | null,
    keyVersion: encryption.key_version as string, keyReference: encryption.key_reference as string,
    keyFingerprint: encryption.key_fingerprint as string, compressionLevel: compression.level as number,
  });
  if (sha256Hex(aad) !== encryption.aad_sha256) fail("BACKUP_V2_AAD_MISMATCH", "Authenticated metadata mismatch");
  return root as unknown as ComponentArtifactManifest;
}
