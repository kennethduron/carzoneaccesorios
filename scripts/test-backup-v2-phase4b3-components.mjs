import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFile, copyFile, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import { runComponentArtifactPipeline, verifyComponentArtifact } from "../src/lib/backups/v2/component-artifact-pipeline.ts";
import { validateComponentArtifactManifest } from "../src/lib/backups/v2/component-artifact-format.ts";
import { collectComponentInventory } from "../src/lib/backups/v2/component-payload.ts";
import {
  AUTH_TRANSIENT_TABLES,
  createAuthSchemaSource,
  createCloudinaryOriginalsSource,
  createStorageMetadataSource,
  createStorageObjectsSource,
} from "../src/lib/backups/v2/component-sources.ts";
import { canonicalJson, sha256Hex } from "../src/lib/backups/v2/database-artifact-format.ts";
import { CAR_ZONE_RECOVERY_POLICY, evaluateRecoverySet } from "../src/lib/backups/v2/recovery-set.ts";

const now = "2026-08-14T15:00:00.000Z";
const generationKey = `backup-v2-generation:${"b".repeat(64)}`;
const encryptionKey = randomBytes(32);

function authority() {
  return { async read() { return {
    runId: "run-phase4b3-synthetic", generationKey, state: "running", preflightOutcome: "go",
    preflightSnapshotId: "preflight-phase4b3", catalogFingerprint: "a".repeat(64),
    catalogPolicyVersion: "car-zone-phase4b1-catalog-v2",
    lease: { ownerRef: "worker-phase4b3", acquiredAt: "2026-08-14T14:00:00.000Z", heartbeatAt: "2026-08-14T14:55:00.000Z", expiresAt: "2026-08-14T16:00:00.000Z", generation: 9 },
  }; } };
}

function mutableAuthority() {
  const state = {
    runId: "run-phase4b3-synthetic", generationKey, state: "running", preflightOutcome: "go",
    preflightSnapshotId: "preflight-phase4b3", catalogFingerprint: "a".repeat(64),
    catalogPolicyVersion: "car-zone-phase4b1-catalog-v2",
    lease: { ownerRef: "worker-phase4b3", acquiredAt: "2026-08-14T14:00:00.000Z", heartbeatAt: "2026-08-14T14:55:00.000Z", expiresAt: "2026-08-14T16:00:00.000Z", generation: 9 },
  };
  return { state, authority: { async read() { return structuredClone(state); } } };
}

function input(workspaceRoot, source, extras = {}) {
  return { workspaceRoot, recoverySetId: "recovery-set-synthetic", ownerRef: "worker-phase4b3", leaseGeneration: 9,
    authority: authority(), source, encryptionKey, keyVersion: "synthetic-v1", keyReference: "secret-manager://backup-v2/test",
    compatibilityRef: "car-zone-phase4b3-synthetic-restore-v1", compressionLevel: 6, clock: () => now, ...extras };
}

function bodyRecord(id, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return { id, metadata: { kind: "synthetic" }, bodyBytes: BigInt(bytes.length), bodySha256: sha256Hex(bytes), openBody: () => Readable.from([bytes]) };
}

function memorySource(component, records, options = {}) {
  let calls = 0;
  return { component, async listPage(cursor) {
    calls += 1;
    const snapshotId = options.drift && calls > 1 ? "snapshot-mutated" : "snapshot-stable";
    const page = cursor === null ? records.slice(0, 1) : records.slice(1);
    const nextCursor = cursor === null && records.length > 1 ? "page-2" : null;
    return { records: page, nextCursor, snapshotId, complete: nextCursor === null };
  } };
}

function recoveryComponent(scope) {
  return { scope, artifact: "present", completion: "completed", integrity: "verified",
    compatibility: { status: "verified", backupFormatVersion: "v1", schemaCompatibilityRef: "synthetic", exporterVersion: "phase4b3", verifiedAt: now },
    copies: [
      { kind: "primary", status: "verified", verifiedAt: now, providerNeutralRef: `${scope}:primary`, copyId: `${scope}-p`, independenceDomain: "primary-domain" },
      { kind: "independent_offsite", status: "verified", verifiedAt: now, providerNeutralRef: `${scope}:offsite`, copyId: `${scope}-o`, independenceDomain: "offsite-domain" },
    ], failClosedReasons: [], evidenceOrigin: "synthetic_fixture" };
}

const workspace = await mkdtemp(path.join(os.tmpdir(), "car-zone-phase4b3-"));
try {
  const zero = Buffer.alloc(0);
  const sources = [
    memorySource("auth", [bodyRecord("users:α", canonicalJson({ encrypted_password: "$2a$synthetic", id: "α" }))]),
    memorySource("storage_metadata", [bodyRecord("bucket:empty", canonicalJson({ bucket: "empty", public: false })), bodyRecord("nested/ñ/zero.bin", canonicalJson({ bucket: "public", key: "nested/ñ/zero.bin" })), bodyRecord("nested/图片/a.bin", canonicalJson({ bucket: "public", key: "nested/图片/a.bin" }))]),
    memorySource("storage_objects", [bodyRecord("nested/ñ/zero.bin", zero), bodyRecord("nested/图片/a.bin", Buffer.from([0, 1, 2, 255]))]),
    memorySource("external_assets", [bodyRecord("image:car-zone/original:v1", Buffer.from("original-cloudinary-bytes"))]),
  ];
  const results = [];
  for (const source of sources) {
    const extras = source.component === "storage_objects" ? { storageMetadataArtifact: results[1].paths } : {};
    const result = await runComponentArtifactPipeline(input(workspace, source, extras));
    assert.equal(result.manifest.component, source.component);
    assert.equal(result.evidence.verificationStatus, "verified");
    assert.equal(result.reusedCanonicalArtifact, false);
    results.push(result);
  }

  const reused = await runComponentArtifactPipeline(input(workspace, sources[0]));
  assert.equal(reused.reusedCanonicalArtifact, true, "canonical retry must verify and reuse");

  await assert.rejects(
    runComponentArtifactPipeline(input(path.join(workspace, "missing-binding"), memorySource("storage_objects", [bodyRecord("a", zero)]))),
    (error) => error?.code === "BACKUP_V2_STORAGE_METADATA_BINDING_REQUIRED",
  );
  await assert.rejects(
    runComponentArtifactPipeline(input(path.join(workspace, "missing-relationship"), memorySource("storage_objects", [bodyRecord("not-in-metadata", zero)]), { storageMetadataArtifact: results[1].paths })),
    (error) => error?.code === "BACKUP_V2_STORAGE_METADATA_RELATIONSHIP_MISSING",
  );
  await assert.rejects(
    collectComponentInventory(memorySource("auth", [bodyRecord("duplicate", Buffer.from("a")), bodyRecord("duplicate", Buffer.from("b"))])),
    (error) => error?.code === "BACKUP_V2_DUPLICATE_SOURCE_RECORD",
  );
  await assert.rejects(
    collectComponentInventory({ component: "auth", async listPage() { return { records: [], nextCursor: null, snapshotId: "partial", complete: false }; } }),
    (error) => error?.code === "BACKUP_V2_PARTIAL_PAGINATION",
  );
  await assert.rejects(
    collectComponentInventory({ component: "external_assets", async listPage() { return { records: [], nextCursor: "loop", snapshotId: "loop", complete: false }; } }),
    (error) => error?.code === "BACKUP_V2_INVALID_PAGINATION_CURSOR",
  );
  let retryCalls = 0;
  const retried = await collectComponentInventory({ component: "auth", async listPage() { retryCalls += 1; if (retryCalls < 3) throw new Error("synthetic 429"); return { records: [], nextCursor: null, snapshotId: "retry", complete: true }; } });
  assert.equal(retried.recordCount, 0n); assert.equal(retryCalls, 3, "transient source failures use bounded retries");
  const sensitiveProviderError = "postgres://user:secret@example.invalid/auth?token=do-not-log";
  await assert.rejects(
    collectComponentInventory({ component: "auth", async listPage() { throw new Error(sensitiveProviderError); } }, { maxRetries: 0 }),
    (error) => error?.code === "BACKUP_V2_SOURCE_RETRY_EXHAUSTED" && !error.message.includes("secret") && !error.message.includes("token"),
  );
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(collectComponentInventory(memorySource("auth", []), {}, cancelled.signal), (error) => error?.code === "BACKUP_V2_EXPORT_CANCELLED");
  const canonicalA = await collectComponentInventory(memorySource("storage_metadata", [bodyRecord("z", Buffer.from("z")), bodyRecord("a", Buffer.from("a"))]));
  const canonicalB = await collectComponentInventory(memorySource("storage_metadata", [bodyRecord("a", Buffer.from("a")), bodyRecord("z", Buffer.from("z"))]));
  assert.equal(canonicalA.fingerprint, canonicalB.fingerprint, "inventory identity must not depend on provider order");
  const driftRoot = path.join(workspace, "drift");
  await assert.rejects(runComponentArtifactPipeline(input(driftRoot, memorySource("external_assets", [bodyRecord("asset", Buffer.from("x"))], { drift: true }))), (error) => error?.code === "BACKUP_V2_SOURCE_DRIFT");
  assert.equal((await readdir(driftRoot)).length, 0, "failed export must remove partial artifacts");

  await appendFile(results[1].paths.artifactPath, Buffer.from("tamper"));
  await assert.rejects(verifyComponentArtifact({ artifactPath: results[1].paths.artifactPath, manifestPath: results[1].paths.manifestPath, encryptionKey,
    expected: { runId: "run-phase4b3-synthetic", generationKey, artifactId: results[1].paths.artifactId, component: "storage_metadata", catalogFingerprint: "a".repeat(64), preflightSnapshotId: "preflight-phase4b3" } }),
    (error) => error?.code === "BACKUP_V2_ENCRYPTED_ARTIFACT_INTEGRITY_FAILED");

  const authExpected = { runId: "run-phase4b3-synthetic", generationKey, artifactId: results[0].paths.artifactId, component: "auth", catalogFingerprint: "a".repeat(64), preflightSnapshotId: "preflight-phase4b3" };
  await assert.rejects(verifyComponentArtifact({ artifactPath: results[0].paths.artifactPath, manifestPath: results[0].paths.manifestPath, encryptionKey: randomBytes(32), expected: authExpected }), (error) => error?.code === "BACKUP_V2_WRONG_ENCRYPTION_KEY");
  await assert.rejects(verifyComponentArtifact({ artifactPath: results[0].paths.artifactPath, manifestPath: results[0].paths.manifestPath, encryptionKey, expected: { ...authExpected, component: "storage_metadata" } }), (error) => error?.code === "BACKUP_V2_COMPONENT_ARTIFACT_IDENTITY_MISMATCH");
  await assert.rejects(verifyComponentArtifact({ artifactPath: results[0].paths.artifactPath, manifestPath: results[0].paths.manifestPath, encryptionKey, expected: { ...authExpected, generationKey: `backup-v2-generation:${"f".repeat(64)}` } }), (error) => error?.code === "BACKUP_V2_COMPONENT_ARTIFACT_IDENTITY_MISMATCH");
  await assert.rejects(verifyComponentArtifact({ artifactPath: results[0].paths.artifactPath, manifestPath: results[0].paths.manifestPath, encryptionKey, expected: { ...authExpected, artifactId: `auth-${"0".repeat(64)}` } }), (error) => error?.code === "BACKUP_V2_COMPONENT_ARTIFACT_IDENTITY_MISMATCH");

  async function artifactClone(name) {
    const directory = path.join(workspace, name); await (await import("node:fs/promises")).mkdir(directory);
    const artifactPath = path.join(directory, "artifact.czb2"); const manifestPath = path.join(directory, "manifest.json");
    await copyFile(results[0].paths.artifactPath, artifactPath); await copyFile(results[0].paths.manifestPath, manifestPath);
    return { artifactPath, manifestPath };
  }
  const truncated = await artifactClone("truncated"); const originalSize = (await readFile(truncated.artifactPath)).length; await truncate(truncated.artifactPath, originalSize - 7);
  await assert.rejects(verifyComponentArtifact({ ...truncated, encryptionKey, expected: authExpected }), (error) => ["BACKUP_V2_ENCRYPTED_ARTIFACT_INTEGRITY_FAILED", "BACKUP_V2_TRUNCATED_ARTIFACT"].includes(error?.code));
  const appended = await artifactClone("appended"); await appendFile(appended.artifactPath, "extra");
  await assert.rejects(verifyComponentArtifact({ ...appended, encryptionKey, expected: authExpected }), (error) => error?.code === "BACKUP_V2_ENCRYPTED_ARTIFACT_INTEGRITY_FAILED");
  const flipped = await artifactClone("flipped"); const flippedBytes = await readFile(flipped.artifactPath); flippedBytes[Math.floor(flippedBytes.length / 2)] ^= 1; await writeFile(flipped.artifactPath, flippedBytes);
  await assert.rejects(verifyComponentArtifact({ ...flipped, encryptionKey, expected: authExpected }), (error) => error?.code === "BACKUP_V2_ENCRYPTED_ARTIFACT_INTEGRITY_FAILED");
  const unknownManifest = JSON.parse(await readFile(results[0].paths.manifestPath, "utf8")); unknownManifest.payload.format_version = "future-v99";
  assert.throws(() => validateComponentArtifactManifest(unknownManifest), (error) => error?.code === "BACKUP_V2_UNKNOWN_EXPORT_FORMAT");

  const mutatingRecord = bodyRecord("mutating", Buffer.from("before")); mutatingRecord.openBody = () => Readable.from([Buffer.from("after!")]);
  await assert.rejects(runComponentArtifactPipeline(input(path.join(workspace, "mutation"), memorySource("external_assets", [mutatingRecord]))), (error) => error?.code === "BACKUP_V2_SOURCE_OBJECT_CHANGED");
  let deletionCalls = 0;
  const deletingSource = { component: "external_assets", async listPage() { deletionCalls += 1; return { records: deletionCalls === 1 ? [bodyRecord("deleted", Buffer.from("x"))] : [], nextCursor: null, snapshotId: "same-snapshot", complete: true }; } };
  await assert.rejects(runComponentArtifactPipeline(input(path.join(workspace, "deletion"), deletingSource)), (error) => error?.code === "BACKUP_V2_SOURCE_DRIFT");

  for (const component of ["auth", "storage_metadata", "external_assets"]) {
    const controlled = mutableAuthority();
    await assert.rejects(runComponentArtifactPipeline(input(path.join(workspace, `stale-${component}`), memorySource(component, [bodyRecord("record", Buffer.from("x"))]), {
      authority: controlled.authority, stageHook(stage) { if (stage === "authority_finalize") controlled.state.lease.ownerRef = "stale-worker"; },
    })), (error) => error?.code === "BACKUP_V2_LEASE_NOT_AUTHORITATIVE");
  }
  const crossGeneration = mutableAuthority();
  await assert.rejects(runComponentArtifactPipeline(input(path.join(workspace, "cross-generation"), memorySource("auth", [bodyRecord("record", Buffer.from("x"))]), {
    authority: crossGeneration.authority, stageHook(stage) { if (stage === "authority_finalize") crossGeneration.state.generationKey = `backup-v2-generation:${"9".repeat(64)}`; },
  })), (error) => error?.code === "BACKUP_V2_EXECUTION_AUTHORITY_CHANGED");

  const concurrentRoot = path.join(workspace, "concurrent");
  const concurrent = await Promise.allSettled([
    runComponentArtifactPipeline(input(concurrentRoot, memorySource("auth", [bodyRecord("same", Buffer.from("x"))]))),
    runComponentArtifactPipeline(input(concurrentRoot, memorySource("auth", [bodyRecord("same", Buffer.from("x"))]))),
  ]);
  assert(concurrent.some((item) => item.status === "fulfilled"));
  assert.equal((await readdir(concurrentRoot)).filter((name) => !name.startsWith(".partial-")).length, 1);

  const large = randomBytes(8 * 1024 * 1024);
  const largeResult = await runComponentArtifactPipeline(input(path.join(workspace, "large"), memorySource("auth", [bodyRecord("large", large)]), { maxPlaintextBytes: 16n * 1024n * 1024n }));
  assert.equal(largeResult.manifest.payload.body_bytes, String(large.length));
  const nonceA = await runComponentArtifactPipeline(input(path.join(workspace, "nonce-a"), memorySource("auth", [bodyRecord("nonce", Buffer.from("same"))])));
  const nonceB = await runComponentArtifactPipeline(input(path.join(workspace, "nonce-b"), memorySource("auth", [bodyRecord("nonce", Buffer.from("same"))])));
  assert.notEqual(nonceA.manifest.encryption.nonce_base64, nonceB.manifest.encryption.nonce_base64, "AES-GCM nonces must be unique");

  // Direct auth-schema export retains credential continuity but strips one-time token columns.
  const tableRows = new Map([
    ["users", [{ id: "user-1", email: "synthetic@example.invalid", encrypted_password: "$2a$synthetic", confirmation_token: "must-not-export", confirmed_at: now, disabled: false, user_metadata: { access_token: "also-must-not-export", display_name: "Synthetic" } }, { id: "user-2", email: "second@example.invalid", encrypted_password: "$2b$synthetic", confirmed_at: null, disabled: true }]],
    ["identities", [{ id: "identity-1", user_id: "user-1", provider: "google", identity_data: { sub: "synthetic-provider-subject" } }]],
    ["mfa_factors", [{ id: "factor-1", user_id: "user-1", factor_type: "totp", secret: "SYNTHETIC-MFA-SECRET" }]],
    ["webauthn_credentials", [{ id: "credential-1", user_id: "user-1", public_key: "SYNTHETIC-PUBLIC-KEY" }]],
  ]);
  const authTablesRead = [];
  const auth = createAuthSchemaSource({ async listTablePage(table) { authTablesRead.push(table); return { records: tableRows.get(table) ?? [], nextCursor: null, snapshotId: "auth-transaction-1", complete: true }; } });
  let authCursor = null; let userRecord = null; let authRecordCount = 0;
  do { const page = await auth.listPage(authCursor); userRecord ??= page.records[0] ?? null; authRecordCount += page.records.length; authCursor = page.nextCursor; } while (authCursor !== null);
  assert.equal(authRecordCount, 5); assert.equal(authTablesRead.some((table) => AUTH_TRANSIENT_TABLES.includes(table)), false);
  const exportedUser = JSON.parse((await Array.fromAsync(userRecord.openBody())).map(Buffer.from).reduce((a, b) => Buffer.concat([a, b])).toString("utf8"));
  assert.equal(exportedUser.encrypted_password, "$2a$synthetic"); assert.equal("confirmation_token" in exportedUser, false);
  assert.equal("access_token" in exportedUser.user_metadata, false);
  assert(AUTH_TRANSIENT_TABLES.includes("sessions") && AUTH_TRANSIENT_TABLES.includes("refresh_tokens"));

  const metadataSource = createStorageMetadataSource({ async listPage() { return { records: [{ bucket: "private", key: null, metadata: { public: false, file_size_limit: 1024 } }], nextCursor: null, snapshotId: "storage-meta-1", complete: true }; } });
  assert.equal((await collectComponentInventory(metadataSource)).recordCount, 1n);
  const objectSource = createStorageObjectsSource({ async listPage() { return { records: [{ bucket: "private", key: "../../nested/ñ/zero", metadata: {}, bytes: 0n, sha256: sha256Hex(zero), open: () => Readable.from([zero]) }], nextCursor: null, snapshotId: "storage-objects-1", complete: true }; } });
  assert.equal((await collectComponentInventory(objectSource)).bodyBytes, 0n);

  const cloudinaryRecord = { publicId: "car-zone/original", resourceType: "image", type: "upload", version: "123", format: "jpg", bytes: 1n, sha256: sha256Hex(Buffer.from("x")), secureUrl: "https://res.cloudinary.com/demo/image/upload/v123/car-zone/original.jpg", metadata: {} };
  const cloudinaryReader = { cloudName: "demo", async listOriginalsPage() { return { records: [cloudinaryRecord], nextCursor: null, snapshotId: "cloudinary-list-1", complete: true }; } };
  const denied = createCloudinaryOriginalsSource(cloudinaryReader, { fetch, resolve: async () => ["127.0.0.1"] });
  const deniedBody = (await denied.listPage(null)).records[0].openBody();
  await assert.rejects(async () => { for await (const _chunk of deniedBody) void _chunk; }, (error) => error?.code === "BACKUP_V2_EXTERNAL_ADDRESS_DENIED");
  const redirected = createCloudinaryOriginalsSource(cloudinaryReader, { resolve: async () => ["1.1.1.1"], fetch: async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/secret" } }) });
  await assert.rejects(async () => { for await (const _chunk of (await redirected.listPage(null)).records[0].openBody()) void _chunk; }, (error) => error?.code === "BACKUP_V2_EXTERNAL_URL_DENIED");
  for (const secureUrl of ["ftp://res.cloudinary.com/demo/image/upload/original.jpg", "https://user:password@res.cloudinary.com/demo/image/upload/original.jpg", "https://unrelated.example.invalid/demo/original.jpg"]) {
    const deniedUrlReader = { ...cloudinaryReader, async listOriginalsPage() { return { records: [{ ...cloudinaryRecord, secureUrl }], nextCursor: null, snapshotId: "cloudinary-list-1", complete: true }; } };
    const deniedUrl = createCloudinaryOriginalsSource(deniedUrlReader, { resolve: async () => ["1.1.1.1"], fetch });
    await assert.rejects(async () => { for await (const _chunk of (await deniedUrl.listPage(null)).records[0].openBody()) void _chunk; }, (error) => error?.code === "BACKUP_V2_EXTERNAL_URL_DENIED");
  }
  let observedFetchSignal = null;
  const cancellable = createCloudinaryOriginalsSource(cloudinaryReader, { resolve: async () => ["1.1.1.1"], fetch: async (_url, init) => { observedFetchSignal = init.signal; return new Response("x", { status: 200, headers: { "content-length": "1", "content-type": "image/jpeg" } }); } });
  const fetchAbort = new AbortController(); const cancellableBody = (await cancellable.listPage(null)).records[0].openBody(fetchAbort.signal); fetchAbort.abort();
  await assert.rejects(async () => { for await (const _chunk of cancellableBody) void _chunk; }, (error) => error?.code === "BACKUP_V2_EXPORT_CANCELLED");
  assert.equal(observedFetchSignal, fetchAbort.signal);
  const emptyExternal = await collectComponentInventory({ component: "external_assets", async listPage() { return { records: [], nextCursor: null, snapshotId: "explicit-empty", complete: true }; } });
  assert.equal(emptyExternal.recordCount, 0n);
  await assert.rejects(collectComponentInventory({ component: "external_assets", async listPage() { throw new Error("failed inventory"); } }, { maxRetries: 0 }), (error) => error?.code === "BACKUP_V2_SOURCE_RETRY_EXHAUSTED");

  const scopes = ["database", "auth", "storage_metadata", "storage_objects", "external_assets"];
  const artifacts = scopes.map((scope) => ({ artifactId: `${scope}-synthetic`, generationKey, component: scope, verificationStatus: "verified", ciphertextSizeBytes: "10", ciphertextHash: "d".repeat(64), evidenceOrigin: "runtime_verified", copies: [
    { copyRole: "primary", verificationStatus: "verified", ciphertextSizeBytes: "10", ciphertextHash: "d".repeat(64), providerNeutralRef: `${scope}:p`, physicalObjectIdentity: `${scope}:p-id`, independenceDomain: "domain-p", evidenceOrigin: "runtime_verified" },
    { copyRole: "secondary_independent", verificationStatus: "verified", ciphertextSizeBytes: "10", ciphertextHash: "d".repeat(64), providerNeutralRef: `${scope}:s`, physicalObjectIdentity: `${scope}:s-id`, independenceDomain: "domain-s", evidenceOrigin: "runtime_verified" },
  ] }));
  const recoveryInput = { policy: CAR_ZONE_RECOVERY_POLICY, components: scopes.map(recoveryComponent), generationKey, canonicalArtifacts: artifacts,
    recoveryKey: { status: "availability_attested", keyVersion: "v1", safeReference: "secret-manager://synthetic", publicFingerprint: "e".repeat(64), attestedAt: now }, environment: "synthetic_test", evaluatedAt: now };
  assert.equal(evaluateRecoverySet(recoveryInput).fullDrReady, true);
  assert.equal(evaluateRecoverySet({ ...recoveryInput, components: recoveryInput.components.filter((item) => item.scope !== "external_assets") }).fullDrReady, false);
  assert.equal(evaluateRecoverySet({ ...recoveryInput, canonicalArtifacts: artifacts.map((item, index) => index === 2 ? { ...item, generationKey: `backup-v2-generation:${"f".repeat(64)}` } : item) }).fullDrReady, false);

  const manifests = await Promise.all(results.map((result) => readFile(result.paths.manifestPath, "utf8")));
  assert(manifests.every((value) => !value.includes("must-not-export")), "manifests must not contain payload data");
  console.log("Backup V2 Phase 4B.3 auth/storage/external component pipeline: PASS");
} finally {
  encryptionKey.fill(0);
  await rm(workspace, { recursive: true, force: true });
}
