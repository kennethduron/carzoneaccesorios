import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  appendFile,
  cp,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

import {
  DATABASE_ARTIFACT_HEADER_BYTES,
  DATABASE_ARTIFACT_MIN_BYTES,
  DATABASE_ENCRYPTION_ALGORITHM,
  DATABASE_MANIFEST_VERSION,
  canonicalJson,
  databaseArtifactFilename,
  databaseArtifactId,
  parseDatabaseArtifactManifest,
  serializeDatabaseArtifactManifest,
  sha256Hex,
} from "../src/lib/backups/v2/database-artifact-format.ts";
import {
  runDatabaseArtifactPipeline,
  verifyDatabaseArtifact,
} from "../src/lib/backups/v2/database-artifact-pipeline.ts";
import { CAR_ZONE_RECOVERY_POLICY, evaluateRecoverySet } from "../src/lib/backups/v2/index.ts";

const fixedNow = "2026-08-14T13:30:00.000Z";
const acquiredAt = "2026-08-14T13:00:00.000Z";
const expiresAt = "2026-08-14T14:00:00.000Z";
const catalogFingerprint = "a".repeat(64);
const syntheticDump = Buffer.concat([
  Buffer.from("PGDMP", "ascii"),
  Buffer.from("\u0001\u000f\u0000synthetic-only-schema-data-".repeat(128), "utf8"),
]);

function generation(digit) {
  return `backup-v2-generation:${digit.repeat(64)}`;
}

function syntheticExporter(buffer = syntheticDump, onOpen = () => undefined) {
  return {
    tool: "pg_dump",
    toolVersion: "pg_dump (PostgreSQL) 17.6",
    format: "postgresql_custom",
    open() {
      onOpen();
      return { stream: Readable.from([buffer]), completed: Promise.resolve(), cancel() {} };
    },
  };
}

function interruptedExporter() {
  return {
    tool: "pg_dump",
    toolVersion: "pg_dump (PostgreSQL) 17.6",
    format: "postgresql_custom",
    open() {
      const stream = new Readable({
        read() {
          this.push(syntheticDump.subarray(0, Math.ceil(syntheticDump.length * 0.2)));
          this.destroy(new Error("synthetic interrupted export"));
        },
      });
      return { stream, completed: Promise.resolve(), cancel() { stream.destroy(); } };
    },
  };
}

function authorityFor(generationKey, overrides = {}) {
  const state = {
    runId: `run-${generationKey.slice(-8)}`,
    generationKey,
    state: "running",
    preflightOutcome: "go",
    preflightSnapshotId: `preflight-${generationKey.slice(-8)}`,
    catalogFingerprint,
    catalogPolicyVersion: "car-zone-phase4b1-catalog-v2",
    lease: {
      ownerRef: "worker-a",
      acquiredAt,
      heartbeatAt: "2026-08-14T13:20:00.000Z",
      expiresAt,
      generation: 7,
    },
    ...overrides,
  };
  return { state, authority: { async read() { return structuredClone(state); } } };
}

function pipelineInput(workspaceRoot, authorityState, key, overrides = {}) {
  return {
    workspaceRoot,
    recoverySetId: "recovery-set-synthetic",
    ownerRef: "worker-a",
    leaseGeneration: 7,
    authority: authorityState.authority,
    exporter: syntheticExporter(),
    encryptionKey: key,
    keyVersion: "ephemeral-test-v1",
    keyReference: "ephemeral:test-runtime-only",
    compatibilityRef: "postgresql-custom:synthetic-v1",
    clock: () => fixedNow,
    ...overrides,
  };
}

async function assertNoPartialDirectories(workspaceRoot) {
  let entries;
  try {
    entries = await readdir(workspaceRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return;
    throw error;
  }
  assert.equal(entries.some((entry) => entry.name.startsWith(".partial-")), false);
}

async function cloneArtifact(result, root, label) {
  const target = path.join(root, label);
  await cp(result.paths.finalDirectory, target, { recursive: true });
  return {
    directory: target,
    artifactPath: path.join(target, path.basename(result.paths.artifactPath)),
    manifestPath: path.join(target, path.basename(result.paths.manifestPath)),
  };
}

async function mutateManifest(manifestPath, mutate) {
  const value = JSON.parse(await readFile(manifestPath, "utf8"));
  mutate(value);
  await writeFile(manifestPath, `${JSON.stringify(value)}\n`, "utf8");
}

async function expectPipelineFailure(root, authorityState, key, overrides) {
  await assert.rejects(runDatabaseArtifactPipeline(pipelineInput(root, authorityState, key, overrides)));
  await assertNoPartialDirectories(root);
  const entries = await readdir(root).catch((error) => error && error.code === "ENOENT" ? [] : Promise.reject(error));
  assert.equal(entries.filter((entry) => entry.startsWith("database-")).length, 0);
}

const testRoot = await mkdtemp(path.join(os.tmpdir(), "carzone-phase4b2-"));
const key = randomBytes(32);
try {
  const happyRoot = path.join(testRoot, "happy");
  const happyAuthority = authorityFor(generation("1"));
  let exporterOpenCount = 0;
  const happy = await runDatabaseArtifactPipeline(pipelineInput(happyRoot, happyAuthority, key, {
    exporter: syntheticExporter(syntheticDump, () => { exporterOpenCount += 1; }),
  }));
  assert.equal(happy.reusedCanonicalArtifact, false);
  assert.equal(exporterOpenCount, 1);
  assert.equal(happy.manifest.manifest_version, DATABASE_MANIFEST_VERSION);
  assert.equal(happy.manifest.encryption.algorithm, DATABASE_ENCRYPTION_ALGORITHM);
  assert.equal(happy.manifest.catalog.fingerprint, catalogFingerprint);
  assert.equal(happy.manifest.preflight.snapshot_id, happyAuthority.state.preflightSnapshotId);
  assert.equal(happy.manifest.generation_key, happyAuthority.state.generationKey);
  assert.equal(happy.manifest.artifact_id, databaseArtifactId(happyAuthority.state.generationKey));
  assert.equal(happy.manifest.artifact.filename, databaseArtifactFilename(happy.manifest.artifact_id));
  assert.ok(BigInt(happy.manifest.byte_counts.plaintext_export) > 0n);
  assert.ok(BigInt(happy.manifest.byte_counts.compressed) > 0n);
  assert.ok(BigInt(happy.manifest.byte_counts.encrypted_artifact) >= BigInt(DATABASE_ARTIFACT_MIN_BYTES));
  assert.equal(happy.evidence.verificationStatus, "verified");
  assert.equal(happy.evidence.evidenceOrigin, "runtime_verified");
  assert.equal(happy.evidence.generationKey, happyAuthority.state.generationKey);
  assert.equal((await lstat(happy.paths.artifactPath)).isFile(), true);
  assert.equal((await lstat(happy.paths.manifestPath)).isFile(), true);
  await assertNoPartialDirectories(happyRoot);

  const verified = await verifyDatabaseArtifact({
    artifactPath: happy.paths.artifactPath,
    manifestPath: happy.paths.manifestPath,
    encryptionKey: key,
    expected: {
      runId: happyAuthority.state.runId,
      generationKey: happyAuthority.state.generationKey,
      artifactId: happy.paths.artifactId,
      catalogFingerprint,
      preflightSnapshotId: happyAuthority.state.preflightSnapshotId,
    },
  });
  assert.equal(verified.plaintextBytes.toString(), happy.manifest.byte_counts.plaintext_export);
  const canonicalManifestText = await readFile(happy.paths.manifestPath, "utf8");
  assert.equal(serializeDatabaseArtifactManifest(parseDatabaseArtifactManifest(
    canonicalManifestText,
  )), canonicalManifestText);
  assert.throws(() => parseDatabaseArtifactManifest(canonicalManifestText.trimEnd()));
  assert.equal(canonicalJson({ z: 1, a: { y: true, b: "x" } }), '{"a":{"b":"x","y":true},"z":1}');

  const manifestText = await readFile(happy.paths.manifestPath, "utf8");
  for (const forbidden of ["postgresql://", "DATABASE_URL", "password", key.toString("base64"), key.toString("hex")]) {
    assert.equal(manifestText.includes(forbidden), false, `manifest must not contain ${forbidden}`);
  }

  const retry = await runDatabaseArtifactPipeline(pipelineInput(happyRoot, happyAuthority, key, {
    exporter: syntheticExporter(syntheticDump, () => { exporterOpenCount += 1; }),
  }));
  assert.equal(retry.reusedCanonicalArtifact, true);
  assert.equal(exporterOpenCount, 1, "idempotent retry must not run pg_dump twice");

  const staleReuse = authorityFor(generation("1"));
  await assert.rejects(runDatabaseArtifactPipeline(pipelineInput(happyRoot, staleReuse, key, {
    stageHook(stage) {
      if (stage === "authority_finalize") {
        staleReuse.state.lease = { ...staleReuse.state.lease, ownerRef: "worker-b", generation: 8 };
      }
    },
  })), "reused artifact verification must recheck lease before returning evidence");
  await assertNoPartialDirectories(happyRoot);

  const nonceRootA = path.join(testRoot, "nonce-a");
  const nonceRootB = path.join(testRoot, "nonce-b");
  const nonceA = await runDatabaseArtifactPipeline(pipelineInput(nonceRootA, happyAuthority, key));
  const nonceB = await runDatabaseArtifactPipeline(pipelineInput(nonceRootB, happyAuthority, key));
  assert.notEqual(nonceA.manifest.encryption.nonce_base64, nonceB.manifest.encryption.nonce_base64);
  assert.notEqual(nonceA.manifest.hashes.encrypted_artifact, nonceB.manifest.hashes.encrypted_artifact);

  const wrongKey = randomBytes(32);
  await assert.rejects(verifyDatabaseArtifact({
    artifactPath: happy.paths.artifactPath,
    manifestPath: happy.paths.manifestPath,
    encryptionKey: wrongKey,
    expected: {
      runId: happyAuthority.state.runId,
      generationKey: happyAuthority.state.generationKey,
      artifactId: happy.paths.artifactId,
      catalogFingerprint,
      preflightSnapshotId: happyAuthority.state.preflightSnapshotId,
    },
  }));
  wrongKey.fill(0);

  const flip = await cloneArtifact(happy, testRoot, "tamper-flip");
  const flipHandle = await open(flip.artifactPath, "r+");
  try {
    const one = Buffer.alloc(1);
    await flipHandle.read(one, 0, 1, DATABASE_ARTIFACT_HEADER_BYTES + 3);
    one[0] ^= 0x01;
    await flipHandle.write(one, 0, 1, DATABASE_ARTIFACT_HEADER_BYTES + 3);
  } finally {
    await flipHandle.close();
  }
  await assert.rejects(verifyDatabaseArtifact({ ...flip, encryptionKey: key, expected: {
    runId: happyAuthority.state.runId, generationKey: happyAuthority.state.generationKey,
    artifactId: happy.paths.artifactId, catalogFingerprint,
    preflightSnapshotId: happyAuthority.state.preflightSnapshotId,
  } }));

  const truncated = await cloneArtifact(happy, testRoot, "tamper-truncated");
  await truncate(truncated.artifactPath, DATABASE_ARTIFACT_HEADER_BYTES + 2);
  await assert.rejects(verifyDatabaseArtifact({ ...truncated, encryptionKey: key, expected: {
    runId: happyAuthority.state.runId, generationKey: happyAuthority.state.generationKey,
    artifactId: happy.paths.artifactId, catalogFingerprint,
    preflightSnapshotId: happyAuthority.state.preflightSnapshotId,
  } }));

  const appended = await cloneArtifact(happy, testRoot, "tamper-appended");
  await appendFile(appended.artifactPath, Buffer.from("garbage", "utf8"));
  await assert.rejects(verifyDatabaseArtifact({ ...appended, encryptionKey: key, expected: {
    runId: happyAuthority.state.runId, generationKey: happyAuthority.state.generationKey,
    artifactId: happy.paths.artifactId, catalogFingerprint,
    preflightSnapshotId: happyAuthority.state.preflightSnapshotId,
  } }));

  const zero = await cloneArtifact(happy, testRoot, "tamper-zero");
  await truncate(zero.artifactPath, 0);
  await assert.rejects(verifyDatabaseArtifact({ ...zero, encryptionKey: key, expected: {
    runId: happyAuthority.state.runId, generationKey: happyAuthority.state.generationKey,
    artifactId: happy.paths.artifactId, catalogFingerprint,
    preflightSnapshotId: happyAuthority.state.preflightSnapshotId,
  } }));

  const manifestHash = await cloneArtifact(happy, testRoot, "tamper-manifest-hash");
  await mutateManifest(manifestHash.manifestPath, (value) => { value.integrity.manifest_sha256 = "0".repeat(64); });
  await assert.rejects(verifyDatabaseArtifact({ ...manifestHash, encryptionKey: key, expected: {
    runId: happyAuthority.state.runId, generationKey: happyAuthority.state.generationKey,
    artifactId: happy.paths.artifactId, catalogFingerprint,
    preflightSnapshotId: happyAuthority.state.preflightSnapshotId,
  } }));

  const malformedManifest = await cloneArtifact(happy, testRoot, "tamper-manifest-bytes");
  await writeFile(malformedManifest.manifestPath, "{not-json", "utf8");
  await assert.rejects(verifyDatabaseArtifact({ ...malformedManifest, encryptionKey: key, expected: {
    runId: happyAuthority.state.runId, generationKey: happyAuthority.state.generationKey,
    artifactId: happy.paths.artifactId, catalogFingerprint,
    preflightSnapshotId: happyAuthority.state.preflightSnapshotId,
  } }));

  for (const [label, mutate] of [
    ["unknown-manifest", (value) => { value.manifest_version = "future-v99"; }],
    ["unknown-encryption", (value) => { value.encryption.algorithm = "future-cipher"; }],
    ["unknown-compression", (value) => { value.compression.algorithm = "future-compressor"; }],
    ["unknown-export", (value) => { value.export.format = "future-export"; }],
    ["unknown-hash", (value) => { value.hashes.algorithm = "sha1"; }],
    ["tamper-component", (value) => { value.component = "auth"; }],
    ["tamper-byte-count", (value) => { value.byte_counts.encrypted_artifact = "1"; }],
    ["tamper-final-hash", (value) => { value.hashes.encrypted_artifact = "0".repeat(64); }],
    ["tamper-generation", (value) => { value.generation_key = generation("2"); }],
  ]) {
    const changed = await cloneArtifact(happy, testRoot, label);
    await mutateManifest(changed.manifestPath, mutate);
    await assert.rejects(verifyDatabaseArtifact({ ...changed, encryptionKey: key, expected: {
      runId: happyAuthority.state.runId, generationKey: happyAuthority.state.generationKey,
      artifactId: happy.paths.artifactId, catalogFingerprint,
      preflightSnapshotId: happyAuthority.state.preflightSnapshotId,
    } }));
  }

  await assert.rejects(verifyDatabaseArtifact({
    artifactPath: happy.paths.artifactPath,
    manifestPath: happy.paths.manifestPath,
    encryptionKey: key,
    expected: {
      runId: happyAuthority.state.runId,
      generationKey: generation("2"),
      artifactId: databaseArtifactId(generation("2")),
      catalogFingerprint,
      preflightSnapshotId: happyAuthority.state.preflightSnapshotId,
    },
  }), "wrong generation must fail");
  await assert.rejects(verifyDatabaseArtifact({
    artifactPath: happy.paths.artifactPath,
    manifestPath: happy.paths.manifestPath,
    encryptionKey: key,
    expected: {
      runId: happyAuthority.state.runId,
      generationKey: happyAuthority.state.generationKey,
      artifactId: databaseArtifactId(generation("3")),
      catalogFingerprint,
      preflightSnapshotId: happyAuthority.state.preflightSnapshotId,
    },
  }), "wrong artifact identity must fail");

  const swapAuthority = authorityFor(generation("2"));
  const swapResult = await runDatabaseArtifactPipeline(pipelineInput(path.join(testRoot, "swap-source"), swapAuthority, key));
  await assert.rejects(verifyDatabaseArtifact({
    artifactPath: happy.paths.artifactPath,
    manifestPath: swapResult.paths.manifestPath,
    encryptionKey: key,
    expected: {
      runId: swapAuthority.state.runId,
      generationKey: swapAuthority.state.generationKey,
      artifactId: swapResult.paths.artifactId,
      catalogFingerprint,
      preflightSnapshotId: swapAuthority.state.preflightSnapshotId,
    },
  }), "manifest/artifact swap must fail");

  assert.throws(() => databaseArtifactFilename("../../escape"));
  await assert.rejects(() => runDatabaseArtifactPipeline(pipelineInput(
    path.join(testRoot, "path-traversal"),
    authorityFor("../../escape"),
    key,
  )));

  await assert.rejects(verifyDatabaseArtifact({
    artifactPath: happy.paths.artifactPath,
    manifestPath: happy.paths.manifestPath,
    encryptionKey: key,
    expected: {
      runId: happyAuthority.state.runId,
      generationKey: happyAuthority.state.generationKey,
      artifactId: happy.paths.artifactId,
      catalogFingerprint,
      preflightSnapshotId: happyAuthority.state.preflightSnapshotId,
    },
    maxPlaintextBytes: 4n,
  }), "decompression byte limit must fail closed");

  await expectPipelineFailure(
    path.join(testRoot, "export-failure"), authorityFor(generation("3")), key,
    { exporter: interruptedExporter() },
  );
  await expectPipelineFailure(path.join(testRoot, "unknown-exporter-format"), authorityFor(generation("b")), key, {
    exporter: { ...syntheticExporter(), format: "future-format" },
  });
  await expectPipelineFailure(path.join(testRoot, "validating-start"), authorityFor(generation("a"), {
    state: "validating",
  }), key, {});
  for (const [label, stage] of [
    ["compression-failure", "compression_start"],
    ["encryption-failure", "encryption_start"],
    ["post-stream-crash", "stream_complete"],
    ["manifest-failure", "manifest_write"],
  ]) {
    await expectPipelineFailure(path.join(testRoot, label), authorityFor(generation("4")), key, {
      stageHook(current) { if (current === stage) throw new Error("synthetic stage failure"); },
    });
  }

  const stale = authorityFor(generation("5"));
  await expectPipelineFailure(path.join(testRoot, "stale-worker"), stale, key, {
    stageHook(stage) {
      if (stage === "authority_finalize") {
        stale.state.lease = { ...stale.state.lease, ownerRef: "worker-b", generation: 8 };
      }
    },
  });

  const crossGeneration = authorityFor(generation("6"));
  await expectPipelineFailure(path.join(testRoot, "cross-generation"), crossGeneration, key, {
    stageHook(stage) {
      if (stage === "authority_finalize") {
        crossGeneration.state.generationKey = generation("7");
      }
    },
  });

  const cancelled = authorityFor(generation("8"));
  const controller = new AbortController();
  controller.abort();
  await expectPipelineFailure(path.join(testRoot, "cancelled"), cancelled, key, { signal: controller.signal });

  const concurrentRoot = path.join(testRoot, "concurrent");
  const concurrentAuthority = authorityFor(generation("9"));
  const concurrentResults = await Promise.allSettled([
    runDatabaseArtifactPipeline(pipelineInput(concurrentRoot, concurrentAuthority, key)),
    runDatabaseArtifactPipeline(pipelineInput(concurrentRoot, concurrentAuthority, key)),
  ]);
  assert.ok(concurrentResults.some(({ status }) => status === "fulfilled"));
  const concurrentEntries = await readdir(concurrentRoot);
  assert.equal(concurrentEntries.filter((entry) => entry.startsWith("database-")).length, 1);
  assert.equal(concurrentEntries.some((entry) => entry.startsWith(".partial-")), false);

  const databaseOnlyComponent = {
    scope: "database",
    artifact: "present",
    completion: "completed",
    integrity: "verified",
    compatibility: {
      status: "verified",
      backupFormatVersion: happy.manifest.export.format_version,
      schemaCompatibilityRef: happy.manifest.compatibility_ref,
      exporterVersion: happy.manifest.export.tool_version,
      verifiedAt: fixedNow,
    },
    copies: [],
    failClosedReasons: [],
    evidenceOrigin: "runtime_verified",
  };
  const databaseOnlyRecovery = evaluateRecoverySet({
    policy: CAR_ZONE_RECOVERY_POLICY,
    components: [databaseOnlyComponent],
    generationKey: happy.manifest.generation_key,
    canonicalArtifacts: [],
    recoveryKey: null,
    environment: "runtime",
    evaluatedAt: fixedNow,
  });
  assert.equal(databaseOnlyRecovery.fullDrReady, false, "database-only evidence must never claim full DR");

  assert.equal(sha256Hex(key).length, 64);
  console.log("Backup V2 Phase 4B.2 database artifact pipeline: PASS");
} finally {
  key.fill(0);
  const resolved = path.resolve(testRoot);
  assert.ok(path.basename(resolved).startsWith("carzone-phase4b2-"));
  await rm(resolved, { recursive: true, force: true });
}
