import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  prepareBackupV2ArtifactForStorage,
  storeBackupV2Artifact,
  storeBackupV2ArtifactsBounded,
  toCanonicalRecoveryCopyEvidence,
  verifyStoredBackupV2Artifact,
} from "../src/lib/backups/v2/artifact-storage-pipeline.ts";
import { assertIndependentCopies, validateArtifactCopyEvidence } from "../src/lib/backups/v2/artifact.ts";
import { runComponentArtifactPipeline } from "../src/lib/backups/v2/component-artifact-pipeline.ts";
import { runDatabaseArtifactPipeline } from "../src/lib/backups/v2/database-artifact-pipeline.ts";
import { createDisposableFilesystemStorageProvider } from "../src/lib/backups/v2/disposable-filesystem-storage-provider.ts";
import { CAR_ZONE_RECOVERY_POLICY, evaluateRecoverySet } from "../src/lib/backups/v2/recovery-set.ts";
import { assertCanonicalBackupV2ObjectKey } from "../src/lib/backups/v2/storage-contract.ts";
import { sha256Hex } from "../src/lib/backups/v2/database-artifact-format.ts";

const now = "2026-08-14T18:00:00.000Z";
const generationKey = `backup-v2-generation:${"4".repeat(64)}`;
const ownerRef = "worker-phase4b4";
const leaseGeneration = 12;
const catalogFingerprint = "a".repeat(64);
const encryptionKey = randomBytes(32);

function mutableAuthority() {
  const state = {
    runId: "run-phase4b4-synthetic", generationKey, state: "running", preflightOutcome: "go",
    preflightSnapshotId: "preflight-phase4b4", catalogFingerprint,
    catalogPolicyVersion: "car-zone-phase4b1-catalog-v2",
    lease: { ownerRef, acquiredAt: "2026-08-14T17:00:00.000Z", heartbeatAt: "2026-08-14T17:55:00.000Z", expiresAt: "2026-08-14T19:00:00.000Z", generation: leaseGeneration },
  };
  return { state, authority: { async read() { return structuredClone(state); } } };
}

function bodyRecord(id, bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return { id, metadata: { kind: "synthetic", label: "vehículo-ñ" }, bodyBytes: BigInt(body.length), bodySha256: sha256Hex(body), openBody: () => Readable.from([body]) };
}

function source(component, records) {
  return { component, async listPage(cursor) {
    if (cursor !== null) throw new Error("unexpected cursor");
    return { records, nextCursor: null, snapshotId: `snapshot-${component}`, complete: true };
  } };
}

function exporter() {
  const dump = Buffer.concat([Buffer.from("PGDMP", "ascii"), Buffer.from("synthetic-database".repeat(128))]);
  return { tool: "pg_dump", toolVersion: "pg_dump (PostgreSQL) 17.6", format: "postgresql_custom",
    open() { return { stream: Readable.from([dump]), completed: Promise.resolve(), cancel() {} }; } };
}

function commonPipeline(authority) {
  return { workspaceRoot: "", recoverySetId: "recovery-set-phase4b4", ownerRef, leaseGeneration,
    authority, encryptionKey, keyVersion: "synthetic-v1", keyReference: "ephemeral:test-only",
    compatibilityRef: "car-zone-phase4b4-synthetic-v1", compressionLevel: 6, clock: () => now };
}

function storageInput(sourceValue, provider, copyRole, authority, extras = {}) {
  return { source: sourceValue, provider, copyRole, ownerRef, leaseGeneration, authority,
    operationTimeoutMs: 2_000, maxAttempts: 3, retryBaseDelayMs: 1, clock: () => now, ...extras };
}

async function provider(root, id, domain, faults) {
  return createDisposableFilesystemStorageProvider({ root, providerInstanceId: id, namespaceId: "synthetic-vault", failureDomain: domain, faults });
}

function recoveryComponent(scope) {
  return { scope, artifact: "present", completion: "completed", integrity: "verified",
    compatibility: { status: "verified", backupFormatVersion: "v1", schemaCompatibilityRef: "synthetic", exporterVersion: "phase4b4", verifiedAt: now },
    copies: [
      { kind: "primary", status: "verified", verifiedAt: now, providerNeutralRef: `${scope}:primary`, copyId: `${scope}-p`, independenceDomain: "domain-primary" },
      { kind: "independent_offsite", status: "verified", verifiedAt: now, providerNeutralRef: `${scope}:secondary`, copyId: `${scope}-s`, independenceDomain: "domain-secondary" },
    ], failClosedReasons: [], evidenceOrigin: "synthetic_fixture" };
}

async function expectStoreFailure(input, codes) {
  await assert.rejects(storeBackupV2Artifact(input), (error) => codes.includes(error?.code));
}

const temp = await mkdtemp(path.join(os.tmpdir(), "car-zone-phase4b4-"));
try {
  const artifactRoot = path.join(temp, "artifacts");
  const authorityState = mutableAuthority();
  const common = commonPipeline(authorityState.authority);
  const database = await runDatabaseArtifactPipeline({ ...common, workspaceRoot: artifactRoot, exporter: exporter() });
  const metadata = await runComponentArtifactPipeline({ ...common, workspaceRoot: artifactRoot,
    source: source("storage_metadata", [bodyRecord("bucket:synthetic", "{}"), bodyRecord("objects/ñ.bin", "{}")]) });
  const componentInputs = [
    source("auth", [bodyRecord("user:synthetic", randomBytes(4 * 1024 * 1024))]),
    source("storage_objects", [bodyRecord("objects/ñ.bin", Buffer.from([0, 1, 2, 255]))]),
    source("external_assets", [bodyRecord("image:synthetic", "original-image")]),
  ];
  const auth = await runComponentArtifactPipeline({ ...common, workspaceRoot: artifactRoot, source: componentInputs[0] });
  const objects = await runComponentArtifactPipeline({ ...common, workspaceRoot: artifactRoot, source: componentInputs[1], storageMetadataArtifact: metadata.paths });
  const external = await runComponentArtifactPipeline({ ...common, workspaceRoot: artifactRoot, source: componentInputs[2] });
  const artifacts = [database, auth, metadata, objects, external];
  const prepared = await Promise.all(artifacts.map((item) => prepareBackupV2ArtifactForStorage({
    workspaceRoot: artifactRoot, artifactPath: item.paths.artifactPath, manifestPath: item.paths.manifestPath, evidence: item.evidence,
  })));

  const providerA = await provider(path.join(temp, "provider-a"), "provider-a", "domain-primary");
  const providerB = await provider(path.join(temp, "provider-b"), "provider-b", "domain-secondary");
  assert.throws(() => { prepared[0].evidence.generationKey = `backup-v2-generation:${"9".repeat(64)}`; }, TypeError);
  assert.throws(() => { providerA.descriptor.failureDomain = "mutated-domain"; }, TypeError);
  const primary = await storeBackupV2ArtifactsBounded(prepared.map((item) => storageInput(item, providerA, "primary", authorityState.authority)), 2);
  const secondary = await storeBackupV2ArtifactsBounded(prepared.map((item) => storageInput(item, providerB, "secondary_independent", authorityState.authority)), 2);
  assert.equal(primary.length, 5); assert.equal(secondary.length, 5);
  assert(primary.every((item) => item.copyEvidence.verificationStatus === "verified"));
  assertIndependentCopies(primary[0].copyEvidence, secondary[0].copyEvidence);

  const reused = await storeBackupV2Artifact(storageInput(prepared[0], providerA, "primary", authorityState.authority));
  assert.equal(reused.reusedCanonicalObject, true); assert.equal(reused.copyEvidence.copyId, primary[0].copyEvidence.copyId);
  const concurrent = await Promise.all([
    storeBackupV2Artifact(storageInput(prepared[1], providerA, "primary", authorityState.authority)),
    storeBackupV2Artifact(storageInput(prepared[1], providerA, "primary", authorityState.authority)),
  ]);
  assert.equal(concurrent[0].copyEvidence.copyId, concurrent[1].copyEvidence.copyId);

  // Provider-to-provider transport preserves ciphertext without decrypt/re-encrypt.
  const migrationRoot = path.join(temp, "provider-migration");
  const providerMigration = await provider(migrationRoot, "provider-migration", "domain-migration");
  const migrationRead = await providerA.openRead({ objectKey: primary[0].objectKey, signal: new AbortController().signal });
  await providerMigration.write({ objectKey: primary[0].objectKey, source: migrationRead,
    expectedSizeBytes: BigInt(prepared[0].evidence.ciphertextSizeBytes), signal: new AbortController().signal });
  const migrated = await storeBackupV2Artifact(storageInput(prepared[0], providerMigration, "optional_offline", authorityState.authority));
  assert.equal(migrated.reusedCanonicalObject, true);

  // Same failure domain never proves independence.
  const providerSameDomain = await provider(path.join(temp, "provider-same-domain"), "provider-same-domain", "domain-primary");
  const sameDomain = await storeBackupV2Artifact(storageInput(prepared[0], providerSameDomain, "secondary_independent", authorityState.authority));
  assert.throws(() => assertIndependentCopies(primary[0].copyEvidence, sameDomain.copyEvidence), (error) => error?.code === "BACKUP_V2_COPY_INDEPENDENCE_FAILED");

  const canonicalArtifacts = prepared.map((item, index) => ({
    artifactId: item.evidence.artifactId, generationKey, component: item.evidence.component,
    verificationStatus: "verified", ciphertextSizeBytes: item.evidence.ciphertextSizeBytes,
    ciphertextHash: item.evidence.ciphertextHash, evidenceOrigin: "runtime_verified",
    copies: [toCanonicalRecoveryCopyEvidence(primary[index].copyEvidence), toCanonicalRecoveryCopyEvidence(secondary[index].copyEvidence)],
  }));
  const recoveryInput = { policy: CAR_ZONE_RECOVERY_POLICY, components: prepared.map((item) => recoveryComponent(item.evidence.component)),
    generationKey, canonicalArtifacts, recoveryKey: { status: "availability_attested", keyVersion: "synthetic-v1",
      safeReference: "ephemeral:test-only", publicFingerprint: "e".repeat(64), attestedAt: now },
    environment: "synthetic_test", evaluatedAt: now };
  assert.equal(evaluateRecoverySet(recoveryInput).fullDrReady, true);
  const missingSecondary = canonicalArtifacts.map((item, index) => index === 2 ? { ...item, copies: item.copies.slice(0, 1) } : item);
  assert.equal(evaluateRecoverySet({ ...recoveryInput, canonicalArtifacts: missingSecondary }).fullDrReady, false);
  const crossGeneration = canonicalArtifacts.map((item, index) => index === 1 ? { ...item, generationKey: `backup-v2-generation:${"f".repeat(64)}` } : item);
  assert.equal(evaluateRecoverySet({ ...recoveryInput, canonicalArtifacts: crossGeneration }).fullDrReady, false);
  const sameDomainArtifacts = canonicalArtifacts.map((item, index) => index === 0 ? { ...item, copies: [item.copies[0], toCanonicalRecoveryCopyEvidence(sameDomain.copyEvidence)] } : item);
  assert.equal(evaluateRecoverySet({ ...recoveryInput, canonicalArtifacts: sameDomainArtifacts }).fullDrReady, false);
  const duplicatePrimary = canonicalArtifacts.map((item, index) => index === 0 ? { ...item, copies: [item.copies[0], { ...item.copies[1], copyRole: "primary" }] } : item);
  assert.equal(evaluateRecoverySet({ ...recoveryInput, canonicalArtifacts: duplicatePrimary }).fullDrReady, false);

  // Raw/unbound evidence and cross-identity claims fail before storage.
  await assert.rejects(prepareBackupV2ArtifactForStorage({ workspaceRoot: artifactRoot, artifactPath: auth.paths.artifactPath,
    manifestPath: auth.paths.manifestPath, evidence: { ...auth.evidence, verificationStatus: "unverified" } }),
    (error) => error?.code === "BACKUP_V2_UNVERIFIED_STORAGE_SOURCE");
  await assert.rejects(prepareBackupV2ArtifactForStorage({ workspaceRoot: artifactRoot, artifactPath: auth.paths.artifactPath,
    manifestPath: auth.paths.manifestPath, evidence: { ...auth.evidence, generationKey: `backup-v2-generation:${"f".repeat(64)}` } }),
    (error) => error?.code === "BACKUP_V2_SOURCE_ARTIFACT_MISMATCH");
  await assert.rejects(prepareBackupV2ArtifactForStorage({ workspaceRoot: artifactRoot, artifactPath: auth.paths.artifactPath,
    manifestPath: auth.paths.manifestPath, evidence: { ...auth.evidence, component: "storage_metadata" } }),
    (error) => error?.code === "BACKUP_V2_SOURCE_ARTIFACT_MISMATCH");
  await assert.rejects(prepareBackupV2ArtifactForStorage({ workspaceRoot: artifactRoot, artifactPath: auth.paths.artifactPath,
    manifestPath: auth.paths.manifestPath, evidence: { ...auth.evidence, artifactId: `auth-${"f".repeat(64)}` } }),
    (error) => ["BACKUP_V2_SOURCE_PATH_DENIED", "ENOENT"].includes(error?.code));

  for (const invalid of ["../escape", "..\\escape", "/absolute", "C:\\escape", "//server/share", `backup-v2/${"4".repeat(64)}/auth/../x.czb2`, "backup-v2／escape"]) {
    assert.throws(() => assertCanonicalBackupV2ObjectKey(invalid));
  }
  await assert.rejects(providerA.openRead({ objectKey: "../outside", signal: new AbortController().signal }),
    (error) => error?.code === "BACKUP_V2_STORAGE_PATH_VIOLATION");
  await assert.rejects(providerA.write({ objectKey: "C:\\outside", source: Readable.from([Buffer.alloc(0)]), expectedSizeBytes: BigInt(0), signal: new AbortController().signal }),
    (error) => error?.code === "BACKUP_V2_STORAGE_PATH_VIOLATION");
  const outside = path.join(temp, "outside"); await mkdir(outside);
  const symlinkRoot = path.join(temp, "provider-symlink"); await mkdir(symlinkRoot);
  let symlinkCreated = false;
  try { await symlink(outside, path.join(symlinkRoot, "backup-v2"), process.platform === "win32" ? "junction" : "dir"); symlinkCreated = true; } catch (error) {
    if (!["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) throw error;
  }
  if (symlinkCreated) {
    const symlinkProvider = await provider(symlinkRoot, "provider-symlink", "domain-symlink");
    await expectStoreFailure(storageInput(prepared[0], symlinkProvider, "primary", authorityState.authority, { maxAttempts: 1 }), ["BACKUP_V2_STORAGE_SYMLINK_DENIED"]);
    assert.equal((await lstat(outside)).isDirectory(), true);
  }

  async function faultCase(name, faults, expectedCodes, item = prepared[0], extras = {}) {
    const faultProvider = await provider(path.join(temp, name), name, `domain-${name}`, faults);
    await expectStoreFailure(storageInput(item, faultProvider, "primary", authorityState.authority, { maxAttempts: 1, ...extras }), expectedCodes);
    return faultProvider;
  }
  await faultCase("partial", { failWriteAfterBytes: BigInt(prepared[0].evidence.ciphertextSizeBytes) / BigInt(5) }, ["BACKUP_V2_SYNTHETIC_PARTIAL_UPLOAD"]);
  await faultCase("false-success", { falseSuccessTruncateBytes: 1 }, ["BACKUP_V2_STORED_OBJECT_STAT_MISMATCH"]);
  await faultCase("corrupt", { readMode: "corrupt" }, ["BACKUP_V2_STORED_OBJECT_INTEGRITY_MISMATCH"]);
  await faultCase("truncate-read", { readMode: "truncate" }, ["BACKUP_V2_STORED_OBJECT_INTEGRITY_MISMATCH"]);
  await faultCase("append-read", { readMode: "append" }, ["BACKUP_V2_STORED_OBJECT_INTEGRITY_MISMATCH"]);
  await faultCase("missing-read", { readMode: "missing" }, ["BACKUP_V2_STORED_OBJECT_NOT_FOUND"]);
  await faultCase("false-stat", { statSizeOverride: BigInt(1), readMode: "corrupt" }, ["BACKUP_V2_STORED_OBJECT_STAT_MISMATCH"]);
  await faultCase("wrong-stat", { statObjectKeyOverride: primary[1].objectKey }, ["BACKUP_V2_STORED_OBJECT_STAT_MISMATCH"]);

  const seededWrongRoot = path.join(temp, "wrong-object");
  const seededWrong = await provider(seededWrongRoot, "wrong-object", "domain-wrong-object");
  await storeBackupV2Artifact(storageInput(prepared[0], seededWrong, "primary", authorityState.authority));
  await storeBackupV2Artifact(storageInput(prepared[1], seededWrong, "primary", authorityState.authority));
  const wrongReader = await provider(seededWrongRoot, "wrong-object", "domain-wrong-object", { wrongObjectKey: primary[1].objectKey });
  await expectStoreFailure(storageInput(prepared[0], wrongReader, "primary", authorityState.authority, { maxAttempts: 1 }), ["BACKUP_V2_STORED_OBJECT_INTEGRITY_MISMATCH"]);

  // Existing different bytes remain immutable and are never overwritten.
  const collisionPath = await providerA.resolveObjectPathForTest(primary[0].objectKey);
  await chmod(collisionPath, 0o600);
  const collisionBytes = randomBytes(Number(prepared[0].evidence.ciphertextSizeBytes)); await writeFile(collisionPath, collisionBytes);
  await expectStoreFailure(storageInput(prepared[0], providerA, "primary", authorityState.authority, { maxAttempts: 1 }), ["BACKUP_V2_STORED_OBJECT_INTEGRITY_MISMATCH"]);
  assert.deepEqual(await readFile(collisionPath), collisionBytes);

  const rateLimited = await provider(path.join(temp, "rate-limited"), "rate-limited", "domain-rate", { transientWriteFailures: 2 });
  const retried = await storeBackupV2Artifact(storageInput(prepared[0], rateLimited, "primary", authorityState.authority));
  assert.equal(retried.copyEvidence.verificationStatus, "verified");
  await faultCase("timeout", { operationDelayMs: 100 }, ["BACKUP_V2_STORAGE_TIMEOUT"], prepared[0], { operationTimeoutMs: 20 });
  const secretProvider = await provider(path.join(temp, "secret-error"), "secret-error", "domain-secret", { transientWriteFailures: 1, secretBearingError: true });
  await assert.rejects(storeBackupV2Artifact(storageInput(prepared[0], secretProvider, "primary", authorityState.authority, { maxAttempts: 1 })),
    (error) => error?.code === "BACKUP_V2_PROVIDER_RATE_LIMITED" && !error.message.includes("secret") && !error.message.includes("token") && !error.message.includes("http"));

  const staleUpload = mutableAuthority();
  const staleProvider = await provider(path.join(temp, "stale-upload"), "stale-upload", "domain-stale-upload");
  await expectStoreFailure(storageInput(prepared[0], staleProvider, "primary", staleUpload.authority, {
    stageHook(stage) { if (stage === "authority_finalize") staleUpload.state.lease.ownerRef = "reclaimed-worker"; },
  }), ["BACKUP_V2_LEASE_NOT_AUTHORITATIVE"]);
  const staleReadback = mutableAuthority();
  const staleReadProvider = await provider(path.join(temp, "stale-readback"), "stale-readback", "domain-stale-readback");
  await expectStoreFailure(storageInput(prepared[0], staleReadProvider, "primary", staleReadback.authority, {
    stageHook(stage) { if (stage === "readback_verify") staleReadback.state.lease.ownerRef = "reclaimed-worker"; },
  }), ["BACKUP_V2_LEASE_NOT_AUTHORITATIVE"]);
  const cancelled = new AbortController(); cancelled.abort();
  await expectStoreFailure(storageInput(prepared[0], providerB, "primary", authorityState.authority, { signal: cancelled.signal }), ["BACKUP_V2_STORAGE_CANCELLED"]);

  const unknownProvider = { descriptor: { contractVersion: "backup-v2-storage-v1", providerType: "unknown-provider",
    providerInstanceId: "unknown", namespaceId: "unknown", failureDomain: null, capabilities: {} }, async write() {}, async stat() {}, async openRead() {} };
  await assert.rejects(storeBackupV2Artifact(storageInput(prepared[0], unknownProvider, "primary", authorityState.authority)),
    (error) => error?.code === "BACKUP_V2_UNKNOWN_STORAGE_PROVIDER");
  assert.throws(() => validateArtifactCopyEvidence({ ...primary[0].copyEvidence, providerNeutralRef: "https://example.invalid/object?signature=synthetic-secret" }),
    (error) => error?.code === "BACKUP_V2_UNSAFE_PROVIDER_REFERENCE");
  await assert.rejects(verifyStoredBackupV2Artifact({ source: prepared[0], provider: providerB,
    copyEvidence: { ...secondary[0].copyEvidence, providerNeutralRef: secondary[1].copyEvidence.providerNeutralRef }, maxAttempts: 1 }),
    (error) => error?.code === "BACKUP_V2_STORED_COPY_LOCATOR_MISMATCH");
  await verifyStoredBackupV2Artifact({ source: prepared[0], provider: providerB, copyEvidence: secondary[0].copyEvidence });

  const corruptSecondaryPath = await providerB.resolveObjectPathForTest(secondary[2].objectKey);
  await chmod(corruptSecondaryPath, 0o600);
  const corruptSecondaryBytes = randomBytes(Number(prepared[2].evidence.ciphertextSizeBytes));
  await writeFile(corruptSecondaryPath, corruptSecondaryBytes);
  await assert.rejects(verifyStoredBackupV2Artifact({ source: prepared[2], provider: providerB,
    copyEvidence: secondary[2].copyEvidence, maxAttempts: 1 }),
    (error) => error?.code === "BACKUP_V2_STORED_OBJECT_INTEGRITY_MISMATCH");
  const corruptedSecondaryReadiness = canonicalArtifacts.map((item, index) => index === 2 ? { ...item, copies: item.copies.slice(0, 1) } : item);
  assert.equal(evaluateRecoverySet({ ...recoveryInput, canonicalArtifacts: corruptedSecondaryReadiness }).fullDrReady, false);

  console.log(`Backup V2 Phase 4B.4 provider-neutral storage: PASS (${symlinkCreated ? "symlink tested" : "symlink creation unavailable"})`);
} finally {
  encryptionKey.fill(0);
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
