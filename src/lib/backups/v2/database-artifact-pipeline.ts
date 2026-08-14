import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
  type CipherGCM,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { Transform, Writable, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import { validateArtifactEvidence, type ValidatedBackupArtifactEvidence } from "./artifact.ts";
import {
  DATABASE_ARTIFACT_HEADER_BYTES,
  DATABASE_ARTIFACT_MAGIC,
  DATABASE_ARTIFACT_MIN_BYTES,
  DATABASE_AUTH_TAG_BYTES,
  DATABASE_NONCE_BYTES,
  createDatabaseArtifactManifest,
  databaseArtifactAadBytes,
  parseDatabaseArtifactManifest,
  serializeDatabaseArtifactManifest,
  sha256Hex,
  type DatabaseArtifactManifest,
} from "./database-artifact-format.ts";
import {
  cleanupPartialDatabaseArtifact,
  createPartialDatabaseArtifactPaths,
  finalDatabaseArtifactExists,
  hardenArtifactFile,
  publishPartialDatabaseArtifact,
  resolveDatabaseArtifactPaths,
  type DatabaseArtifactPaths,
  type PartialDatabaseArtifactPaths,
} from "./database-artifact-storage.ts";
import type { DatabaseExporter } from "./database-exporter.ts";
import { assertLeaseAuthority, type BackupV2Lease } from "./lease.ts";
import {
  BackupV2FailClosedError,
  requireBackupV2State,
  type BackupV2State,
} from "./types.ts";

const DEFAULT_MAX_PLAINTEXT_BYTES = BigInt("1099511627776");
const DEFAULT_MAX_COMPRESSION_RATIO = 200;
const MAX_MANIFEST_BYTES = 65_536;
const POSTGRES_CUSTOM_MAGIC = Buffer.from("PGDMP", "ascii");

export type DatabaseArtifactPipelineStage =
  | "authority_start"
  | "compression_start"
  | "encryption_start"
  | "export_start"
  | "stream_complete"
  | "manifest_write"
  | "runtime_verify"
  | "authority_finalize"
  | "publish";

export interface DatabaseArtifactAuthorityEvidence {
  runId: string;
  generationKey: string;
  state: BackupV2State;
  preflightOutcome: "go" | "blocked" | "review_required";
  preflightSnapshotId: string;
  catalogFingerprint: string;
  catalogPolicyVersion: string;
  lease: BackupV2Lease;
}

export interface DatabaseArtifactAuthority {
  read: () => Promise<DatabaseArtifactAuthorityEvidence>;
}

export interface DatabaseArtifactExpectedIdentity {
  runId: string;
  generationKey: string;
  artifactId: string;
  catalogFingerprint: string;
  preflightSnapshotId: string;
}

export interface RunDatabaseArtifactPipelineInput {
  workspaceRoot: string;
  recoverySetId: string;
  ownerRef: string;
  leaseGeneration: number;
  authority: DatabaseArtifactAuthority;
  exporter: DatabaseExporter;
  encryptionKey: Uint8Array;
  keyVersion: string;
  keyReference: string;
  compatibilityRef: string;
  compressionLevel?: number;
  maxPlaintextBytes?: bigint;
  maxCompressionRatio?: number;
  signal?: AbortSignal;
  clock?: () => string;
  stageHook?: (stage: DatabaseArtifactPipelineStage) => void | Promise<void>;
}

export interface DatabaseArtifactPipelineResult {
  paths: DatabaseArtifactPaths;
  manifest: DatabaseArtifactManifest;
  evidence: ValidatedBackupArtifactEvidence;
  reusedCanonicalArtifact: boolean;
}

export interface VerifyDatabaseArtifactInput {
  artifactPath: string;
  manifestPath: string;
  encryptionKey: Uint8Array;
  expected: DatabaseArtifactExpectedIdentity;
  maxPlaintextBytes?: bigint;
  maxCompressionRatio?: number;
}

export interface VerifiedDatabaseArtifact {
  manifest: DatabaseArtifactManifest;
  plaintextBytes: bigint;
  compressedBytes: bigint;
  encryptedArtifactBytes: bigint;
}

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

function toBuffer(chunk: Buffer | string, encoding: BufferEncoding): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
}

class HashMeter extends Transform {
  #bytes = BigInt(0);
  readonly #hash = createHash("sha256");
  #digest: string | null = null;

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    const value = toBuffer(chunk, encoding);
    this.#bytes += BigInt(value.byteLength);
    this.#hash.update(value);
    callback(null, value);
  }

  get bytes(): bigint {
    return this.#bytes;
  }

  digest(): string {
    if (this.#digest === null) this.#digest = this.#hash.digest("hex");
    return this.#digest;
  }
}

class GcmEnvelopeTransform extends Transform {
  readonly #cipher: CipherGCM;
  readonly #nonce: Buffer;
  #headerWritten = false;
  #authTag: Buffer | null = null;

  constructor(cipher: CipherGCM, nonce: Buffer) {
    super();
    this.#cipher = cipher;
    this.#nonce = nonce;
  }

  #writeHeader(): void {
    if (this.#headerWritten) return;
    this.push(Buffer.concat([DATABASE_ARTIFACT_MAGIC, this.#nonce]));
    this.#headerWritten = true;
  }

  override _transform(chunk: Buffer | string, encoding: BufferEncoding, callback: TransformCallback): void {
    this.#writeHeader();
    callback(null, toBuffer(chunk, encoding));
  }

  override _flush(callback: TransformCallback): void {
    try {
      this.#writeHeader();
      this.#authTag = this.#cipher.getAuthTag();
      this.push(this.#authTag);
      callback();
    } catch {
      callback(new BackupV2FailClosedError(
        "BACKUP_V2_ENCRYPTION_FAILED", "AES-GCM authentication tag could not be finalized",
      ));
    }
  }

  authTag(): Buffer {
    if (this.#authTag === null) fail("BACKUP_V2_ENCRYPTION_FAILED", "AES-GCM authentication tag is unavailable");
    return Buffer.from(this.#authTag);
  }
}

class LimitedPostgresDumpSink extends Writable {
  readonly #maxBytes: bigint;
  #bytes = BigInt(0);
  #prefix = Buffer.alloc(0);

  constructor(maxBytes: bigint) {
    super();
    this.#maxBytes = maxBytes;
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const value = toBuffer(chunk, encoding);
    this.#bytes += BigInt(value.byteLength);
    if (this.#bytes > this.#maxBytes) {
      callback(new BackupV2FailClosedError(
        "BACKUP_V2_DECOMPRESSION_LIMIT_EXCEEDED", "Decompressed export exceeded its configured byte limit",
      ));
      return;
    }
    if (this.#prefix.length < POSTGRES_CUSTOM_MAGIC.length) {
      const remaining = POSTGRES_CUSTOM_MAGIC.length - this.#prefix.length;
      this.#prefix = Buffer.concat([this.#prefix, value.subarray(0, remaining)]);
    }
    callback();
  }

  assertValid(): void {
    if (this.#bytes === BigInt(0) || !this.#prefix.equals(POSTGRES_CUSTOM_MAGIC)) {
      fail("BACKUP_V2_INVALID_POSTGRES_EXPORT", "Decrypted export is empty or not a PostgreSQL custom archive");
    }
  }
}

function requireEncryptionKey(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    fail("BACKUP_V2_INVALID_ENCRYPTION_KEY", "AES-256-GCM requires exactly 32 key bytes");
  }
  return Buffer.from(value);
}

function requireCompressionLevel(value: number | undefined): number {
  const resolved = value ?? 9;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 9) {
    fail("BACKUP_V2_INVALID_COMPRESSION_LEVEL", "Compression level must be an integer from 1 through 9");
  }
  return resolved;
}

function requirePlaintextLimit(value: bigint | undefined): bigint {
  const resolved = value ?? DEFAULT_MAX_PLAINTEXT_BYTES;
  if (typeof resolved !== "bigint" || resolved <= BigInt(0)) {
    fail("BACKUP_V2_INVALID_RESOURCE_LIMIT", "Plaintext byte limit must be a positive bigint");
  }
  return resolved;
}

function requireCompressionRatio(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_COMPRESSION_RATIO;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 10_000) {
    fail("BACKUP_V2_INVALID_RESOURCE_LIMIT", "Compression ratio limit is invalid");
  }
  return resolved;
}

function requireIsoClock(clock: (() => string) | undefined): () => string {
  const source = clock ?? (() => new Date().toISOString());
  return () => {
    const value = source();
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
      fail("BACKUP_V2_INVALID_CLOCK", "Pipeline clock did not return a canonical ISO timestamp");
    }
    return value;
  };
}

function assertExporterContract(exporter: DatabaseExporter): void {
  if (exporter.tool !== "pg_dump" || exporter.format !== "postgresql_custom" ||
      typeof exporter.toolVersion !== "string" ||
      !/^pg_dump \(PostgreSQL\) [A-Za-z0-9._+-]+$/.test(exporter.toolVersion)) {
    fail("BACKUP_V2_UNKNOWN_EXPORT_FORMAT", "Database exporter contract is unsupported");
  }
}

async function runStage(
  hook: RunDatabaseArtifactPipelineInput["stageHook"],
  stage: DatabaseArtifactPipelineStage,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(stage);
  } catch {
    fail("BACKUP_V2_PIPELINE_STAGE_FAILED", `Database artifact pipeline failed at ${stage}`);
  }
}

async function assertExecutionAuthority(
  input: RunDatabaseArtifactPipelineInput,
  now: string,
  allowedStates: readonly BackupV2State[],
): Promise<DatabaseArtifactAuthorityEvidence> {
  const evidence = await input.authority.read();
  const state = requireBackupV2State(evidence.state);
  if (evidence.preflightOutcome !== "go") fail("BACKUP_V2_PREFLIGHT_NOT_GO", "Database export preflight is not go");
  if (!allowedStates.includes(state)) {
    fail("BACKUP_V2_RUN_NOT_EXECUTABLE", "Database artifact run is not executable");
  }
  if (typeof evidence.runId !== "string" || evidence.runId.trim().length === 0 ||
      typeof evidence.preflightSnapshotId !== "string" || evidence.preflightSnapshotId.trim().length === 0 ||
      !/^[0-9a-f]{64}$/.test(evidence.catalogFingerprint) ||
      typeof evidence.catalogPolicyVersion !== "string" || evidence.catalogPolicyVersion.trim().length === 0) {
    fail("BACKUP_V2_INVALID_EXECUTION_AUTHORITY", "Execution authority is incomplete");
  }
  assertLeaseAuthority(evidence.lease, input.ownerRef, input.leaseGeneration, now);
  return evidence;
}

function assertSameAuthority(
  initial: DatabaseArtifactAuthorityEvidence,
  current: DatabaseArtifactAuthorityEvidence,
): void {
  if (initial.runId !== current.runId || initial.generationKey !== current.generationKey ||
      initial.preflightSnapshotId !== current.preflightSnapshotId ||
      initial.catalogFingerprint !== current.catalogFingerprint ||
      initial.catalogPolicyVersion !== current.catalogPolicyVersion) {
    fail("BACKUP_V2_EXECUTION_AUTHORITY_CHANGED", "Run, generation, catalog, or preflight binding changed");
  }
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

async function assertRegularArtifactFile(filePath: string, label: string): Promise<bigint> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("BACKUP_V2_UNSAFE_ARTIFACT_FILE", `${label} is not a regular file`);
  }
  return BigInt(stat.size);
}

async function hashFile(filePath: string): Promise<{ bytes: bigint; hash: string }> {
  const meter = new HashMeter();
  await pipeline(createReadStream(filePath), meter, new Writable({
    write(_chunk, _encoding, callback) { callback(); },
  }));
  return { bytes: meter.bytes, hash: meter.digest() };
}

async function readArtifactEnvelope(filePath: string, size: bigint): Promise<{ nonce: Buffer; authTag: Buffer }> {
  if (size < BigInt(DATABASE_ARTIFACT_MIN_BYTES) || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("BACKUP_V2_TRUNCATED_DATABASE_ARTIFACT", "Encrypted artifact size is invalid");
  }
  const handle = await open(filePath, "r");
  try {
    const header = Buffer.alloc(DATABASE_ARTIFACT_HEADER_BYTES);
    const headerRead = await handle.read(header, 0, header.length, 0);
    const authTag = Buffer.alloc(DATABASE_AUTH_TAG_BYTES);
    const tagPosition = Number(size - BigInt(DATABASE_AUTH_TAG_BYTES));
    const tagRead = await handle.read(authTag, 0, authTag.length, tagPosition);
    if (headerRead.bytesRead !== header.length || tagRead.bytesRead !== authTag.length ||
        !header.subarray(0, DATABASE_ARTIFACT_MAGIC.length).equals(DATABASE_ARTIFACT_MAGIC)) {
      fail("BACKUP_V2_TRUNCATED_DATABASE_ARTIFACT", "Encrypted artifact header or tag is invalid");
    }
    return { nonce: header.subarray(DATABASE_ARTIFACT_MAGIC.length), authTag };
  } finally {
    await handle.close();
  }
}

function assertExpectedIdentity(
  manifest: DatabaseArtifactManifest,
  expected: DatabaseArtifactExpectedIdentity,
): void {
  if (manifest.run_id !== expected.runId || manifest.generation_key !== expected.generationKey ||
      manifest.artifact_id !== expected.artifactId || manifest.catalog.fingerprint !== expected.catalogFingerprint ||
      manifest.preflight.snapshot_id !== expected.preflightSnapshotId) {
    fail("BACKUP_V2_DATABASE_ARTIFACT_IDENTITY_MISMATCH", "Artifact does not match expected execution identity");
  }
}

export async function verifyDatabaseArtifact(
  input: VerifyDatabaseArtifactInput,
): Promise<VerifiedDatabaseArtifact> {
  const key = requireEncryptionKey(input.encryptionKey);
  try {
    const manifestSize = await assertRegularArtifactFile(input.manifestPath, "Manifest");
    if (manifestSize <= BigInt(0) || manifestSize > BigInt(MAX_MANIFEST_BYTES)) {
      fail("BACKUP_V2_INVALID_DATABASE_MANIFEST", "Manifest size is outside the supported limit");
    }
    const manifest = parseDatabaseArtifactManifest(await readFile(input.manifestPath, "utf8"));
    assertExpectedIdentity(manifest, input.expected);
    if (!safeEqualHex(manifest.encryption.key_fingerprint, sha256Hex(key))) {
      fail("BACKUP_V2_WRONG_ENCRYPTION_KEY", "Encryption key fingerprint does not match the manifest");
    }

    const artifactSize = await assertRegularArtifactFile(input.artifactPath, "Encrypted artifact");
    const measuredArtifact = await hashFile(input.artifactPath);
    if (measuredArtifact.bytes.toString() !== manifest.byte_counts.encrypted_artifact ||
        !safeEqualHex(measuredArtifact.hash, manifest.hashes.encrypted_artifact)) {
      fail("BACKUP_V2_ENCRYPTED_ARTIFACT_INTEGRITY_FAILED", "Encrypted artifact bytes or hash do not match");
    }
    const envelope = await readArtifactEnvelope(input.artifactPath, artifactSize);
    const manifestNonce = Buffer.from(manifest.encryption.nonce_base64, "base64");
    const manifestTag = Buffer.from(manifest.encryption.auth_tag_base64, "base64");
    if (!timingSafeEqual(envelope.nonce, manifestNonce) || !timingSafeEqual(envelope.authTag, manifestTag)) {
      fail("BACKUP_V2_ENCRYPTION_METADATA_MISMATCH", "Artifact envelope does not match manifest encryption metadata");
    }

    const aad = databaseArtifactAadBytes({
      runId: manifest.run_id,
      generationKey: manifest.generation_key,
      artifactId: manifest.artifact_id,
      createdAt: manifest.created_at,
      catalogFingerprint: manifest.catalog.fingerprint,
      catalogPolicyVersion: manifest.catalog.policy_version,
      preflightSnapshotId: manifest.preflight.snapshot_id,
      keyVersion: manifest.encryption.key_version,
      keyReference: manifest.encryption.key_reference,
      keyFingerprint: manifest.encryption.key_fingerprint,
      exportTool: manifest.export.tool,
      exportToolVersion: manifest.export.tool_version,
      compressionLevel: manifest.compression.level,
    });
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, { authTagLength: DATABASE_AUTH_TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(envelope.authTag);
    const compressedMeter = new HashMeter();
    const plaintextMeter = new HashMeter();
    const plaintextLimit = requirePlaintextLimit(input.maxPlaintextBytes);
    const sink = new LimitedPostgresDumpSink(plaintextLimit);
    const ciphertextEnd = Number(artifactSize - BigInt(DATABASE_AUTH_TAG_BYTES) - BigInt(1));
    try {
      await pipeline(
        createReadStream(input.artifactPath, { start: DATABASE_ARTIFACT_HEADER_BYTES, end: ciphertextEnd }),
        decipher,
        compressedMeter,
        createGunzip(),
        plaintextMeter,
        sink,
      );
    } catch (error) {
      if (error instanceof BackupV2FailClosedError) throw error;
      fail("BACKUP_V2_DECRYPTION_OR_COMPRESSION_FAILED", "Artifact authentication or decompression failed");
    }
    sink.assertValid();
    const maxRatio = requireCompressionRatio(input.maxCompressionRatio);
    if (compressedMeter.bytes === BigInt(0) || plaintextMeter.bytes > compressedMeter.bytes * BigInt(maxRatio)) {
      fail("BACKUP_V2_DECOMPRESSION_RATIO_EXCEEDED", "Decompressed export exceeded its compression ratio limit");
    }
    if (plaintextMeter.bytes.toString() !== manifest.byte_counts.plaintext_export ||
        compressedMeter.bytes.toString() !== manifest.byte_counts.compressed ||
        !safeEqualHex(plaintextMeter.digest(), manifest.hashes.plaintext_export) ||
        !safeEqualHex(compressedMeter.digest(), manifest.hashes.compressed)) {
      fail("BACKUP_V2_INNER_ARTIFACT_INTEGRITY_FAILED", "Decrypted export bytes or hashes do not match");
    }
    return {
      manifest,
      plaintextBytes: plaintextMeter.bytes,
      compressedBytes: compressedMeter.bytes,
      encryptedArtifactBytes: artifactSize,
    };
  } finally {
    key.fill(0);
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeManifestFile(filePath: string, manifest: DatabaseArtifactManifest): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(serializeDatabaseArtifactManifest(manifest), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await hardenArtifactFile(filePath);
}

function buildArtifactEvidence(
  manifest: DatabaseArtifactManifest,
  input: RunDatabaseArtifactPipelineInput,
  verifiedAt: string,
): ValidatedBackupArtifactEvidence {
  return validateArtifactEvidence({
    artifactId: manifest.artifact_id,
    recoverySetId: input.recoverySetId,
    runId: manifest.run_id,
    generationKey: manifest.generation_key,
    component: "database",
    createdByOwnerRef: input.ownerRef,
    leaseGeneration: input.leaseGeneration,
    formatVersion: manifest.export.format_version,
    artifactVersion: manifest.encryption.format_version,
    artifactSizeBytes: manifest.byte_counts.encrypted_artifact,
    plaintextSizeBytes: manifest.byte_counts.plaintext_export,
    ciphertextSizeBytes: manifest.byte_counts.encrypted_artifact,
    hashAlgorithm: manifest.hashes.algorithm,
    plaintextHash: manifest.hashes.plaintext_export,
    ciphertextHash: manifest.hashes.encrypted_artifact,
    encryptionAlgorithm: manifest.encryption.algorithm,
    keyVersion: manifest.encryption.key_version,
    keyReference: manifest.encryption.key_reference,
    keyFingerprint: manifest.encryption.key_fingerprint,
    createdAt: manifest.created_at,
    verifiedAt,
    verificationStatus: "verified",
    evidenceOrigin: "runtime_verified",
    compatibilityRef: manifest.compatibility_ref,
  });
}

async function verifiedExistingResult(
  paths: DatabaseArtifactPaths,
  authority: DatabaseArtifactAuthorityEvidence,
  input: RunDatabaseArtifactPipelineInput,
  clock: () => string,
): Promise<DatabaseArtifactPipelineResult> {
  const verified = await verifyDatabaseArtifact({
    artifactPath: paths.artifactPath,
    manifestPath: paths.manifestPath,
    encryptionKey: input.encryptionKey,
    expected: {
      runId: authority.runId,
      generationKey: authority.generationKey,
      artifactId: paths.artifactId,
      catalogFingerprint: authority.catalogFingerprint,
      preflightSnapshotId: authority.preflightSnapshotId,
    },
    maxPlaintextBytes: input.maxPlaintextBytes,
    maxCompressionRatio: input.maxCompressionRatio,
  });
  await runStage(input.stageHook, "authority_finalize");
  const finalAuthority = await assertExecutionAuthority(input, clock(), ["running", "validating"]);
  assertSameAuthority(authority, finalAuthority);
  return {
    paths,
    manifest: verified.manifest,
    evidence: buildArtifactEvidence(verified.manifest, input, clock()),
    reusedCanonicalArtifact: true,
  };
}

export async function runDatabaseArtifactPipeline(
  input: RunDatabaseArtifactPipelineInput,
): Promise<DatabaseArtifactPipelineResult> {
  const clock = requireIsoClock(input.clock);
  const key = requireEncryptionKey(input.encryptionKey);
  let partial: PartialDatabaseArtifactPaths | null = null;
  try {
    await runStage(input.stageHook, "authority_start");
    const initialAuthority = await assertExecutionAuthority(input, clock(), ["running"]);
    assertExporterContract(input.exporter);
    const paths = await resolveDatabaseArtifactPaths(input.workspaceRoot, initialAuthority.generationKey);
    if (await finalDatabaseArtifactExists(paths)) {
      return await verifiedExistingResult(paths, initialAuthority, input, clock);
    }
    partial = await createPartialDatabaseArtifactPaths(paths);
    const compressionLevel = requireCompressionLevel(input.compressionLevel);
    const plaintextLimit = requirePlaintextLimit(input.maxPlaintextBytes);
    const createdAt = clock();
    const keyFingerprint = sha256Hex(key);
    const nonce = randomBytes(DATABASE_NONCE_BYTES);
    const aadInput = {
      runId: initialAuthority.runId,
      generationKey: initialAuthority.generationKey,
      artifactId: paths.artifactId,
      createdAt,
      catalogFingerprint: initialAuthority.catalogFingerprint,
      catalogPolicyVersion: initialAuthority.catalogPolicyVersion,
      preflightSnapshotId: initialAuthority.preflightSnapshotId,
      keyVersion: input.keyVersion,
      keyReference: input.keyReference,
      keyFingerprint,
      exportTool: input.exporter.tool,
      exportToolVersion: input.exporter.toolVersion,
      compressionLevel,
    } as const;
    const aad = databaseArtifactAadBytes(aadInput);

    await runStage(input.stageHook, "compression_start");
    const gzip = createGzip({ level: compressionLevel });
    await runStage(input.stageHook, "encryption_start");
    const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: DATABASE_AUTH_TAG_BYTES });
    cipher.setAAD(aad);
    const envelope = new GcmEnvelopeTransform(cipher, nonce);
    const plaintextMeter = new HashMeter();
    const compressedMeter = new HashMeter();
    const encryptedMeter = new HashMeter();
    const artifactOutput = createWriteStream(partial.partialArtifactPath, { flags: "wx", mode: 0o600 });

    await runStage(input.stageHook, "export_start");
    const exportSession = input.exporter.open(input.signal);
    let streamError: unknown = null;
    try {
      await pipeline(
        exportSession.stream,
        plaintextMeter,
        gzip,
        compressedMeter,
        cipher,
        envelope,
        encryptedMeter,
        artifactOutput,
        { signal: input.signal },
      );
    } catch (error) {
      streamError = error;
      exportSession.cancel();
    }
    let exportError: unknown = null;
    try {
      await exportSession.completed;
    } catch (error) {
      exportError = error;
    }
    if (streamError || exportError) {
      if (exportError instanceof BackupV2FailClosedError) throw exportError;
      if (input.signal?.aborted) fail("BACKUP_V2_EXPORT_CANCELLED", "Database export was cancelled");
      fail("BACKUP_V2_EXPORT_FAILED", "Database export, compression, or encryption stream failed");
    }
    await runStage(input.stageHook, "stream_complete");
    if (plaintextMeter.bytes === BigInt(0) || plaintextMeter.bytes > plaintextLimit ||
        compressedMeter.bytes === BigInt(0) ||
        encryptedMeter.bytes < BigInt(DATABASE_ARTIFACT_MIN_BYTES)) {
      fail(
        "BACKUP_V2_INVALID_EXPORT_SIZE",
        `Database artifact contains invalid or excessive byte counts (export=${plaintextMeter.bytes}, ` +
        `compressed=${compressedMeter.bytes}, encrypted=${encryptedMeter.bytes})`,
      );
    }
    await hardenArtifactFile(partial.partialArtifactPath);
    await syncFile(partial.partialArtifactPath);

    const manifest = createDatabaseArtifactManifest({
      ...aadInput,
      nonce,
      authTag: envelope.authTag(),
      plaintextBytes: plaintextMeter.bytes,
      compressedBytes: compressedMeter.bytes,
      encryptedArtifactBytes: encryptedMeter.bytes,
      plaintextHash: plaintextMeter.digest(),
      compressedHash: compressedMeter.digest(),
      encryptedArtifactHash: encryptedMeter.digest(),
      compatibilityRef: input.compatibilityRef,
    });
    await runStage(input.stageHook, "manifest_write");
    await writeManifestFile(partial.partialManifestPath, manifest);

    await runStage(input.stageHook, "runtime_verify");
    const verified = await verifyDatabaseArtifact({
      artifactPath: partial.partialArtifactPath,
      manifestPath: partial.partialManifestPath,
      encryptionKey: key,
      expected: {
        runId: initialAuthority.runId,
        generationKey: initialAuthority.generationKey,
        artifactId: paths.artifactId,
        catalogFingerprint: initialAuthority.catalogFingerprint,
        preflightSnapshotId: initialAuthority.preflightSnapshotId,
      },
      maxPlaintextBytes: input.maxPlaintextBytes,
      maxCompressionRatio: input.maxCompressionRatio,
    });

    await runStage(input.stageHook, "authority_finalize");
    await runStage(input.stageHook, "publish");
    const finalAuthority = await assertExecutionAuthority(input, clock(), ["running", "validating"]);
    assertSameAuthority(initialAuthority, finalAuthority);
    await publishPartialDatabaseArtifact(partial);
    partial = null;
    const verifiedAt = clock();
    return {
      paths,
      manifest: verified.manifest,
      evidence: buildArtifactEvidence(verified.manifest, input, verifiedAt),
      reusedCanonicalArtifact: false,
    };
  } finally {
    key.fill(0);
    if (partial) await cleanupPartialDatabaseArtifact(partial).catch(() => undefined);
  }
}
