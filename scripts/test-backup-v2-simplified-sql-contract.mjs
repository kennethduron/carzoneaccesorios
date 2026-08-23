import assert from "node:assert/strict";
import { createCipheriv, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { canonicalJson, sha256Hex } from "../src/lib/backups/v2/database-artifact-format.ts";
import { BackupV2FailClosedError } from "../src/lib/backups/v2/types.ts";
import {
  createSimplifiedManifest,
  simplifiedArtifactBinding,
  simplifiedRemotePrefix,
} from "../src/lib/backups/v2-simplified/core.ts";
import {
  createFileBasedPsqlRestoreExecutor,
  exportSimplifiedPlainSqlDatabase,
  parsePlainSqlArtifactManifest,
  stageAndRestorePlainSqlArtifact,
} from "../src/lib/backups/v2-simplified/plain-sql.ts";

const root = await mkdtemp(path.join(os.tmpdir(), "carzone-backup-v2-sql-contract-"));
const runId = "2026-08-22T00-00-00-000Z_12345678-1234-4123-8123-123456789abc";
const bindingKey = simplifiedArtifactBinding(runId);
const key = randomBytes(32);
const sql = "--\n-- PostgreSQL database dump\n--\nCREATE TABLE public.contract_fixture(id integer PRIMARY KEY);\n";
const identity = {
  runId,
  createdAt: "2026-08-22T00:00:00.000Z",
  bindingKey,
  catalogFingerprint: "1".repeat(64),
  catalogPolicyVersion: "simplified-source-read-only-v1",
  preflightSnapshotId: `simplified-preflight:${"2".repeat(64)}`,
};
const target = {
  host: "127.0.0.1",
  port: 55432,
  database: "carzone_backup_v2_restore_contract01",
  user: "carzone_backup_v2_restore",
  username: "carzone_backup_v2_restore",
  password: "SyntheticContractPassword_Only",
  containerName: "carzone-backup-v2-contract-target",
  marker: "a".repeat(32),
  postgresMajor: 17,
};

function code(error) {
  return error instanceof BackupV2FailClosedError ? error.code : error?.code;
}

async function rejectsCode(action, expected) {
  let rejected = false;
  try {
    await action();
  } catch (error) {
    assert.equal(code(error), expected);
    rejected = true;
  }
  assert.equal(rejected, true, `Expected rejection with ${expected}`);
}

function canonicalWithIntegrity(value) {
  const { integrity: _removed, ...body } = value;
  void _removed;
  return `${canonicalJson({ ...body, integrity: { manifest_sha256: sha256Hex(canonicalJson(body)) } })}\n`;
}

function plainSqlAadFromManifest(manifest) {
  return Buffer.from(canonicalJson({
    artifact_id: manifest.artifact_id,
    catalog_fingerprint: manifest.catalog.fingerprint,
    catalog_policy_version: manifest.catalog.policy_version,
    created_at: manifest.created_at,
    export_arguments: manifest.export.arguments,
    export_tool: "pg_dump",
    export_tool_version: manifest.export.tool_version,
    filename: "database.sql",
    generation_key: manifest.generation_key,
    key_fingerprint: manifest.encryption.key_fingerprint,
    plaintext_sha256: manifest.hashes.plaintext_export,
    postgres_major: 17,
    representation: "postgres_plain_sql_v1",
    restore_strategy: "psql_file_restore_v1",
    run_id: manifest.run_id,
    schema: "car-zone-backup-v2-plain-sql-aad-v1",
  }), "utf8");
}

function fakeExporter(payload = sql) {
  return Object.freeze({
    tool: "pg_dump",
    toolVersion: "pg_dump (PostgreSQL) 17.6",
    representation: "postgres_plain_sql_v1",
    postgresMajor: 17,
    safeArguments: Object.freeze([
      "--format=plain",
      "--no-owner",
      "--no-privileges",
      "--encoding=UTF8",
      "--quote-all-identifiers",
    ]),
    async exportToFile(destinationPath) {
      await writeFile(destinationPath, payload, { encoding: "utf8", flag: "wx", mode: 0o600 });
    },
  });
}

function operations(overrides = {}) {
  let copiedSource = null;
  return {
    async prepare() {},
    async copy({ sourcePath }) { copiedSource = sourcePath; },
    async inspect() {
      const value = await readFile(copiedSource);
      return { bytes: BigInt(value.length), sha256: sha256Hex(value) };
    },
    async restore() {},
    async cleanup() {},
    ...overrides,
  };
}

try {
  const exported = await exportSimplifiedPlainSqlDatabase({
    root: path.join(root, "export"),
    identity,
    exporter: fakeExporter(),
    recoveryKey: key,
  });
  assert.equal(exported.representation, "postgres_plain_sql_v1");
  assert.equal(exported.restoreStrategy, "psql_file_restore_v1");
  assert.equal(exported.plaintextFilename, "database.sql");
  assert.equal(exported.postgresMajor, 17);
  await assert.rejects(readFile(path.join(root, "export", "database", "database.sql")), { code: "ENOENT" });

  const parsed = parsePlainSqlArtifactManifest(await readFile(exported.manifestPath, "utf8"));
  assert.equal(parsed.manifest_version, "car-zone-backup-v2-manifest-v1");
  assert.equal(parsed.representation, "postgres_plain_sql_v1");
  assert.equal(parsed.restore_strategy, "psql_file_restore_v1");
  assert.equal(parsed.export.format, "plain");
  assert.equal(parsed.export.production_source_access, "READ_ONLY");
  assert.equal(parsed.encryption.format_version, "car-zone-aesgcm-envelope-v1");
  assert.equal(parsed.hashes.algorithm, "sha256");

  const executor = createFileBasedPsqlRestoreExecutor({
    target,
    verifyTarget: async () => undefined,
    operations: operations(),
  });
  const restored = await stageAndRestorePlainSqlArtifact({
    artifactPath: exported.artifactPath,
    manifestPath: exported.manifestPath,
    restoreRoot: path.join(root, "restore-success"),
    recoveryKey: key,
    executor,
    target,
  });
  assert.equal(restored.dockerCopy, "PASS");
  assert.equal(restored.psqlX, true);
  assert.equal(restored.onErrorStop, true);
  assert.equal(restored.stdinSqlPayload, false);
  await assert.rejects(readFile(path.join(root, "restore-success", "database.sql")), { code: "ENOENT" });

  const truncated = path.join(root, "truncated.czb2");
  await copyFile(exported.artifactPath, truncated);
  const originalBytes = (await readFile(truncated)).length;
  await truncate(truncated, Math.max(1, originalBytes - 17));
  await assert.rejects(() => stageAndRestorePlainSqlArtifact({
    artifactPath: truncated,
    manifestPath: exported.manifestPath,
    restoreRoot: path.join(root, "restore-truncated"),
    recoveryKey: key,
    executor,
    target,
  }));

  const tampered = path.join(root, "tampered.czb2");
  const tamperedBytes = Buffer.from(await readFile(exported.artifactPath));
  tamperedBytes[Math.floor(tamperedBytes.length / 2)] ^= 0x40;
  await writeFile(tampered, tamperedBytes, { flag: "wx", mode: 0o600 });
  await assert.rejects(() => stageAndRestorePlainSqlArtifact({
    artifactPath: tampered,
    manifestPath: exported.manifestPath,
    restoreRoot: path.join(root, "restore-tampered"),
    recoveryKey: key,
    executor,
    target,
  }));

  await rejectsCode(() => stageAndRestorePlainSqlArtifact({
    artifactPath: exported.artifactPath,
    manifestPath: exported.manifestPath,
    restoreRoot: path.join(root, "restore-wrong-key"),
    recoveryKey: randomBytes(32),
    executor,
    target,
  }), "BACKUP_V2_DECRYPT_FAILED");

  const manifestValue = JSON.parse(await readFile(exported.manifestPath, "utf8"));
  const corruptCompressedPath = path.join(root, "corrupt-compressed.czb2");
  const corruptCompressedManifestPath = path.join(root, "corrupt-compressed.json");
  const corruptCompressed = Buffer.from(gzipSync(Buffer.from(sql, "utf8"), { level: 9 }));
  corruptCompressed[0] ^= 0xff;
  const corruptNonce = randomBytes(12);
  const corruptCipher = createCipheriv("aes-256-gcm", key, corruptNonce, { authTagLength: 16 });
  const corruptAad = plainSqlAadFromManifest(manifestValue);
  corruptCipher.setAAD(corruptAad);
  const corruptCiphertext = Buffer.concat([corruptCipher.update(corruptCompressed), corruptCipher.final()]);
  const corruptTag = corruptCipher.getAuthTag();
  const corruptEnvelope = Buffer.concat([Buffer.from("CZB2SQL1", "ascii"), corruptNonce, corruptCiphertext, corruptTag]);
  const corruptManifest = {
    ...manifestValue,
    encryption: {
      ...manifestValue.encryption,
      nonce_base64: corruptNonce.toString("base64"),
      auth_tag_base64: corruptTag.toString("base64"),
      aad_sha256: sha256Hex(corruptAad),
    },
    byte_counts: {
      ...manifestValue.byte_counts,
      compressed: String(corruptCompressed.length),
      encrypted_artifact: String(corruptEnvelope.length),
    },
    hashes: {
      ...manifestValue.hashes,
      compressed: sha256Hex(corruptCompressed),
      encrypted_artifact: sha256Hex(corruptEnvelope),
    },
  };
  await writeFile(corruptCompressedPath, corruptEnvelope, { flag: "wx", mode: 0o600 });
  await writeFile(corruptCompressedManifestPath, canonicalWithIntegrity(corruptManifest), { flag: "wx", mode: 0o600 });
  await rejectsCode(() => stageAndRestorePlainSqlArtifact({
    artifactPath: corruptCompressedPath,
    manifestPath: corruptCompressedManifestPath,
    restoreRoot: path.join(root, "restore-corrupt-compressed"),
    recoveryKey: key,
    executor,
    target,
  }), "BACKUP_V2_DECRYPTION_OR_COMPRESSION_FAILED");

  const shaMismatch = path.join(root, "sha-mismatch.json");
  await writeFile(shaMismatch, `${canonicalJson({
    ...manifestValue,
    hashes: { ...manifestValue.hashes, plaintext_export: "9".repeat(64) },
  })}\n`, { flag: "wx", mode: 0o600 });
  await rejectsCode(async () => parsePlainSqlArtifactManifest(
    await readFile(shaMismatch, "utf8"),
  ), "BACKUP_V2_INTEGRITY_FAILED");

  const wrongRepresentation = path.join(root, "wrong-representation.json");
  await writeFile(wrongRepresentation, canonicalWithIntegrity({
    ...manifestValue,
    representation: "postgresql_custom",
  }), { flag: "wx", mode: 0o600 });
  await rejectsCode(async () => parsePlainSqlArtifactManifest(
    await readFile(wrongRepresentation, "utf8"),
  ), "BACKUP_V2_SQL_ARTIFACT_INVALID");

  const wrongMajor = path.join(root, "wrong-major.json");
  await writeFile(wrongMajor, canonicalWithIntegrity({
    ...manifestValue,
    postgres_major: 18,
  }), { flag: "wx", mode: 0o600 });
  await rejectsCode(async () => parsePlainSqlArtifactManifest(
    await readFile(wrongMajor, "utf8"),
  ), "BACKUP_V2_POSTGRES_MAJOR_UNSUPPORTED");

  await assert.rejects(() => stageAndRestorePlainSqlArtifact({
    artifactPath: path.join(root, "missing.czb2"),
    manifestPath: exported.manifestPath,
    restoreRoot: path.join(root, "restore-missing"),
    recoveryKey: key,
    executor,
    target,
  }));

  const staleRoot = path.join(root, "restore-stale");
  await mkdir(staleRoot, { recursive: true });
  await writeFile(path.join(staleRoot, "database.sql"), sql, "utf8");
  await rejectsCode(() => stageAndRestorePlainSqlArtifact({
    artifactPath: exported.artifactPath,
    manifestPath: exported.manifestPath,
    restoreRoot: staleRoot,
    recoveryKey: key,
    executor,
    target,
  }), "BACKUP_V2_STALE_STAGING_FILE");

  const badSqlExport = await exportSimplifiedPlainSqlDatabase({
    root: path.join(root, "bad-sql-export"),
    identity: { ...identity, runId: runId.replace("12345678", "22345678") },
    exporter: fakeExporter(`${sql}CREATE TABLE public.before_failure(id integer);\nTHIS IS NOT SQL;\n`),
    recoveryKey: key,
  });
  const failingPsql = createFileBasedPsqlRestoreExecutor({
    target,
    verifyTarget: async () => undefined,
    operations: operations({
      async restore() {
        throw new BackupV2FailClosedError("BACKUP_V2_PSQL_RESTORE_FAILED", "synthetic psql failure");
      },
    }),
  });
  await rejectsCode(() => stageAndRestorePlainSqlArtifact({
    artifactPath: badSqlExport.artifactPath,
    manifestPath: badSqlExport.manifestPath,
    restoreRoot: path.join(root, "restore-corrupt-sql"),
    recoveryKey: key,
    executor: failingPsql,
    target,
  }), "BACKUP_V2_PSQL_RESTORE_FAILED");

  const sqlFile = path.join(root, "executor.sql");
  await writeFile(sqlFile, sql, { flag: "wx", mode: 0o600 });
  await rejectsCode(() => createFileBasedPsqlRestoreExecutor({
    target,
    verifyTarget: async () => undefined,
    operations: operations({
      async prepare() {
        throw new BackupV2FailClosedError("BACKUP_V2_DOCKER_UNAVAILABLE", "synthetic docker unavailable");
      },
    }),
  }).restore(sqlFile, target), "BACKUP_V2_DOCKER_UNAVAILABLE");
  await rejectsCode(() => createFileBasedPsqlRestoreExecutor({
    target,
    verifyTarget: async () => undefined,
    operations: operations({
      async copy() {
        throw new BackupV2FailClosedError("BACKUP_V2_DOCKER_COPY_FAILED", "synthetic copy failure");
      },
    }),
  }).restore(sqlFile, target), "BACKUP_V2_DOCKER_COPY_FAILED");
  await rejectsCode(() => createFileBasedPsqlRestoreExecutor({
    target,
    verifyTarget: async () => undefined,
    operations: operations({
      async restore() {
        throw new BackupV2FailClosedError("BACKUP_V2_PSQL_RESTORE_FAILED", "synthetic missing psql");
      },
    }),
  }).restore(sqlFile, target), "BACKUP_V2_PSQL_RESTORE_FAILED");
  await rejectsCode(() => createFileBasedPsqlRestoreExecutor({
    target,
    verifyTarget: async () => undefined,
    operations: operations({
      async cleanup() {
        throw new BackupV2FailClosedError("BACKUP_V2_CLEANUP_FAILED", "synthetic cleanup failure");
      },
    }),
  }).restore(sqlFile, target), "BACKUP_V2_CLEANUP_FAILED");

  const directories = [];
  function concurrentOperations() {
    let sourcePath;
    return operations({
      async prepare({ directory }) { directories.push(directory); },
      async copy(input) { sourcePath = input.sourcePath; },
      async inspect() {
        const value = await readFile(sourcePath);
        return { bytes: BigInt(value.length), sha256: sha256Hex(value) };
      },
    });
  }
  const secondSql = path.join(root, "executor-two.sql");
  await writeFile(secondSql, sql.replace("contract_fixture", "contract_fixture_two"), { flag: "wx", mode: 0o600 });
  const secondTarget = {
    ...target,
    database: "carzone_backup_v2_restore_contract02",
    containerName: "carzone-backup-v2-contract-target-two",
    marker: "b".repeat(32),
  };
  await Promise.all([
    createFileBasedPsqlRestoreExecutor({
      target,
      verifyTarget: async () => undefined,
      operations: concurrentOperations(),
    }).restore(sqlFile, target),
    createFileBasedPsqlRestoreExecutor({
      target: secondTarget,
      verifyTarget: async () => undefined,
      operations: concurrentOperations(),
    }).restore(secondSql, secondTarget),
  ]);
  assert.equal(new Set(directories).size, 2);

  const component = (name) => ({
    component: name,
    artifact_id: `${name}-${"3".repeat(64)}`,
    artifact_object_key: `${simplifiedRemotePrefix(runId)}${name}/artifact.czb2`,
    artifact_bytes: "1",
    artifact_sha256: "4".repeat(64),
    manifest_object_key: `${simplifiedRemotePrefix(runId)}${name}/artifact.manifest.json`,
    manifest_bytes: "1",
    manifest_sha256: "5".repeat(64),
    plaintext_bytes: "1",
    plaintext_sha256: "6".repeat(64),
    logical_count: "1",
    format_version: name === "database" ? "postgres_plain_sql_v1" : "component-payload-v1",
    encryption_envelope: "car-zone-aesgcm-envelope-v1",
    representation: name === "database" ? "postgres_plain_sql_v1" : "component-payload-v1",
    plaintext_filename: name === "database" ? "database.sql" : null,
    restore_strategy: name === "database" ? "psql_file_restore_v1" : "component_file_materialization_v1",
    postgres_major: name === "database" ? 17 : null,
  });
  const components = ["database", "auth", "storage_metadata", "storage_objects", "external_assets"].map(component);
  const body = {
    schema: "car-zone-backup-v2-simplified-manifest-v1",
    application: "car-zone-accesorios",
    run_id: runId,
    created_at: "2026-08-22T00:00:00.000Z",
    local_artifact_binding: bindingKey,
    remote_prefix: simplifiedRemotePrefix(runId),
    components,
    production_source_access: "READ_ONLY",
    production_mutations: 0,
    independent_secondary_present: false,
    full_dr_ready: false,
  };
  assert.equal(createSimplifiedManifest(body).components.length, 5);
  await rejectsCode(
    () => Promise.resolve(createSimplifiedManifest({ ...body, components: components.slice(0, 4) })),
    "BACKUP_V2_SIMPLIFIED_MANIFEST_INVALID",
  );
  await rejectsCode(
    () => Promise.resolve(createSimplifiedManifest({ ...body, components: [...components.slice(0, 4), components[0]] })),
    "BACKUP_V2_SIMPLIFIED_MANIFEST_INVALID",
  );

  const [plainModule, productionModule, configModule, commandScript, b2Transport, b2Provider,
    postgresRunnerModule, disposableTargetModule] = await Promise.all([
    readFile(new URL("../src/lib/backups/v2-simplified/plain-sql.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/backups/v2-simplified/production.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/backups/v2-simplified/config.ts", import.meta.url), "utf8"),
    readFile(new URL("./backup-v2-simplified-first-real-sql.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/backups/v2/b2-s3-transport.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/backups/v2/backblaze-b2-storage-provider.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/backups/v2/postgres-tool-runner.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/backups/v2/disposable-postgres-target.ts", import.meta.url), "utf8"),
  ]);
  assert.match(plainModule, /"--format=plain"/);
  assert.match(plainModule, /"-X"/);
  assert.match(plainModule, /"ON_ERROR_STOP=on"/);
  assert.match(plainModule, /"-f", containerPath/);
  assert.doesNotMatch(plainModule, /pipePostgresToolInput/);
  assert.doesNotMatch(productionModule, /createFileBasedRunnerPgRestoreExecutor|pg_restore/);
  assert.match(commandScript, /BACKUP_V2_SIMPLIFIED_SQL_CONFIRMATION/);
  assert.match(commandScript, /postgres_plain_sql_v1/);
  assert.match(configModule, /loadPhase4B6SessionSecrets/);
  assert.doesNotMatch(b2Transport, /IfNoneMatch|ifNoneMatch/);
  assert.doesNotMatch(b2Provider, /IfNoneMatch|ifNoneMatch/);
  assert.match(postgresRunnerModule, /supabase\/postgres:17\.6\.1\.121/);
  assert.doesNotMatch(postgresRunnerModule, /postgres:17-alpine/);
  assert.match(disposableTargetModule, /const USER = "supabase_admin"/);
  assert.match(disposableTargetModule, /CREATE DATABASE \$\{database\} OWNER \$\{USER\}/);
  assert.doesNotMatch(
    `${plainModule}\n${productionModule}\n${commandScript}`,
    /BACKUP_V2_B2_APPLICATION_KEY\s*=\s*["'][^"']+|SUPABASE_SERVICE_ROLE_KEY\s*=\s*["'][^"']+/,
  );

  process.stdout.write(`${JSON.stringify({
    adversarialCases: 20,
    aes256Gcm: "PASS",
    cleanup: "PASS",
    concurrentRestoreIsolation: "PASS",
    fileBasedPsql: "PASS",
    manifest: "PASS",
    postgresRepresentation: "postgres_plain_sql_v1",
    primaryRestoreStrategy: "psql_file_restore_v1",
    result: "PASS",
    sha256: "PASS",
  })}\n`);
} finally {
  key.fill(0);
  await rm(root, { recursive: true, force: true });
}
