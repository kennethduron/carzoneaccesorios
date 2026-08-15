import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";

import {
  assertCopyMatchesArtifact,
  ARTIFACT_COPY_ROLES,
  validateArtifactCopyEvidence,
  validateArtifactEvidence,
  type ArtifactCopyRole,
  type BackupArtifactCopyEvidence,
  type BackupArtifactEvidence,
  type ValidatedBackupArtifactEvidence,
} from "./artifact.ts";
import { parseComponentArtifactManifest } from "./component-artifact-format.ts";
import { parseDatabaseArtifactManifest, sha256Hex } from "./database-artifact-format.ts";
import { assertLeaseAuthority, type BackupV2Lease } from "./lease.ts";
import {
  BackupV2StorageError,
  assertRegisteredBackupV2StorageProvider,
  canonicalBackupV2ObjectKey,
  providerNeutralObjectRef,
  sanitizeStorageError,
  type BackupV2StorageProvider,
  type BackupV2StoredObjectStat,
} from "./storage-contract.ts";
import { BackupV2FailClosedError, requireBackupV2State, type BackupV2Scope, type BackupV2State } from "./types.ts";

const MAX_MANIFEST_BYTES = 131_072;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const preparedSources = new WeakSet<object>();

export interface BackupV2StorageAuthorityEvidence {
  runId: string;
  generationKey: string;
  state: BackupV2State;
  preflightOutcome: "go" | "blocked" | "review_required";
  preflightSnapshotId: string;
  catalogFingerprint: string;
  catalogPolicyVersion: string;
  lease: BackupV2Lease;
}

export interface PreparedBackupV2StorageSource {
  readonly workspaceRoot: string;
  readonly artifactPath: string;
  readonly manifestPath: string;
  readonly evidence: ValidatedBackupArtifactEvidence;
  readonly manifestSha256: string;
  readonly catalogFingerprint: string;
  readonly catalogPolicyVersion: string;
  readonly preflightSnapshotId: string;
}

export type BackupV2ArtifactStorageStage =
  | "authority_start"
  | "upload"
  | "stat_verify"
  | "readback_verify"
  | "authority_finalize";

export interface StoreBackupV2ArtifactInput {
  source: PreparedBackupV2StorageSource;
  provider: BackupV2StorageProvider;
  copyRole: ArtifactCopyRole;
  ownerRef: string;
  leaseGeneration: number;
  authority: { read: () => Promise<BackupV2StorageAuthorityEvidence> };
  signal?: AbortSignal;
  operationTimeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  clock?: () => string;
  stageHook?: (stage: BackupV2ArtifactStorageStage) => void | Promise<void>;
}

export interface StoreBackupV2ArtifactResult {
  objectKey: string;
  manifestSha256: string;
  reusedCanonicalObject: boolean;
  copyEvidence: ReturnType<typeof validateArtifactCopyEvidence>;
}

export interface VerifyStoredBackupV2ArtifactInput {
  source: PreparedBackupV2StorageSource;
  provider: BackupV2StorageProvider;
  copyEvidence: BackupArtifactCopyEvidence;
  signal?: AbortSignal;
  operationTimeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
}

interface StorageOperationOptions {
  signal?: AbortSignal;
  operationTimeoutMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
}

function fail(code: string, message: string): never { throw new BackupV2FailClosedError(code, message); }

function hashesEqual(left: string, right: string): boolean {
  return /^[0-9a-f]{64}$/.test(left) && /^[0-9a-f]{64}$/.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function canonicalClock(source?: () => string): () => string {
  const selected = source ?? (() => new Date().toISOString());
  return () => {
    const value = selected();
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
      fail("BACKUP_V2_INVALID_CLOCK", "Storage clock is not canonical ISO");
    }
    return value;
  };
}

async function safeLocalFile(filePath: string, expectedParent: string, expectedName: string, label: string): Promise<void> {
  if (path.dirname(filePath) !== expectedParent || path.basename(filePath) !== expectedName) {
    fail("BACKUP_V2_SOURCE_PATH_DENIED", `${label} is outside the canonical artifact directory`);
  }
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("BACKUP_V2_SOURCE_PATH_DENIED", `${label} is not a safe regular file`);
  if (await realpath(filePath) !== filePath) fail("BACKUP_V2_SOURCE_PATH_DENIED", `${label} resolves through an unsafe path`);
}

async function hashSafeLocalArtifact(filePath: string, expectedBytes: bigint, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new BackupV2StorageError("BACKUP_V2_STORAGE_CANCELLED", "Storage operation was cancelled", "cancelled");
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(filePath, flags);
  const value = await handle.stat();
  if (!value.isFile() || BigInt(value.size) !== expectedBytes) { await handle.close(); fail("BACKUP_V2_SOURCE_ARTIFACT_MISMATCH", "Local artifact byte count changed"); }
  const hash = createHash("sha256");
  const stream = handle.createReadStream({ autoClose: true });
  signal?.addEventListener("abort", () => stream.destroy(), { once: true });
  let bytes = BigInt(0);
  try {
    for await (const chunk of stream) { bytes += BigInt(chunk.byteLength); hash.update(chunk); }
  } catch {
    if (signal?.aborted) throw new BackupV2StorageError("BACKUP_V2_STORAGE_CANCELLED", "Storage operation was cancelled", "cancelled");
    fail("BACKUP_V2_SOURCE_ARTIFACT_READ_FAILED", "Local artifact could not be verified");
  }
  if (bytes !== expectedBytes) fail("BACKUP_V2_SOURCE_ARTIFACT_MISMATCH", "Local artifact byte count changed");
  return hash.digest("hex");
}

function manifestFields(raw: string, component: BackupV2Scope): {
  artifactId: string; generationKey: string; runId: string; createdAt: string; encryptedBytes: string;
  encryptedHash: string; compatibilityRef: string; manifestSha256: string;
  catalogFingerprint: string; catalogPolicyVersion: string; preflightSnapshotId: string;
} {
  if (component === "database") {
    const manifest = parseDatabaseArtifactManifest(raw);
    return {
      artifactId: manifest.artifact_id, generationKey: manifest.generation_key, runId: manifest.run_id,
      createdAt: manifest.created_at, encryptedBytes: manifest.byte_counts.encrypted_artifact,
      encryptedHash: manifest.hashes.encrypted_artifact, compatibilityRef: manifest.compatibility_ref,
      manifestSha256: sha256Hex(raw), catalogFingerprint: manifest.catalog.fingerprint,
      catalogPolicyVersion: manifest.catalog.policy_version, preflightSnapshotId: manifest.preflight.snapshot_id,
    };
  }
  const manifest = parseComponentArtifactManifest(raw);
  if (manifest.component !== component) fail("BACKUP_V2_SOURCE_ARTIFACT_MISMATCH", "Manifest component does not match evidence");
  return {
    artifactId: manifest.artifact_id, generationKey: manifest.generation_key, runId: manifest.run_id,
    createdAt: manifest.created_at, encryptedBytes: manifest.byte_counts.encrypted_artifact,
    encryptedHash: manifest.hashes.encrypted_artifact, compatibilityRef: manifest.compatibility_ref,
    manifestSha256: sha256Hex(raw), catalogFingerprint: manifest.catalog.fingerprint,
    catalogPolicyVersion: manifest.catalog.policy_version, preflightSnapshotId: manifest.preflight.snapshot_id,
  };
}

export async function prepareBackupV2ArtifactForStorage(input: {
  workspaceRoot: string;
  artifactPath: string;
  manifestPath: string;
  evidence: BackupArtifactEvidence;
  signal?: AbortSignal;
}): Promise<PreparedBackupV2StorageSource> {
  const evidence = validateArtifactEvidence(input.evidence);
  if (evidence.verificationStatus !== "verified" || evidence.evidenceOrigin !== "runtime_verified" ||
      evidence.ciphertextHash === null || evidence.ciphertextSizeBytes === null) {
    fail("BACKUP_V2_UNVERIFIED_STORAGE_SOURCE", "Only runtime-verified artifacts can be stored canonically");
  }
  const root = await realpath(input.workspaceRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("BACKUP_V2_SOURCE_PATH_DENIED", "Artifact workspace is unsafe");
  const artifactDirectory = path.resolve(root, evidence.artifactId);
  if (path.dirname(artifactDirectory) !== root || await realpath(artifactDirectory) !== artifactDirectory) {
    fail("BACKUP_V2_SOURCE_PATH_DENIED", "Artifact directory is not canonical");
  }
  const artifactName = `${evidence.artifactId}.czb2`;
  const manifestName = `${evidence.artifactId}.manifest.json`;
  const artifactPath = path.resolve(input.artifactPath);
  const manifestPath = path.resolve(input.manifestPath);
  await safeLocalFile(artifactPath, artifactDirectory, artifactName, "Artifact");
  await safeLocalFile(manifestPath, artifactDirectory, manifestName, "Manifest");
  const manifestStat = await lstat(manifestPath);
  if (manifestStat.size < 1 || manifestStat.size > MAX_MANIFEST_BYTES) fail("BACKUP_V2_INVALID_STORAGE_MANIFEST", "Artifact manifest is empty or oversized");
  const raw = await readFile(manifestPath, "utf8");
  const manifest = manifestFields(raw, evidence.component);
  if (manifest.artifactId !== evidence.artifactId || manifest.generationKey !== evidence.generationKey ||
      manifest.runId !== evidence.runId || manifest.createdAt !== evidence.createdAt ||
      manifest.encryptedBytes !== evidence.ciphertextSizeBytes ||
      !hashesEqual(manifest.encryptedHash, evidence.ciphertextHash) ||
      manifest.compatibilityRef !== evidence.compatibilityRef) {
    fail("BACKUP_V2_SOURCE_ARTIFACT_MISMATCH", "Manifest and runtime artifact evidence do not match");
  }
  const localHash = await hashSafeLocalArtifact(artifactPath, BigInt(evidence.ciphertextSizeBytes), input.signal);
  if (!hashesEqual(localHash, evidence.ciphertextHash)) fail("BACKUP_V2_SOURCE_ARTIFACT_MISMATCH", "Local artifact hash does not match runtime evidence");
  const immutableEvidence = Object.freeze({ ...evidence });
  const prepared: PreparedBackupV2StorageSource = Object.freeze({
    workspaceRoot: root, artifactPath, manifestPath, evidence: immutableEvidence, manifestSha256: manifest.manifestSha256,
    catalogFingerprint: manifest.catalogFingerprint, catalogPolicyVersion: manifest.catalogPolicyVersion,
    preflightSnapshotId: manifest.preflightSnapshotId,
  });
  preparedSources.add(prepared);
  return prepared;
}

async function openRevalidatingSource(source: PreparedBackupV2StorageSource, signal: AbortSignal): Promise<Readable> {
  const expectedBytes = BigInt(source.evidence.ciphertextSizeBytes!);
  const expectedHash = source.evidence.ciphertextHash!;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(source.artifactPath, flags);
  const value = await handle.stat();
  if (!value.isFile() || BigInt(value.size) !== expectedBytes) { await handle.close(); fail("BACKUP_V2_SOURCE_ARTIFACT_MISMATCH", "Local artifact changed before upload"); }
  const hash = createHash("sha256");
  let bytes = BigInt(0);
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) { bytes += BigInt(chunk.byteLength); hash.update(chunk); callback(null, chunk); },
    flush(callback) {
      if (bytes !== expectedBytes || !hashesEqual(hash.digest("hex"), expectedHash)) callback(new BackupV2FailClosedError("BACKUP_V2_SOURCE_ARTIFACT_MISMATCH", "Local artifact changed during upload"));
      else callback();
    },
  });
  const stream = handle.createReadStream({ autoClose: true });
  signal.addEventListener("abort", () => stream.destroy(), { once: true });
  return stream.pipe(verifier);
}

function retrySettings(input: StorageOperationOptions): { attempts: number; timeout: number; delay: number } {
  const attempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const timeout = input.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const delay = input.retryBaseDelayMs ?? 25;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5 || !Number.isSafeInteger(timeout) || timeout < 10 || timeout > 300_000 ||
      !Number.isSafeInteger(delay) || delay < 0 || delay > 10_000) fail("BACKUP_V2_INVALID_STORAGE_RETRY_POLICY", "Storage retry policy is invalid");
  return { attempts, timeout, delay };
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new BackupV2StorageError("BACKUP_V2_STORAGE_CANCELLED", "Storage operation was cancelled", "cancelled");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done(): void { signal?.removeEventListener("abort", cancelled); resolve(); }
    function cancelled(): void { clearTimeout(timer); reject(new BackupV2StorageError("BACKUP_V2_STORAGE_CANCELLED", "Storage operation was cancelled", "cancelled")); }
    signal?.addEventListener("abort", cancelled, { once: true });
  });
}

async function attempt<T>(input: StorageOperationOptions, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const settings = retrySettings(input);
  let last: BackupV2StorageError | null = null;
  for (let current = 1; current <= settings.attempts; current += 1) {
    if (input.signal?.aborted) throw new BackupV2StorageError("BACKUP_V2_STORAGE_CANCELLED", "Storage operation was cancelled", "cancelled");
    const controller = new AbortController();
    const relay = () => controller.abort();
    input.signal?.addEventListener("abort", relay, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, settings.timeout);
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<T>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new BackupV2StorageError(
          timedOut ? "BACKUP_V2_STORAGE_TIMEOUT" : "BACKUP_V2_STORAGE_CANCELLED",
          timedOut ? "Storage provider operation timed out" : "Storage operation was cancelled",
          timedOut ? "timeout" : "cancelled", timedOut,
        )), { once: true })),
      ]);
    } catch (error) {
      last = sanitizeStorageError(error);
      if (!last.retryable || current === settings.attempts || input.signal?.aborted) throw last;
    } finally {
      clearTimeout(timer); input.signal?.removeEventListener("abort", relay); controller.abort();
    }
    await wait(settings.delay * current, input.signal);
  }
  throw last ?? new BackupV2StorageError("BACKUP_V2_PROVIDER_OPERATION_FAILED", "Storage provider operation failed", "unavailable");
}

async function authority(input: StoreBackupV2ArtifactInput, now: string): Promise<BackupV2StorageAuthorityEvidence> {
  const value = await input.authority.read();
  if (value.preflightOutcome !== "go" || !["running", "validating"].includes(requireBackupV2State(value.state))) {
    fail("BACKUP_V2_RUN_NOT_EXECUTABLE", "Storage run is not executable");
  }
  if (!value.runId?.trim() || !value.preflightSnapshotId?.trim() || !/^[0-9a-f]{64}$/.test(value.catalogFingerprint) || !value.catalogPolicyVersion?.trim()) {
    fail("BACKUP_V2_INVALID_EXECUTION_AUTHORITY", "Storage execution authority is incomplete");
  }
  assertLeaseAuthority(value.lease, input.ownerRef, input.leaseGeneration, now);
  return Object.freeze({ ...value, lease: Object.freeze({ ...value.lease }) });
}

function bindSource(source: PreparedBackupV2StorageSource, value: BackupV2StorageAuthorityEvidence, input: StoreBackupV2ArtifactInput): void {
  if (!preparedSources.has(source) || source.evidence.runId !== value.runId || source.evidence.generationKey !== value.generationKey ||
      source.evidence.createdByOwnerRef !== input.ownerRef || source.evidence.leaseGeneration !== input.leaseGeneration ||
      source.preflightSnapshotId !== value.preflightSnapshotId || source.catalogFingerprint !== value.catalogFingerprint ||
      source.catalogPolicyVersion !== value.catalogPolicyVersion) {
    fail("BACKUP_V2_STORAGE_AUTHORITY_MISMATCH", "Artifact is not bound to current storage authority");
  }
}

function sameAuthority(left: BackupV2StorageAuthorityEvidence, right: BackupV2StorageAuthorityEvidence): void {
  if (left.runId !== right.runId || left.generationKey !== right.generationKey || left.preflightSnapshotId !== right.preflightSnapshotId ||
      left.catalogFingerprint !== right.catalogFingerprint || left.catalogPolicyVersion !== right.catalogPolicyVersion) {
    fail("BACKUP_V2_EXECUTION_AUTHORITY_CHANGED", "Storage execution authority changed");
  }
}

async function stage(input: StoreBackupV2ArtifactInput, value: BackupV2ArtifactStorageStage): Promise<void> {
  try { await input.stageHook?.(value); } catch { fail("BACKUP_V2_STORAGE_STAGE_FAILED", `Storage pipeline failed at ${value}`); }
}

function validateStat(stat: BackupV2StoredObjectStat | null, objectKey: string, expectedBytes: bigint): BackupV2StoredObjectStat {
  if (stat === null) throw new BackupV2StorageError("BACKUP_V2_STORED_OBJECT_NOT_FOUND", "Stored object was not found", "not_found");
  if (stat.objectKey !== objectKey || stat.sizeBytes !== expectedBytes || !stat.physicalObjectIdentity?.trim()) {
    throw new BackupV2StorageError("BACKUP_V2_STORED_OBJECT_STAT_MISMATCH", "Stored object stat did not match canonical artifact", "integrity");
  }
  return stat;
}

async function verifyReadback(input: StorageOperationOptions & { provider: BackupV2StorageProvider }, objectKey: string, expectedBytes: bigint, expectedHash: string): Promise<void> {
  await attempt(input, async (signal) => {
    const stream = await input.provider.openRead({ objectKey, signal });
    const hash = createHash("sha256");
    let bytes = BigInt(0);
    signal.addEventListener("abort", () => stream.destroy(), { once: true });
    for await (const chunk of stream) {
      bytes += BigInt(chunk.byteLength);
      if (bytes > expectedBytes) throw new BackupV2StorageError("BACKUP_V2_STORED_OBJECT_INTEGRITY_MISMATCH", "Stored object has unexpected trailing bytes", "integrity");
      hash.update(chunk);
    }
    if (bytes !== expectedBytes || !hashesEqual(hash.digest("hex"), expectedHash)) {
      throw new BackupV2StorageError("BACKUP_V2_STORED_OBJECT_INTEGRITY_MISMATCH", "Stored object failed SHA-256 readback verification", "integrity");
    }
  });
}

export async function verifyStoredBackupV2Artifact(
  input: VerifyStoredBackupV2ArtifactInput,
): Promise<BackupV2StoredObjectStat> {
  assertRegisteredBackupV2StorageProvider(input.provider);
  if (!preparedSources.has(input.source)) fail("BACKUP_V2_UNVERIFIED_STORAGE_SOURCE", "Storage source was not prepared by runtime verification");
  const copy = validateArtifactCopyEvidence(input.copyEvidence);
  assertCopyMatchesArtifact(input.source.evidence, copy);
  const objectKey = canonicalBackupV2ObjectKey(input.source.evidence);
  if (copy.providerNeutralRef !== providerNeutralObjectRef(input.provider.descriptor, objectKey)) {
    throw new BackupV2StorageError("BACKUP_V2_STORED_COPY_LOCATOR_MISMATCH", "Stored copy locator does not match configured provider", "integrity");
  }
  const expectedBytes = BigInt(input.source.evidence.ciphertextSizeBytes!);
  const stat = validateStat(await attempt(input, (signal) => input.provider.stat({ objectKey, signal })), objectKey, expectedBytes);
  if (stat.physicalObjectIdentity !== copy.physicalObjectIdentity) {
    throw new BackupV2StorageError("BACKUP_V2_STORED_COPY_IDENTITY_MISMATCH", "Stored physical object identity changed", "integrity");
  }
  await verifyReadback(input, objectKey, expectedBytes, input.source.evidence.ciphertextHash!);
  return stat;
}

export async function storeBackupV2Artifact(input: StoreBackupV2ArtifactInput): Promise<StoreBackupV2ArtifactResult> {
  const request: StoreBackupV2ArtifactInput = Object.freeze({
    ...input,
    authority: Object.freeze({ read: input.authority.read.bind(input.authority) }),
  });
  assertRegisteredBackupV2StorageProvider(request.provider);
  if (!ARTIFACT_COPY_ROLES.includes(request.copyRole)) fail("BACKUP_V2_UNKNOWN_COPY_ROLE", "Unknown copy role");
  if (!preparedSources.has(request.source)) fail("BACKUP_V2_UNVERIFIED_STORAGE_SOURCE", "Storage source was not prepared by runtime verification");
  const now = canonicalClock(request.clock);
  await stage(request, "authority_start");
  const initial = await authority(request, now());
  bindSource(request.source, initial, request);
  if (!request.provider.descriptor.failureDomain && request.copyRole === "secondary_independent") {
    fail("BACKUP_V2_COPY_INDEPENDENCE_UNKNOWN", "Independent secondary requires known failure-domain evidence");
  }
  const evidence = request.source.evidence;
  const expectedBytes = BigInt(evidence.ciphertextSizeBytes!);
  const expectedHash = evidence.ciphertextHash!;
  const objectKey = canonicalBackupV2ObjectKey(evidence);
  await stage(request, "upload");
  const write = await attempt(request, async (signal) => {
    const source = await openRevalidatingSource(request.source, signal);
    try { return await request.provider.write({ objectKey, source, expectedSizeBytes: expectedBytes, signal }); }
    finally { if (!source.destroyed) source.destroy(); }
  });
  if (write.objectKey !== objectKey || !["created", "already_exists"].includes(write.disposition)) {
    throw new BackupV2StorageError("BACKUP_V2_PROVIDER_WRITE_IDENTITY_MISMATCH", "Provider returned the wrong object identity", "integrity");
  }
  await stage(request, "stat_verify");
  const stat = validateStat(await attempt(request, (signal) => request.provider.stat({ objectKey, signal })), objectKey, expectedBytes);
  await stage(request, "readback_verify");
  await verifyReadback(request, objectKey, expectedBytes, expectedHash);
  await stage(request, "authority_finalize");
  const final = await authority(request, now());
  sameAuthority(initial, final); bindSource(request.source, final, request);
  const verifiedAt = now();
  const descriptor = request.provider.descriptor;
  const providerRef = providerNeutralObjectRef(descriptor, objectKey);
  const copyId = `backup-v2-copy:${createHash("sha256").update([
    evidence.generationKey, evidence.artifactId, evidence.component, request.copyRole,
    descriptor.providerType, descriptor.providerInstanceId, descriptor.namespaceId, objectKey, request.source.manifestSha256,
  ].join("\n")).digest("hex")}`;
  const copyEvidence = validateArtifactCopyEvidence({
    copyId, artifactId: evidence.artifactId, copyRole: request.copyRole,
    providerNeutralRef: providerRef, physicalObjectIdentity: stat.physicalObjectIdentity,
    independenceDomain: descriptor.failureDomain, recordedByOwnerRef: request.ownerRef,
    leaseGeneration: request.leaseGeneration, storageClass: null, storedAt: verifiedAt, verifiedAt,
    ciphertextSizeBytes: evidence.ciphertextSizeBytes!, ciphertextHash: expectedHash,
    providerChecksumRef: null, verificationStatus: "verified", evidenceOrigin: "runtime_verified",
  });
  assertCopyMatchesArtifact(evidence, copyEvidence);
  return { objectKey, manifestSha256: request.source.manifestSha256, reusedCanonicalObject: write.disposition === "already_exists", copyEvidence };
}

export async function storeBackupV2ArtifactsBounded(
  inputs: readonly StoreBackupV2ArtifactInput[], concurrency = 2,
): Promise<readonly StoreBackupV2ArtifactResult[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) fail("BACKUP_V2_INVALID_STORAGE_CONCURRENCY", "Storage concurrency is invalid");
  const results = new Array<StoreBackupV2ArtifactResult>(inputs.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < inputs.length) { const index = cursor; cursor += 1; results[index] = await storeBackupV2Artifact(inputs[index]); }
  }
  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export function toCanonicalRecoveryCopyEvidence(copyValue: BackupArtifactCopyEvidence) {
  const copy = validateArtifactCopyEvidence(copyValue);
  return {
    copyRole: copy.copyRole, verificationStatus: copy.verificationStatus,
    ciphertextSizeBytes: copy.ciphertextSizeBytes, ciphertextHash: copy.ciphertextHash,
    providerNeutralRef: copy.providerNeutralRef, physicalObjectIdentity: copy.physicalObjectIdentity,
    independenceDomain: copy.independenceDomain, evidenceOrigin: copy.evidenceOrigin,
  } as const;
}
