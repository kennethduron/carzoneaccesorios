import "server-only";

import { timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import { validateArtifactEvidence, type ValidatedBackupArtifactEvidence } from "./artifact.ts";
import { verifyBackupV2EncryptedArtifact, writeBackupV2EncryptedArtifact } from "./artifact-crypto-pipeline.ts";
import {
  COMPONENT_ARTIFACT_MAGIC,
  componentArtifactAadBytes,
  componentArtifactId,
  componentFilename,
  createComponentArtifactManifest,
  parseComponentArtifactManifest,
  serializeComponentArtifactManifest,
  type BackupV2ComponentScope,
  type ComponentArtifactManifest,
} from "./component-artifact-format.ts";
import {
  collectComponentInventory,
  createComponentPayloadStream,
  ComponentPayloadVerifier,
  type ComponentSource,
  type InventoryLimits,
} from "./component-payload.ts";
import { sha256Hex } from "./database-artifact-format.ts";
import { assertLeaseAuthority, type BackupV2Lease } from "./lease.ts";
import { BackupV2FailClosedError, requireBackupV2State, type BackupV2State } from "./types.ts";

const MAX_MANIFEST_BYTES = 131_072;
const DEFAULT_MAX_PLAINTEXT_BYTES = BigInt("1099511627776");
const DEFAULT_MAX_COMPRESSION_RATIO = 500;

export interface ComponentArtifactAuthorityEvidence {
  runId: string;
  generationKey: string;
  state: BackupV2State;
  preflightOutcome: "go" | "blocked" | "review_required";
  preflightSnapshotId: string;
  catalogFingerprint: string;
  catalogPolicyVersion: string;
  lease: BackupV2Lease;
}

export interface ComponentArtifactPaths {
  workspaceRoot: string;
  artifactId: string;
  finalDirectory: string;
  artifactPath: string;
  manifestPath: string;
}

export interface RunComponentArtifactPipelineInput {
  workspaceRoot: string;
  recoverySetId: string;
  ownerRef: string;
  leaseGeneration: number;
  authority: { read: () => Promise<ComponentArtifactAuthorityEvidence> };
  source: ComponentSource;
  encryptionKey: Uint8Array;
  keyVersion: string;
  keyReference: string;
  compatibilityRef: string;
  bindingFingerprint?: string | null;
  storageMetadataArtifact?: { artifactPath: string; manifestPath: string };
  compressionLevel?: number;
  maxPlaintextBytes?: bigint;
  maxCompressionRatio?: number;
  inventoryLimits?: InventoryLimits;
  signal?: AbortSignal;
  clock?: () => string;
  stageHook?: (stage: "authority_start" | "inventory" | "export" | "manifest_write" | "runtime_verify" | "authority_finalize" | "publish") => void | Promise<void>;
}

export interface ComponentArtifactPipelineResult {
  paths: ComponentArtifactPaths;
  manifest: ComponentArtifactManifest;
  evidence: ValidatedBackupArtifactEvidence;
  reusedCanonicalArtifact: boolean;
}

export interface VerifiedComponentArtifact {
  manifest: ComponentArtifactManifest;
  recordIds: readonly string[];
}

function fail(code: string, message: string): never { throw new BackupV2FailClosedError(code, message); }

function key(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) fail("BACKUP_V2_INVALID_ENCRYPTION_KEY", "AES-256-GCM requires 32 bytes");
  return Buffer.from(value);
}

function safeEqualHash(left: string, right: string): boolean {
  return /^[0-9a-f]{64}$/.test(left) && /^[0-9a-f]{64}$/.test(right) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function clock(source?: () => string): () => string {
  const selected = source ?? (() => new Date().toISOString());
  return () => { const value = selected(); if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail("BACKUP_V2_INVALID_CLOCK", "Clock is not canonical ISO"); return value; };
}

function limits(input: RunComponentArtifactPipelineInput): { compression: number; plaintext: bigint; ratio: number } {
  const compression = input.compressionLevel ?? 9;
  const plaintext = input.maxPlaintextBytes ?? DEFAULT_MAX_PLAINTEXT_BYTES;
  const ratio = input.maxCompressionRatio ?? DEFAULT_MAX_COMPRESSION_RATIO;
  if (!Number.isSafeInteger(compression) || compression < 1 || compression > 9 || typeof plaintext !== "bigint" || plaintext <= BigInt(0) || !Number.isSafeInteger(ratio) || ratio < 1 || ratio > 10_000) fail("BACKUP_V2_INVALID_RESOURCE_LIMIT", "Invalid component pipeline limits");
  return { compression, plaintext, ratio };
}

async function authority(input: RunComponentArtifactPipelineInput, now: string, states: readonly BackupV2State[]): Promise<ComponentArtifactAuthorityEvidence> {
  const value = await input.authority.read();
  if (value.preflightOutcome !== "go" || !states.includes(requireBackupV2State(value.state))) fail("BACKUP_V2_RUN_NOT_EXECUTABLE", "Component run is not executable");
  if (!value.runId?.trim() || !value.preflightSnapshotId?.trim() || !/^[0-9a-f]{64}$/.test(value.catalogFingerprint) || !value.catalogPolicyVersion?.trim()) fail("BACKUP_V2_INVALID_EXECUTION_AUTHORITY", "Execution authority is incomplete");
  assertLeaseAuthority(value.lease, input.ownerRef, input.leaseGeneration, now);
  return value;
}

function sameAuthority(left: ComponentArtifactAuthorityEvidence, right: ComponentArtifactAuthorityEvidence): void {
  if (left.runId !== right.runId || left.generationKey !== right.generationKey || left.preflightSnapshotId !== right.preflightSnapshotId || left.catalogFingerprint !== right.catalogFingerprint || left.catalogPolicyVersion !== right.catalogPolicyVersion) fail("BACKUP_V2_EXECUTION_AUTHORITY_CHANGED", "Execution authority changed");
}

async function stage(input: RunComponentArtifactPipelineInput, value: Parameters<NonNullable<RunComponentArtifactPipelineInput["stageHook"]>>[0]): Promise<void> {
  try { await input.stageHook?.(value); } catch { fail("BACKUP_V2_PIPELINE_STAGE_FAILED", `Component pipeline failed at ${value}`); }
}

async function paths(rootValue: string, component: BackupV2ComponentScope, generationKey: string): Promise<ComponentArtifactPaths> {
  if (!rootValue?.trim() || rootValue.includes("\0")) fail("BACKUP_V2_INVALID_WORKSPACE", "Invalid component workspace");
  await mkdir(rootValue, { recursive: true, mode: 0o700 });
  const root = await realpath(rootValue); const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) fail("BACKUP_V2_INVALID_WORKSPACE", "Component workspace is not a directory");
  const artifactId = componentArtifactId(component, generationKey); const finalDirectory = path.resolve(root, artifactId);
  if (path.dirname(finalDirectory) !== root) fail("BACKUP_V2_PATH_ESCAPE", "Component artifact escaped workspace");
  return { workspaceRoot: root, artifactId, finalDirectory, artifactPath: path.join(finalDirectory, componentFilename(component, artifactId)), manifestPath: path.join(finalDirectory, `${artifactId}.manifest.json`) };
}

async function exists(directory: string): Promise<boolean> {
  try { const stat = await lstat(directory); if (stat.isSymbolicLink() || !stat.isDirectory()) fail("BACKUP_V2_UNSAFE_FINAL_ARTIFACT_PATH", "Final component path is unsafe"); return true; } catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; }
}

async function sync(filePath: string): Promise<void> { const handle = await open(filePath, "r+"); try { await handle.sync(); } finally { await handle.close(); } }

function evidence(manifest: ComponentArtifactManifest, input: RunComponentArtifactPipelineInput, verifiedAt: string): ValidatedBackupArtifactEvidence {
  return validateArtifactEvidence({
    artifactId: manifest.artifact_id, recoverySetId: input.recoverySetId, runId: manifest.run_id,
    generationKey: manifest.generation_key, component: manifest.component, createdByOwnerRef: input.ownerRef,
    leaseGeneration: input.leaseGeneration, formatVersion: manifest.payload.format_version,
    artifactVersion: manifest.encryption.format_version, artifactSizeBytes: manifest.byte_counts.encrypted_artifact,
    plaintextSizeBytes: manifest.byte_counts.plaintext_export, ciphertextSizeBytes: manifest.byte_counts.encrypted_artifact,
    hashAlgorithm: manifest.hashes.algorithm, plaintextHash: manifest.hashes.plaintext_export,
    ciphertextHash: manifest.hashes.encrypted_artifact, encryptionAlgorithm: manifest.encryption.algorithm,
    keyVersion: manifest.encryption.key_version, keyReference: manifest.encryption.key_reference,
    keyFingerprint: manifest.encryption.key_fingerprint, createdAt: manifest.created_at, verifiedAt,
    verificationStatus: "verified", evidenceOrigin: "runtime_verified", compatibilityRef: manifest.compatibility_ref,
  });
}

export async function verifyComponentArtifact(input: {
  artifactPath: string; manifestPath: string; encryptionKey: Uint8Array;
  expected: { runId: string; generationKey: string; artifactId: string; component: BackupV2ComponentScope; catalogFingerprint: string; preflightSnapshotId: string };
  maxPlaintextBytes?: bigint; maxCompressionRatio?: number;
}): Promise<VerifiedComponentArtifact> {
  const secret = key(input.encryptionKey);
  try {
    const stat = await lstat(input.manifestPath); if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_MANIFEST_BYTES) fail("BACKUP_V2_INVALID_COMPONENT_MANIFEST", "Manifest file is unsafe or oversized");
    const manifest = parseComponentArtifactManifest(await readFile(input.manifestPath, "utf8")); const expected = input.expected;
    if (manifest.run_id !== expected.runId || manifest.generation_key !== expected.generationKey || manifest.artifact_id !== expected.artifactId || manifest.component !== expected.component || manifest.catalog.fingerprint !== expected.catalogFingerprint || manifest.preflight.snapshot_id !== expected.preflightSnapshotId) fail("BACKUP_V2_COMPONENT_ARTIFACT_IDENTITY_MISMATCH", "Component artifact identity mismatch");
    if (!safeEqualHash(manifest.encryption.key_fingerprint, sha256Hex(secret))) fail("BACKUP_V2_WRONG_ENCRYPTION_KEY", "Wrong component encryption key");
    const aad = componentArtifactAadBytes({
      runId: manifest.run_id, generationKey: manifest.generation_key, artifactId: manifest.artifact_id,
      component: manifest.component, createdAt: manifest.created_at, catalogFingerprint: manifest.catalog.fingerprint,
      catalogPolicyVersion: manifest.catalog.policy_version, preflightSnapshotId: manifest.preflight.snapshot_id,
      sourceSnapshotId: manifest.payload.source_snapshot_id, inventoryFingerprint: manifest.payload.inventory_fingerprint,
      bindingFingerprint: manifest.payload.binding_fingerprint, keyVersion: manifest.encryption.key_version,
      keyReference: manifest.encryption.key_reference, keyFingerprint: manifest.encryption.key_fingerprint,
      compressionLevel: manifest.compression.level,
    });
    const verifier = new ComponentPayloadVerifier({
      component: manifest.component, snapshotId: manifest.payload.source_snapshot_id,
      inventoryFingerprint: manifest.payload.inventory_fingerprint, bindingFingerprint: manifest.payload.binding_fingerprint,
      recordCount: BigInt(manifest.payload.record_count), bodyBytes: BigInt(manifest.payload.body_bytes),
    });
    await verifyBackupV2EncryptedArtifact({
      artifactPath: input.artifactPath, encryptionKey: secret, aad, magic: COMPONENT_ARTIFACT_MAGIC,
      nonce: Buffer.from(manifest.encryption.nonce_base64, "base64"), authTag: Buffer.from(manifest.encryption.auth_tag_base64, "base64"),
      plaintextBytes: BigInt(manifest.byte_counts.plaintext_export), compressedBytes: BigInt(manifest.byte_counts.compressed),
      encryptedArtifactBytes: BigInt(manifest.byte_counts.encrypted_artifact), plaintextHash: manifest.hashes.plaintext_export,
      compressedHash: manifest.hashes.compressed, encryptedArtifactHash: manifest.hashes.encrypted_artifact,
      maxPlaintextBytes: input.maxPlaintextBytes ?? DEFAULT_MAX_PLAINTEXT_BYTES,
      maxCompressionRatio: input.maxCompressionRatio ?? DEFAULT_MAX_COMPRESSION_RATIO, plaintextSink: verifier,
    });
    verifier.assertValid(); return { manifest, recordIds: verifier.recordIds() };
  } finally { secret.fill(0); }
}

export async function runComponentArtifactPipeline(input: RunComponentArtifactPipelineInput): Promise<ComponentArtifactPipelineResult> {
  const now = clock(input.clock); const secret = key(input.encryptionKey); const configured = limits(input);
  let partialDirectory: string | null = null;
  try {
    await stage(input, "authority_start"); const initial = await authority(input, now(), ["running"]);
    const resolved = await paths(input.workspaceRoot, input.source.component, initial.generationKey);
    let bindingFingerprint = input.bindingFingerprint ?? null;
    let storageMetadataRecordIds: ReadonlySet<string> | null = null;
    if (input.source.component === "storage_objects") {
      if (!input.storageMetadataArtifact) fail("BACKUP_V2_STORAGE_METADATA_BINDING_REQUIRED", "Storage objects require a verified storage metadata artifact");
      const metadataArtifactId = componentArtifactId("storage_metadata", initial.generationKey);
      const verifiedMetadata = await verifyComponentArtifact({
        artifactPath: input.storageMetadataArtifact.artifactPath,
        manifestPath: input.storageMetadataArtifact.manifestPath,
        encryptionKey: secret,
        expected: {
          runId: initial.runId, generationKey: initial.generationKey, artifactId: metadataArtifactId,
          component: "storage_metadata", catalogFingerprint: initial.catalogFingerprint,
          preflightSnapshotId: initial.preflightSnapshotId,
        },
        maxPlaintextBytes: configured.plaintext,
        maxCompressionRatio: configured.ratio,
      });
      const metadataManifest = verifiedMetadata.manifest;
      bindingFingerprint = metadataManifest.payload.inventory_fingerprint;
      storageMetadataRecordIds = new Set(verifiedMetadata.recordIds);
    }
    if (await exists(resolved.finalDirectory)) {
      const { manifest } = await verifyComponentArtifact({ artifactPath: resolved.artifactPath, manifestPath: resolved.manifestPath, encryptionKey: secret, expected: { runId: initial.runId, generationKey: initial.generationKey, artifactId: resolved.artifactId, component: input.source.component, catalogFingerprint: initial.catalogFingerprint, preflightSnapshotId: initial.preflightSnapshotId }, maxPlaintextBytes: configured.plaintext, maxCompressionRatio: configured.ratio });
      await stage(input, "authority_finalize"); const final = await authority(input, now(), ["running", "validating"]); sameAuthority(initial, final);
      return { paths: resolved, manifest, evidence: evidence(manifest, input, now()), reusedCanonicalArtifact: true };
    }
    partialDirectory = path.resolve(resolved.workspaceRoot, `.partial-${resolved.artifactId}-${crypto.randomUUID()}`);
    if (path.dirname(partialDirectory) !== resolved.workspaceRoot) fail("BACKUP_V2_PATH_ESCAPE", "Partial component path escaped workspace");
    await mkdir(partialDirectory, { mode: 0o700 });
    const partialArtifact = path.join(partialDirectory, componentFilename(input.source.component, resolved.artifactId));
    const partialManifest = path.join(partialDirectory, `${resolved.artifactId}.manifest.json`);
    await stage(input, "inventory"); const inventory = await collectComponentInventory(input.source, input.inventoryLimits, input.signal);
    if (input.source.component === "storage_objects" && storageMetadataRecordIds !== null) {
      for (const record of inventory.records) {
        if (!storageMetadataRecordIds.has(record.id)) fail("BACKUP_V2_STORAGE_METADATA_RELATIONSHIP_MISSING", "Storage object is absent from the bound metadata inventory");
      }
    }
    const createdAt = now(); const keyFingerprint = sha256Hex(secret);
    const aadInput = { runId: initial.runId, generationKey: initial.generationKey, artifactId: resolved.artifactId, component: input.source.component, createdAt, catalogFingerprint: initial.catalogFingerprint, catalogPolicyVersion: initial.catalogPolicyVersion, preflightSnapshotId: initial.preflightSnapshotId, sourceSnapshotId: inventory.snapshotId, inventoryFingerprint: inventory.fingerprint, bindingFingerprint, keyVersion: input.keyVersion, keyReference: input.keyReference, keyFingerprint, compressionLevel: configured.compression } as const;
    await stage(input, "export");
    const layers = await writeBackupV2EncryptedArtifact({ source: createComponentPayloadStream(input.source, inventory, bindingFingerprint, input.inventoryLimits, input.signal), outputPath: partialArtifact, encryptionKey: secret, aad: componentArtifactAadBytes(aadInput), magic: COMPONENT_ARTIFACT_MAGIC, compressionLevel: configured.compression, maxPlaintextBytes: configured.plaintext, signal: input.signal });
    await chmod(partialArtifact, 0o600).catch(() => undefined); await sync(partialArtifact);
    const manifest = createComponentArtifactManifest({ ...aadInput, nonce: layers.nonce, authTag: layers.authTag, recordCount: inventory.recordCount, bodyBytes: inventory.bodyBytes, plaintextBytes: layers.plaintextBytes, compressedBytes: layers.compressedBytes, encryptedArtifactBytes: layers.encryptedArtifactBytes, plaintextHash: layers.plaintextHash, compressedHash: layers.compressedHash, encryptedArtifactHash: layers.encryptedArtifactHash, compatibilityRef: input.compatibilityRef });
    await stage(input, "manifest_write"); const handle = await open(partialManifest, "wx", 0o600); try { await handle.writeFile(serializeComponentArtifactManifest(manifest), "utf8"); await handle.sync(); } finally { await handle.close(); }
    await stage(input, "runtime_verify"); await verifyComponentArtifact({ artifactPath: partialArtifact, manifestPath: partialManifest, encryptionKey: secret, expected: { runId: initial.runId, generationKey: initial.generationKey, artifactId: resolved.artifactId, component: input.source.component, catalogFingerprint: initial.catalogFingerprint, preflightSnapshotId: initial.preflightSnapshotId }, maxPlaintextBytes: configured.plaintext, maxCompressionRatio: configured.ratio });
    await stage(input, "authority_finalize"); const final = await authority(input, now(), ["running", "validating"]); sameAuthority(initial, final);
    await stage(input, "publish"); try { await rename(partialDirectory, resolved.finalDirectory); } catch (error) { if (error && typeof error === "object" && "code" in error && ["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error.code))) fail("BACKUP_V2_CANONICAL_ARTIFACT_CONFLICT", "Canonical component artifact already exists"); throw error; }
    partialDirectory = null;
    return { paths: resolved, manifest, evidence: evidence(manifest, input, now()), reusedCanonicalArtifact: false };
  } finally { secret.fill(0); if (partialDirectory) await rm(partialDirectory, { recursive: true, force: true }); }
}
