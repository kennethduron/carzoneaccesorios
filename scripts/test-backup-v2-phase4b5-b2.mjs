import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import {
  CAR_ZONE_B2_BUCKET,
  CAR_ZONE_B2_DESTINATION_ID,
  CAR_ZONE_B2_ENDPOINT,
  CAR_ZONE_B2_FAILURE_DOMAIN_ID,
  CAR_ZONE_B2_REGION,
  inspectBackblazeB2Environment,
  validateBackblazeB2RuntimeConfig,
} from "../src/lib/backups/v2/b2-config.ts";
import {
  createBackblazeB2ArtifactStorageProvider,
  classifyBackblazeB2Error,
} from "../src/lib/backups/v2/backblaze-b2-storage-provider.ts";
import {
  inspectBackblazeB2ManagedCapacity,
  planBackupV2Capacity,
} from "../src/lib/backups/v2/b2-capacity-planner.ts";
import {
  prepareBackupV2ArtifactForStorage,
  storeBackupV2Artifact,
  storeBackupV2ArtifactsBounded,
  toCanonicalRecoveryCopyEvidence,
} from "../src/lib/backups/v2/artifact-storage-pipeline.ts";
import { assertIndependentCopies } from "../src/lib/backups/v2/artifact.ts";
import { runComponentArtifactPipeline } from "../src/lib/backups/v2/component-artifact-pipeline.ts";
import { runDatabaseArtifactPipeline } from "../src/lib/backups/v2/database-artifact-pipeline.ts";
import { sha256Hex } from "../src/lib/backups/v2/database-artifact-format.ts";
import { createDisposableFilesystemStorageProvider } from "../src/lib/backups/v2/disposable-filesystem-storage-provider.ts";
import {
  blockPhase4B5ProviderPreflight,
  blockPhase4B5RealExecution,
  createPhase4B5ManualPlan,
} from "../src/lib/backups/v2/manual-workflow.ts";
import { CAR_ZONE_RECOVERY_POLICY, evaluateRecoverySet } from "../src/lib/backups/v2/recovery-set.ts";

const now = "2026-08-15T04:00:00.000Z";
const generationKey = `backup-v2-generation:${"5".repeat(64)}`;
const ownerRef = "worker-phase4b5-synthetic";
const leaseGeneration = 15;
const catalogFingerprint = "b".repeat(64);
const syntheticKeyId = "synthetic-access-key-123";
const syntheticApplicationKey = "synthetic-super-secret-456";

function providerError(name, status, headers = {}, code = null) {
  return Object.assign(new Error(`${name}: ${syntheticKeyId} ${syntheticApplicationKey}`), {
    name,
    code,
    $metadata: { httpStatusCode: status },
    $response: { headers },
  });
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

async function delay(ms, signal) {
  if (ms <= 0) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal.removeEventListener("abort", aborted); resolve(); }
    function aborted() { clearTimeout(timer); reject(abortError()); }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function collect(stream, signal) {
  const chunks = [];
  for await (const chunk of stream) {
    if (signal.aborted) throw abortError();
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

class FakeB2Transport {
  executionClass = "synthetic";
  objects = new Map();
  multipart = new Map();
  commands = [];
  putErrors = [];
  headErrors = [];
  listErrors = [];
  readMode = "normal";
  truncatePutTo = null;
  uploadPartFailure = null;
  completeCorrupt = false;
  operationDelayMs = 0;
  repeatedContinuationToken = false;
  duplicateListKey = false;
  abortCount = 0;
  putCount = 0;
  activeParts = 0;
  maxActiveParts = 0;
  onUploadPart = null;

  async headObject({ key, signal }) {
    this.commands.push("HeadObject");
    await delay(this.operationDelayMs, signal);
    const failure = this.headErrors.shift();
    if (failure) throw failure;
    const value = this.objects.get(key);
    return value === undefined
      ? { found: false, sizeBytes: null, etag: null, versionId: null }
      : { found: true, sizeBytes: BigInt(value.length), etag: `etag-${value.length}`, versionId: null };
  }

  async putObject({ key, body, signal }) {
    this.commands.push("PutObject");
    this.putCount += 1;
    await delay(this.operationDelayMs, signal);
    const failure = this.putErrors.shift();
    if (failure) throw failure;
    const value = await collect(body, signal);
    if (this.objects.has(key)) throw providerError("PreconditionFailed", 412);
    this.objects.set(key, this.truncatePutTo === null ? value : value.subarray(0, this.truncatePutTo));
  }

  async createMultipartUpload({ key, signal }) {
    this.commands.push("CreateMultipartUpload");
    await delay(this.operationDelayMs, signal);
    const uploadId = `upload-${this.multipart.size + 1}`;
    this.multipart.set(uploadId, { key, parts: new Map() });
    return { uploadId };
  }

  async uploadPart({ uploadId, partNumber, body, signal }) {
    this.commands.push("UploadPart");
    this.onUploadPart?.(partNumber);
    this.activeParts += 1;
    this.maxActiveParts = Math.max(this.maxActiveParts, this.activeParts);
    try {
      await delay(Math.max(this.operationDelayMs, 2), signal);
      if (this.uploadPartFailure === partNumber) throw providerError("InternalError", 500);
      const upload = this.multipart.get(uploadId);
      if (!upload) throw new Error("unknown synthetic upload");
      upload.parts.set(partNumber, Buffer.from(body));
      return { partNumber, etag: `part-${partNumber}` };
    } finally {
      this.activeParts -= 1;
    }
  }

  async completeMultipartUpload({ key, uploadId, parts, signal }) {
    this.commands.push("CompleteMultipartUpload");
    await delay(this.operationDelayMs, signal);
    if (this.objects.has(key)) throw providerError("PreconditionFailed", 412);
    const upload = this.multipart.get(uploadId);
    if (!upload) throw new Error("unknown synthetic upload");
    const chunks = parts.map(({ partNumber }) => upload.parts.get(partNumber));
    if (chunks.some((value) => value === undefined)) throw new Error("missing synthetic part");
    const value = Buffer.concat(chunks);
    if (this.completeCorrupt && value.length > 0) value[0] ^= 1;
    this.objects.set(key, value);
    this.multipart.delete(uploadId);
  }

  async abortMultipartUpload({ uploadId }) {
    this.commands.push("AbortMultipartUpload");
    this.abortCount += 1;
    this.multipart.delete(uploadId);
  }

  async getObject({ key, signal }) {
    this.commands.push("GetObject");
    await delay(this.operationDelayMs, signal);
    const source = this.objects.get(key);
    if (source === undefined) throw providerError("NoSuchKey", 404);
    const value = Buffer.from(source);
    if (this.readMode === "corrupt" && value.length > 0) value[0] ^= 1;
    if (this.readMode === "truncate") return Readable.from([value.subarray(0, Math.max(0, value.length - 1))]);
    if (this.readMode === "append") return Readable.from([value, Buffer.from([0])]);
    return Readable.from([value]);
  }

  async listObjectsV2({ prefix, continuationToken, maxKeys, signal }) {
    this.commands.push("ListObjectsV2");
    await delay(this.operationDelayMs, signal);
    const failure = this.listErrors.shift();
    if (failure) throw failure;
    const all = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right));
    const start = continuationToken === null ? 0 : Number(continuationToken);
    const selected = all.slice(start, start + Math.min(maxKeys, 2));
    if (this.duplicateListKey && selected.length > 0) selected.push(selected[0]);
    const next = start + selected.length < all.length ? String(start + selected.length) : null;
    return {
      objects: selected.map(([key, value]) => ({ key, sizeBytes: BigInt(value.length) })),
      nextContinuationToken: this.repeatedContinuationToken && continuationToken !== null ? continuationToken : next,
    };
  }
}

function config(overrides = {}) {
  return validateBackblazeB2RuntimeConfig({
    endpoint: CAR_ZONE_B2_ENDPOINT,
    region: CAR_ZONE_B2_REGION,
    bucket: CAR_ZONE_B2_BUCKET,
    accessKeyId: syntheticKeyId,
    applicationKey: syntheticApplicationKey,
    keyScope: "bucket-restricted",
    destinationId: CAR_ZONE_B2_DESTINATION_ID,
    failureDomainId: CAR_ZONE_B2_FAILURE_DOMAIN_ID,
    softBudgetBytes: "8000000000",
    ...overrides,
  });
}

function mutableAuthority() {
  const state = {
    runId: "run-phase4b5-synthetic",
    generationKey,
    state: "running",
    preflightOutcome: "go",
    preflightSnapshotId: "preflight-phase4b5",
    catalogFingerprint,
    catalogPolicyVersion: "car-zone-phase4b1-catalog-v2",
    lease: {
      ownerRef,
      acquiredAt: "2026-08-15T03:00:00.000Z",
      heartbeatAt: "2026-08-15T03:55:00.000Z",
      expiresAt: "2026-08-15T05:00:00.000Z",
      generation: leaseGeneration,
    },
  };
  return { state, authority: { async read() { return structuredClone(state); } } };
}

function bodyRecord(id, bytes) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return {
    id,
    metadata: { kind: "synthetic", label: "phase4b5" },
    bodyBytes: BigInt(body.length),
    bodySha256: sha256Hex(body),
    openBody: () => Readable.from([body]),
  };
}

function source(component, records) {
  return {
    component,
    async listPage(cursor) {
      if (cursor !== null) throw new Error("unexpected synthetic cursor");
      return { records, nextCursor: null, snapshotId: `snapshot-${component}`, complete: true };
    },
  };
}

function exporter() {
  const dump = Buffer.from(`PGDMP${"synthetic-database".repeat(256)}`, "utf8");
  return {
    tool: "pg_dump",
    toolVersion: "pg_dump (PostgreSQL) 17.6",
    format: "postgresql_custom",
    open() { return { stream: Readable.from([dump]), completed: Promise.resolve(), cancel() {} }; },
  };
}

function commonPipeline(workspaceRoot, authority) {
  return {
    workspaceRoot,
    recoverySetId: "recovery-set-phase4b5",
    ownerRef,
    leaseGeneration,
    authority,
    encryptionKey: randomBytes(32),
    keyVersion: "synthetic-v1",
    keyReference: "ephemeral:test-only",
    compatibilityRef: "car-zone-phase4b5-synthetic-v1",
    compressionLevel: 6,
    clock: () => now,
  };
}

function storageInput(item, provider, authority, extras = {}) {
  return {
    source: item,
    provider,
    copyRole: "primary",
    ownerRef,
    leaseGeneration,
    authority,
    operationTimeoutMs: 5_000,
    maxAttempts: 3,
    retryBaseDelayMs: 0,
    clock: () => now,
    ...extras,
  };
}

function recoveryComponent(scope, includeSecondary) {
  const copies = [{
    kind: "primary",
    status: "verified",
    verifiedAt: now,
    providerNeutralRef: `${scope}:b2-primary`,
    copyId: `${scope}-b2-p`,
    independenceDomain: CAR_ZONE_B2_FAILURE_DOMAIN_ID,
  }];
  if (includeSecondary) copies.push({
    kind: "independent_offsite",
    status: "verified",
    verifiedAt: now,
    providerNeutralRef: `${scope}:synthetic-secondary`,
    copyId: `${scope}-s`,
    independenceDomain: "synthetic-independent-domain",
  });
  return {
    scope,
    artifact: "present",
    completion: "completed",
    integrity: "verified",
    compatibility: {
      status: "verified",
      backupFormatVersion: "v1",
      schemaCompatibilityRef: "synthetic",
      exporterVersion: "phase4b5",
      verifiedAt: now,
    },
    copies,
    failClosedReasons: [],
    evidenceOrigin: "synthetic_fixture",
  };
}

async function createArtifacts(root, authority) {
  const common = commonPipeline(root, authority);
  const database = await runDatabaseArtifactPipeline({ ...common, exporter: exporter() });
  const metadata = await runComponentArtifactPipeline({
    ...common,
    source: source("storage_metadata", [
      bodyRecord("bucket:synthetic", "{}"),
      bodyRecord("object:synthetic", "{}"),
    ]),
  });
  const auth = await runComponentArtifactPipeline({
    ...common,
    source: source("auth", [bodyRecord("user:synthetic", randomBytes(12 * 1024 * 1024))]),
  });
  const storageObjects = await runComponentArtifactPipeline({
    ...common,
    source: source("storage_objects", [bodyRecord("object:synthetic", randomBytes(64 * 1024))]),
    storageMetadataArtifact: metadata.paths,
  });
  const externalAssets = await runComponentArtifactPipeline({
    ...common,
    source: source("external_assets", [bodyRecord("asset:synthetic", randomBytes(64 * 1024))]),
  });
  const artifacts = [database, auth, metadata, storageObjects, externalAssets];
  return Promise.all(artifacts.map((item) => prepareBackupV2ArtifactForStorage({
    workspaceRoot: root,
    artifactPath: item.paths.artifactPath,
    manifestPath: item.paths.manifestPath,
    evidence: item.evidence,
  })));
}

async function expectStoreFailure(input, codes) {
  await assert.rejects(storeBackupV2Artifact(input), (error) => codes.includes(error?.code));
}

export async function runPhase4B5SyntheticWorkflow({ manual = false } = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "car-zone-phase4b5-"));
  try {
    // Exact destination validation and arbitrary endpoint denial.
    const validConfig = config();
    assert.equal(validConfig.endpoint, CAR_ZONE_B2_ENDPOINT);
    assert.equal(validConfig.keyScope, "bucket-restricted");
    for (const endpoint of [
      "http://s3.us-east-005.backblazeb2.com",
      "https://evil.example.com",
      "https://localhost",
      "https://127.0.0.1",
      "https://s3.us-east-005.backblazeb2.com.evil.com",
      "https://user:password@s3.us-east-005.backblazeb2.com",
      "https://s3.us-east-005.backblazeb2.com?token=secret",
    ]) assert.throws(() => config({ endpoint }), (error) => error?.code === "BACKUP_V2_B2_ENDPOINT_REJECTED");
    assert.throws(() => config({ region: "us-west-004" }));
    assert.throws(() => config({ bucket: "other-bucket" }));
    assert.throws(() => config({ destinationId: "unsafe" }));
    assert.throws(() => config({ failureDomainId: "unsafe" }));
    assert.throws(() => config({ keyScope: "master" }), (error) => error?.code === "BACKUP_V2_B2_MASTER_KEY_DENIED");
    assert.throws(() => config({ accessKeyId: "" }));
    assert.throws(() => config({ softBudgetBytes: "-1" }));
    assert.throws(() => config({ softBudgetBytes: "not-a-number" }));
    assert.equal(validConfig.configFingerprint, config({
      accessKeyId: "different-synthetic-key",
      applicationKey: "different-synthetic-secret",
    }).configFingerprint);

    const environmentPlan = createPhase4B5ManualPlan({});
    assert.equal(environmentPlan.productionConnections, 0);
    assert.equal(environmentPlan.realExecution, "BLOCKED_UNTIL_PHASE_4B6");
    assert.equal(environmentPlan.capacity.uploadAuthorization, "denied");
    assert.equal(inspectBackblazeB2Environment({}).credentialsPresent, false);
    assert.throws(blockPhase4B5ProviderPreflight, (error) => error?.code === "REAL_B2_PREFLIGHT_BLOCKED_UNTIL_CONTROLLED_RELEASE");
    assert.throws(blockPhase4B5RealExecution, (error) => error?.code === "REAL_BACKUP_V2_EXECUTION_BLOCKED_UNTIL_PHASE_4B6");

    const authorityState = mutableAuthority();
    const artifactRoot = path.join(temp, "artifacts");
    const prepared = await createArtifacts(artifactRoot, authorityState.authority);
    assert.deepEqual(prepared.map((item) => item.evidence.component).sort(), [
      "auth", "database", "external_assets", "storage_metadata", "storage_objects",
    ]);

    const primaryTransport = new FakeB2Transport();
    const primaryProvider = createBackblazeB2ArtifactStorageProvider({
      config: validConfig,
      transport: primaryTransport,
      expectedConfigFingerprint: validConfig.configFingerprint,
    });
    assert.equal(primaryProvider.descriptor.providerType, "backblaze_b2");
    assert.deepEqual(primaryProvider.descriptor.allowedCopyRoles, ["primary"]);
    assert.throws(() => createBackblazeB2ArtifactStorageProvider({
      config: validConfig,
      transport: new FakeB2Transport(),
      expectedConfigFingerprint: "0".repeat(64),
    }), (error) => error?.code === "BACKUP_V2_B2_DESTINATION_DRIFT");
    const realClassTransport = new FakeB2Transport();
    realClassTransport.executionClass = "real";
    const hardBlockedProvider = createBackblazeB2ArtifactStorageProvider({
      config: validConfig,
      transport: realClassTransport,
    });
    await expectStoreFailure(storageInput(prepared[0], hardBlockedProvider, authorityState.authority, {
      maxAttempts: 1,
    }), ["REAL_BACKUP_V2_EXECUTION_BLOCKED_UNTIL_PHASE_4B6"]);
    assert.deepEqual(realClassTransport.commands, []);

    const primary = await storeBackupV2ArtifactsBounded(
      prepared.map((item) => storageInput(item, primaryProvider, authorityState.authority)),
      2,
    );
    assert.equal(primary.length, 5);
    assert(primary.every((result) => result.copyEvidence.copyRole === "primary"));
    assert(primary.every((result) => result.copyEvidence.independenceDomain === CAR_ZONE_B2_FAILURE_DOMAIN_ID));
    assert(!primaryTransport.commands.some((command) => [
      "ListBuckets", "HeadBucket", "CreateBucket", "DeleteBucket", "PutObjectTagging",
      "GetObjectTagging", "DeleteObject", "PutLifecycleConfiguration", "PutObjectLockConfiguration",
    ].includes(command)));

    await expectStoreFailure({
      ...storageInput(prepared[0], primaryProvider, authorityState.authority),
      copyRole: "secondary_independent",
    }, ["BACKUP_V2_STORAGE_COPY_ROLE_DENIED"]);
    const falseSecondary = {
      ...primary[0].copyEvidence,
      copyId: `${primary[0].copyEvidence.copyId}-false-secondary`,
      copyRole: "secondary_independent",
      providerNeutralRef: `${primary[0].copyEvidence.providerNeutralRef}-another-object`,
    };
    assert.throws(() => assertIndependentCopies(primary[0].copyEvidence, falseSecondary),
      (error) => error?.code === "BACKUP_V2_COPY_INDEPENDENCE_FAILED");

    const secondaryProvider = await createDisposableFilesystemStorageProvider({
      root: path.join(temp, "synthetic-secondary"),
      providerInstanceId: "synthetic-secondary",
      namespaceId: "synthetic-vault",
      failureDomain: "synthetic-independent-domain",
    });
    const secondary = await storeBackupV2ArtifactsBounded(prepared.map((item) => ({
      ...storageInput(item, secondaryProvider, authorityState.authority),
      copyRole: "secondary_independent",
    })), 2);
    const canonicalPrimaryOnly = prepared.map((item, index) => ({
      artifactId: item.evidence.artifactId,
      generationKey,
      component: item.evidence.component,
      verificationStatus: "verified",
      ciphertextSizeBytes: item.evidence.ciphertextSizeBytes,
      ciphertextHash: item.evidence.ciphertextHash,
      evidenceOrigin: "runtime_verified",
      copies: [toCanonicalRecoveryCopyEvidence(primary[index].copyEvidence)],
    }));
    const recoveryKey = {
      status: "availability_attested",
      keyVersion: "synthetic-v1",
      safeReference: "ephemeral:test-only",
      publicFingerprint: "e".repeat(64),
      attestedAt: now,
    };
    const baseRecovery = {
      policy: CAR_ZONE_RECOVERY_POLICY,
      generationKey,
      recoveryKey,
      environment: "synthetic_test",
      evaluatedAt: now,
    };
    assert.equal(evaluateRecoverySet({
      ...baseRecovery,
      components: prepared.map((item) => recoveryComponent(item.evidence.component, false)),
      canonicalArtifacts: canonicalPrimaryOnly,
    }).fullDrReady, false);
    const canonicalWithSecondary = canonicalPrimaryOnly.map((item, index) => ({
      ...item,
      copies: [...item.copies, toCanonicalRecoveryCopyEvidence(secondary[index].copyEvidence)],
    }));
    assert.equal(evaluateRecoverySet({
      ...baseRecovery,
      components: prepared.map((item) => recoveryComponent(item.evidence.component, true)),
      canonicalArtifacts: canonicalWithSecondary,
    }).fullDrReady, true);

    // Same bytes are reused; different bytes, corruption, truncation and appended bytes fail closed.
    const reused = await storeBackupV2Artifact(storageInput(prepared[0], primaryProvider, authorityState.authority));
    assert.equal(reused.reusedCanonicalObject, true);
    const collisionTransport = new FakeB2Transport();
    collisionTransport.objects.set(primary[0].objectKey, randomBytes(Number(prepared[0].evidence.ciphertextSizeBytes)));
    const collisionProvider = createBackblazeB2ArtifactStorageProvider({ config: validConfig, transport: collisionTransport });
    const collisionBytes = Buffer.from(collisionTransport.objects.get(primary[0].objectKey));
    await expectStoreFailure(storageInput(prepared[0], collisionProvider, authorityState.authority, { maxAttempts: 1 }), [
      "BACKUP_V2_STORED_OBJECT_INTEGRITY_MISMATCH",
    ]);
    assert.deepEqual(collisionTransport.objects.get(primary[0].objectKey), collisionBytes);
    for (const mode of ["corrupt", "truncate", "append"]) {
      const transport = new FakeB2Transport();
      const provider = createBackblazeB2ArtifactStorageProvider({ config: validConfig, transport });
      transport.readMode = mode;
      await expectStoreFailure(storageInput(prepared[0], provider, authorityState.authority, { maxAttempts: 1 }), [
        "BACKUP_V2_STORED_OBJECT_INTEGRITY_MISMATCH",
      ]);
    }
    const partialTransport = new FakeB2Transport();
    partialTransport.truncatePutTo = 1;
    await expectStoreFailure(storageInput(prepared[0], createBackblazeB2ArtifactStorageProvider({
      config: validConfig, transport: partialTransport,
    }), authorityState.authority, { maxAttempts: 1 }), ["BACKUP_V2_STORED_OBJECT_STAT_MISMATCH"]);

    // Conditional create resolves a concurrent duplicate to one canonical object.
    const duplicateTransport = new FakeB2Transport();
    const duplicateProvider = createBackblazeB2ArtifactStorageProvider({ config: validConfig, transport: duplicateTransport });
    const duplicates = await Promise.all([
      storeBackupV2Artifact(storageInput(prepared[2], duplicateProvider, authorityState.authority)),
      storeBackupV2Artifact(storageInput(prepared[2], duplicateProvider, authorityState.authority)),
    ]);
    assert.equal(duplicates[0].copyEvidence.copyId, duplicates[1].copyEvidence.copyId);
    assert.equal(duplicateTransport.objects.size, 1);

    // Retry classification is bounded, secret-safe and honors provider retry hints.
    const rateTransport = new FakeB2Transport();
    rateTransport.putErrors.push(
      providerError("SlowDown", 503, { "retry-after": "0" }),
      providerError("SlowDown", 503, { "retry-after": "0" }),
    );
    await storeBackupV2Artifact(storageInput(prepared[0], createBackblazeB2ArtifactStorageProvider({
      config: validConfig, transport: rateTransport,
    }), authorityState.authority));
    assert.equal(rateTransport.putCount, 3);
    const permanentRate = classifyBackblazeB2Error(providerError("SlowDown", 503, { "retry-after": "999999" }));
    assert.equal(permanentRate.retryable, true);
    assert.equal(permanentRate.retryAfterMs, 10_000);
    assert(!permanentRate.message.includes(syntheticKeyId));
    assert(!permanentRate.message.includes(syntheticApplicationKey));
    const exhaustedTransport = new FakeB2Transport();
    exhaustedTransport.putErrors.push(
      providerError("SlowDown", 503), providerError("SlowDown", 503), providerError("SlowDown", 503),
    );
    await expectStoreFailure(storageInput(prepared[1], createBackblazeB2ArtifactStorageProvider({
      config: validConfig, transport: exhaustedTransport,
    }), authorityState.authority), ["BACKUP_V2_B2_RATE_LIMITED"]);
    assert.equal(exhaustedTransport.putCount, 3);
    for (const [name, status, code] of [
      ["AccessDenied", 403, "BACKUP_V2_B2_AUTHENTICATION_REJECTED"],
      ["InvalidAccessKeyId", 403, "BACKUP_V2_B2_AUTHENTICATION_REJECTED"],
      ["SignatureDoesNotMatch", 403, "BACKUP_V2_B2_AUTHENTICATION_REJECTED"],
      ["NoSuchBucket", 404, "CONFIGURED_B2_BUCKET_NOT_ACCESSIBLE"],
    ]) {
      const value = classifyBackblazeB2Error(providerError(name, status));
      assert.equal(value.code, code);
      assert.equal(value.retryable, false);
      assert(!value.message.includes("synthetic"));
    }

    const timeoutTransport = new FakeB2Transport();
    timeoutTransport.operationDelayMs = 100;
    await expectStoreFailure(storageInput(prepared[0], createBackblazeB2ArtifactStorageProvider({
      config: validConfig, transport: timeoutTransport,
    }), authorityState.authority, { operationTimeoutMs: 10, maxAttempts: 1 }), ["BACKUP_V2_STORAGE_TIMEOUT"]);

    // Multipart uses bounded batches, exact completion, abort on failure/cancellation, and readback.
    const multipartTransport = new FakeB2Transport();
    const multipartProvider = createBackblazeB2ArtifactStorageProvider({
      config: validConfig,
      transport: multipartTransport,
      multipartThresholdBytes: BigInt(5 * 1024 * 1024),
      multipartPartSizeBytes: 5 * 1024 * 1024,
      multipartConcurrency: 2,
    });
    const authItem = prepared.find((item) => item.evidence.component === "auth");
    assert(authItem);
    await storeBackupV2Artifact(storageInput(authItem, multipartProvider, authorityState.authority));
    assert(multipartTransport.commands.includes("CreateMultipartUpload"));
    assert(multipartTransport.commands.includes("CompleteMultipartUpload"));
    assert(multipartTransport.maxActiveParts <= 2);
    assert(multipartTransport.maxActiveParts >= 1);

    const failedMultipart = new FakeB2Transport();
    failedMultipart.uploadPartFailure = 2;
    await expectStoreFailure(storageInput(authItem, createBackblazeB2ArtifactStorageProvider({
      config: validConfig,
      transport: failedMultipart,
      multipartThresholdBytes: BigInt(5 * 1024 * 1024),
      multipartPartSizeBytes: 5 * 1024 * 1024,
      multipartConcurrency: 2,
    }), authorityState.authority, { maxAttempts: 1 }), ["BACKUP_V2_B2_UNAVAILABLE"]);
    assert.equal(failedMultipart.abortCount, 1);
    const corruptMultipart = new FakeB2Transport();
    corruptMultipart.completeCorrupt = true;
    await expectStoreFailure(storageInput(authItem, createBackblazeB2ArtifactStorageProvider({
      config: validConfig,
      transport: corruptMultipart,
      multipartThresholdBytes: BigInt(5 * 1024 * 1024),
      multipartPartSizeBytes: 5 * 1024 * 1024,
      multipartConcurrency: 2,
    }), authorityState.authority, { maxAttempts: 1 }), ["BACKUP_V2_STORED_OBJECT_INTEGRITY_MISMATCH"]);

    const cancelledTransport = new FakeB2Transport();
    cancelledTransport.operationDelayMs = 30;
    const cancelledProvider = createBackblazeB2ArtifactStorageProvider({
      config: validConfig,
      transport: cancelledTransport,
      multipartThresholdBytes: BigInt(5 * 1024 * 1024),
      multipartPartSizeBytes: 5 * 1024 * 1024,
      multipartConcurrency: 1,
    });
    const controller = new AbortController();
    cancelledTransport.onUploadPart = (partNumber) => {
      if (partNumber === 1) setTimeout(() => controller.abort(), 5);
    };
    const pending = cancelledProvider.write({
      objectKey: primary.find((item) => item.copyEvidence.artifactId === authItem.evidence.artifactId).objectKey,
      source: createReadStream(authItem.artifactPath),
      expectedSizeBytes: BigInt(authItem.evidence.ciphertextSizeBytes),
      signal: controller.signal,
    });
    await assert.rejects(pending, (error) => error?.code === "BACKUP_V2_STORAGE_CANCELLED");
    assert.equal(cancelledTransport.abortCount, 1);

    // Lease fencing denies evidence after upload or before readback finalization.
    for (const stageName of ["authority_finalize", "readback_verify"]) {
      const stale = mutableAuthority();
      const transport = new FakeB2Transport();
      await expectStoreFailure(storageInput(prepared[4], createBackblazeB2ArtifactStorageProvider({
        config: validConfig, transport,
      }), stale.authority, {
        stageHook(stage) { if (stage === stageName) stale.state.lease.ownerRef = "reclaimed-worker"; },
      }), ["BACKUP_V2_LEASE_NOT_AUTHORITATIVE"]);
    }

    // Exact bigint capacity decisions: equality is allowed; overage and unknowns are denied.
    const componentSizes = [
      100_000_000n, 100_000_000n, 100_000_000n, 100_000_000n, 100_000_000n,
    ].map((encryptedBytes, index) => ({ component: [
      "database", "auth", "storage_metadata", "storage_objects", "external_assets",
    ][index], encryptedBytes }));
    assert.equal(planBackupV2Capacity({
      components: componentSizes,
      currentManagedBytes: 7_000_000_000n,
      softBudgetBytes: 8_000_000_000n,
    }).uploadAuthorization, "allowed");
    assert.equal(planBackupV2Capacity({
      components: componentSizes.map((item) => ({ ...item, encryptedBytes: 120_000_000n })),
      currentManagedBytes: 7_700_000_000n,
      softBudgetBytes: 8_000_000_000n,
    }).uploadAuthorization, "denied");
    assert.equal(planBackupV2Capacity({
      components: componentSizes,
      currentManagedBytes: 7_500_000_000n,
      softBudgetBytes: 8_000_000_000n,
    }).uploadAuthorization, "allowed");
    assert.equal(planBackupV2Capacity({
      components: componentSizes,
      currentManagedBytes: null,
      softBudgetBytes: null,
    }).uploadAuthorization, "denied");

    // Read-only managed-prefix preflight paginates, counts unknowns, and fails on loops/duplicates.
    const listTransport = new FakeB2Transport();
    for (const result of primary) listTransport.objects.set(result.objectKey, Buffer.alloc(3));
    listTransport.objects.set("backup-v2/unmanaged-object", Buffer.alloc(7));
    listTransport.objects.set("unrelated/object", Buffer.alloc(100));
    const report = await inspectBackblazeB2ManagedCapacity({ config: validConfig, transport: listTransport });
    assert.equal(report.objectCount, 6);
    assert.equal(report.managedBytes, 22n);
    assert.equal(report.unmanagedObjectRefs.length, 1);
    assert.match(report.unmanagedObjectRefs[0], /^sha256:[0-9a-f]{64}$/);
    assert(!report.unmanagedObjectRefs[0].includes("unmanaged-object"));
    assert(report.pagesRead > 1);
    assert(listTransport.commands.every((command) => command === "ListObjectsV2"));
    const repeated = new FakeB2Transport();
    repeated.objects = new Map(listTransport.objects);
    repeated.repeatedContinuationToken = true;
    await assert.rejects(inspectBackblazeB2ManagedCapacity({ config: validConfig, transport: repeated }),
      (error) => error?.code === "BACKUP_V2_B2_PAGINATION_LOOP");
    const duplicate = new FakeB2Transport();
    duplicate.objects = new Map(listTransport.objects);
    duplicate.duplicateListKey = true;
    await assert.rejects(inspectBackblazeB2ManagedCapacity({ config: validConfig, transport: duplicate }),
      (error) => error?.code === "BACKUP_V2_B2_LIST_RESPONSE_INVALID");

    const summary = Object.freeze({
      phase: "4B.5",
      mode: manual ? "synthetic_manual_execution" : "synthetic_adversarial_test",
      provider: "backblaze-b2",
      componentsStored: primary.length,
      primaryCopiesVerified: primary.length,
      b2OnlyFullDrReady: false,
      independentSyntheticFullDrReady: true,
      realB2Connections: 0,
      productionConnections: 0,
      remoteObjectsCreated: 0,
      realExecution: "BLOCKED_UNTIL_PHASE_4B6",
      status: "pass",
    });
    if (!manual) process.stdout.write("Backup V2 Phase 4B.5 B2 synthetic/adversarial tests passed.\n");
    return summary;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (import.meta.url === invokedPath) {
  await runPhase4B5SyntheticWorkflow();
}
