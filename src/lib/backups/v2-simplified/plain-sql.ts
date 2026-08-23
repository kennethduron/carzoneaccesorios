import "server-only";

import { randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  verifyBackupV2EncryptedArtifact,
  writeBackupV2EncryptedArtifact,
} from "../v2/artifact-crypto-pipeline.ts";
import { canonicalJson, sha256Hex } from "../v2/database-artifact-format.ts";
import {
  createPostgresToolExecutionError,
  postgresSignalClass,
  type PostgresDiagnosticTool,
  type PostgresOperationName,
} from "../v2/postgres-failure-observability.ts";
import type { PostgresConnection, PostgresToolRunner } from "../v2/postgres-tool-runner.ts";
import { BackupV2FailClosedError } from "../v2/types.ts";
import { measureFile } from "./core.ts";
import type { SimplifiedComponentResult } from "./types.ts";

export const POSTGRES_PLAIN_SQL_REPRESENTATION = "postgres_plain_sql_v1" as const;
export const PSQL_FILE_RESTORE_STRATEGY = "psql_file_restore_v1" as const;
export const POSTGRES_PLAIN_SQL_FILENAME = "database.sql" as const;
export const POSTGRES_PLAIN_SQL_MAJOR = 17 as const;
export const POSTGRES_PLAIN_SQL_MANIFEST_VERSION = "car-zone-backup-v2-manifest-v1" as const;
export const POSTGRES_PLAIN_SQL_BACKUP_VERSION = "simplified-sql-v1" as const;

const PLAIN_SQL_MAGIC = Buffer.from("CZB2SQL1", "ascii");
const MAX_PLAINTEXT_BYTES = BigInt("1099511627776");
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SAFE_CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_MARKER = /^[a-f0-9]{16,64}$/;

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

export interface PlainSqlDatabaseExporter {
  readonly tool: "pg_dump";
  readonly toolVersion: string;
  readonly representation: typeof POSTGRES_PLAIN_SQL_REPRESENTATION;
  readonly postgresMajor: typeof POSTGRES_PLAIN_SQL_MAJOR;
  readonly safeArguments: readonly string[];
  exportToFile(destinationPath: string, signal?: AbortSignal): Promise<void>;
}

export interface PlainSqlRestoreTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly username?: string;
  readonly password: string;
  readonly containerName: string;
  readonly marker: string;
  readonly postgresMajor: typeof POSTGRES_PLAIN_SQL_MAJOR;
}

export interface PlainSqlRestoreEvidence {
  readonly bytes: bigint;
  readonly sha256: string;
  readonly dockerCopy: "PASS";
  readonly psqlX: true;
  readonly onErrorStop: true;
  readonly stdinSqlPayload: false;
  readonly cleanup: "PASS";
}

export interface PlainSqlRestoreExecutor {
  restore(sqlPath: string, target: PlainSqlRestoreTarget, signal?: AbortSignal): Promise<PlainSqlRestoreEvidence>;
}

export interface PlainSqlArtifactManifest {
  readonly manifest_version: typeof POSTGRES_PLAIN_SQL_MANIFEST_VERSION;
  readonly backup_v2_version: typeof POSTGRES_PLAIN_SQL_BACKUP_VERSION;
  readonly run_id: string;
  readonly generation_key: string;
  readonly artifact_id: string;
  readonly component: "database";
  readonly created_at: string;
  readonly representation: typeof POSTGRES_PLAIN_SQL_REPRESENTATION;
  readonly filename: typeof POSTGRES_PLAIN_SQL_FILENAME;
  readonly restore_strategy: typeof PSQL_FILE_RESTORE_STRATEGY;
  readonly postgres_major: typeof POSTGRES_PLAIN_SQL_MAJOR;
  readonly catalog: { readonly fingerprint: string; readonly policy_version: string };
  readonly preflight: { readonly snapshot_id: string; readonly outcome: "go" };
  readonly export: {
    readonly tool: "pg_dump";
    readonly tool_version: string;
    readonly format: "plain";
    readonly arguments: readonly string[];
    readonly production_source_access: "READ_ONLY";
  };
  readonly compression: { readonly algorithm: "gzip"; readonly format_version: "rfc1952"; readonly level: 9 };
  readonly encryption: {
    readonly algorithm: "aes-256-gcm";
    readonly format_version: "car-zone-aesgcm-envelope-v1";
    readonly nonce_base64: string;
    readonly auth_tag_base64: string;
    readonly key_version: "operator-recovery-key-v1";
    readonly key_reference: "external-operator-recovery-key";
    readonly key_fingerprint: string;
    readonly aad_sha256: string;
  };
  readonly byte_counts: {
    readonly plaintext_export: string;
    readonly compressed: string;
    readonly encrypted_artifact: string;
  };
  readonly hashes: {
    readonly algorithm: "sha256";
    readonly plaintext_export: string;
    readonly compressed: string;
    readonly encrypted_artifact: string;
  };
  readonly artifact: {
    readonly filename: string;
    readonly content_type: "application/vnd.car-zone.backup-v2.database";
  };
  readonly integrity: { readonly manifest_sha256: string };
}

export interface PlainSqlExportIdentity {
  readonly runId: string;
  readonly createdAt: string;
  readonly bindingKey: string;
  readonly catalogFingerprint: string;
  readonly catalogPolicyVersion: string;
  readonly preflightSnapshotId: string;
}

function requireKey(value: Uint8Array): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) {
    fail("BACKUP_V2_SIMPLIFIED_INVALID_RECOVERY_KEY", "AES-256-GCM requires exactly 32 key bytes");
  }
  return Buffer.from(value);
}

export async function createRunnerPlainSqlExporter(input: {
  readonly runner: PostgresToolRunner;
  readonly connection: PostgresConnection;
  readonly containerName?: string;
  readonly snapshotId?: string;
}): Promise<PlainSqlDatabaseExporter> {
  const capabilities = await input.runner.inspectCapabilities();
  if (capabilities.major !== POSTGRES_PLAIN_SQL_MAJOR) {
    fail("BACKUP_V2_POSTGRES_MAJOR_UNSUPPORTED", "pg_dump major version must be PostgreSQL 17");
  }
  await input.runner.assertServerCompatibility(input.connection, input.containerName);
  if (input.snapshotId !== undefined && !/^[0-9A-Fa-f-]{8,128}$/.test(input.snapshotId)) {
    fail("BACKUP_V2_SQL_ARTIFACT_INVALID", "Exported snapshot identity is invalid");
  }
  const args = Object.freeze([
    "--format=plain",
    "--no-owner",
    "--no-privileges",
    "--encoding=UTF8",
    "--quote-all-identifiers",
    ...(input.snapshotId ? [`--snapshot=${input.snapshotId}`] : []),
  ]);
  return Object.freeze({
    tool: "pg_dump" as const,
    toolVersion: capabilities.pg_dump,
    representation: POSTGRES_PLAIN_SQL_REPRESENTATION,
    postgresMajor: POSTGRES_PLAIN_SQL_MAJOR,
    safeArguments: args,
    async exportToFile(destinationPath: string, signal?: AbortSignal): Promise<void> {
      await mkdir(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
      try {
        await lstat(destinationPath);
        fail("BACKUP_V2_STALE_STAGING_FILE", "Plain SQL destination already exists");
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
      }
      const partial = `${destinationPath}.partial-${randomUUID()}`;
      const session = input.runner.open({
        tool: "pg_dump",
        operation: "DATABASE_EXPORT_PG_DUMP",
        args,
        connection: input.connection,
        containerName: input.containerName,
        signal,
      });
      session.stdin.end();
      try {
        await Promise.all([
          pipeline(session.stdout, createWriteStream(partial, { flags: "wx", mode: 0o600 })),
          session.completed,
        ]);
        await rename(partial, destinationPath);
      } catch (error) {
        session.cancel();
        await session.completed.catch(() => undefined);
        await rm(partial, { force: true });
        if (error instanceof BackupV2FailClosedError) throw error;
        throw new BackupV2FailClosedError("BACKUP_V2_PG_DUMP_FAILED", "Plain SQL pg_dump failed safely");
      }
    },
  });
}

async function assertPlainSqlFile(filePath: string): Promise<{ bytes: bigint; sha256: string }> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 32) {
    fail("BACKUP_V2_SQL_ARTIFACT_INVALID", "database.sql is missing, empty, or unsafe");
  }
  const handle = await open(filePath, "r");
  try {
    const prefix = Buffer.alloc(Math.min(8192, stat.size));
    const read = await handle.read(prefix, 0, prefix.length, 0);
    const value = prefix.subarray(0, read.bytesRead);
    if (value.includes(0) || !value.toString("utf8").includes("PostgreSQL database dump")) {
      fail("BACKUP_V2_SQL_ARTIFACT_INVALID", "database.sql is not a PostgreSQL plain-text dump");
    }
  } finally {
    await handle.close();
  }
  return measureFile(filePath);
}

function artifactId(generationKey: string): string {
  if (!/^backup-v2-generation:[0-9a-f]{64}$/.test(generationKey)) {
    fail("BACKUP_V2_SQL_ARTIFACT_INVALID", "Generation key is invalid");
  }
  return `database-${sha256Hex(`backup-v2-plain-sql-v1\n${generationKey}`)}`;
}

function plainSqlAad(input: {
  runId: string;
  generationKey: string;
  artifactId: string;
  createdAt: string;
  catalogFingerprint: string;
  catalogPolicyVersion: string;
  preflightSnapshotId: string;
  toolVersion: string;
  safeArguments: readonly string[];
  keyFingerprint: string;
  plaintextSha256: string;
}): Buffer {
  return Buffer.from(canonicalJson({
    artifact_id: input.artifactId,
    catalog_fingerprint: input.catalogFingerprint,
    catalog_policy_version: input.catalogPolicyVersion,
    created_at: input.createdAt,
    export_arguments: input.safeArguments,
    export_tool: "pg_dump",
    export_tool_version: input.toolVersion,
    filename: POSTGRES_PLAIN_SQL_FILENAME,
    generation_key: input.generationKey,
    key_fingerprint: input.keyFingerprint,
    plaintext_sha256: input.plaintextSha256,
    postgres_major: POSTGRES_PLAIN_SQL_MAJOR,
    representation: POSTGRES_PLAIN_SQL_REPRESENTATION,
    restore_strategy: PSQL_FILE_RESTORE_STRATEGY,
    run_id: input.runId,
    schema: "car-zone-backup-v2-plain-sql-aad-v1",
  }), "utf8");
}

function withIntegrity(value: Omit<PlainSqlArtifactManifest, "integrity">): PlainSqlArtifactManifest {
  return Object.freeze({ ...value, integrity: { manifest_sha256: sha256Hex(canonicalJson(value)) } });
}

async function writeCanonicalManifest(filePath: string, value: PlainSqlArtifactManifest): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("BACKUP_V2_SQL_ARTIFACT_INVALID", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function parsePlainSqlArtifactManifest(value: string): PlainSqlArtifactManifest {
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { fail("BACKUP_V2_SQL_ARTIFACT_INVALID", "Plain SQL manifest is not JSON"); }
  const root = record(parsed, "manifest");
  if (value !== `${canonicalJson(root)}\n`) fail("BACKUP_V2_SQL_ARTIFACT_INVALID", "Plain SQL manifest is not canonical");
  const integrity = record(root.integrity, "integrity");
  const { integrity: _removed, ...body } = root;
  void _removed;
  if (root.manifest_version !== POSTGRES_PLAIN_SQL_MANIFEST_VERSION ||
      root.backup_v2_version !== POSTGRES_PLAIN_SQL_BACKUP_VERSION ||
      root.component !== "database" ||
      root.representation !== POSTGRES_PLAIN_SQL_REPRESENTATION ||
      root.filename !== POSTGRES_PLAIN_SQL_FILENAME ||
      root.restore_strategy !== PSQL_FILE_RESTORE_STRATEGY) {
    fail("BACKUP_V2_SQL_ARTIFACT_INVALID", "Plain SQL representation contract is invalid");
  }
  if (root.postgres_major !== POSTGRES_PLAIN_SQL_MAJOR) {
    fail("BACKUP_V2_POSTGRES_MAJOR_UNSUPPORTED", "Plain SQL manifest requires PostgreSQL 17");
  }
  if (typeof integrity.manifest_sha256 !== "string" || !SHA256.test(integrity.manifest_sha256) ||
      !timingSafeEqual(Buffer.from(integrity.manifest_sha256, "hex"), Buffer.from(sha256Hex(canonicalJson(body)), "hex"))) {
    fail("BACKUP_V2_INTEGRITY_FAILED", "Plain SQL manifest integrity failed");
  }
  const exportValue = record(root.export, "export");
  const encryption = record(root.encryption, "encryption");
  const byteCounts = record(root.byte_counts, "byte_counts");
  const hashes = record(root.hashes, "hashes");
  const artifact = record(root.artifact, "artifact");
  if (exportValue.tool !== "pg_dump" || exportValue.format !== "plain" ||
      exportValue.production_source_access !== "READ_ONLY" || !Array.isArray(exportValue.arguments) ||
      exportValue.arguments.some((item) => typeof item !== "string") ||
      !exportValue.arguments.includes("--format=plain") ||
      encryption.algorithm !== "aes-256-gcm" ||
      encryption.format_version !== "car-zone-aesgcm-envelope-v1" ||
      !DECIMAL.test(String(byteCounts.plaintext_export)) || byteCounts.plaintext_export === "0" ||
      !DECIMAL.test(String(byteCounts.compressed)) ||
      !DECIMAL.test(String(byteCounts.encrypted_artifact)) ||
      hashes.algorithm !== "sha256" ||
      !SHA256.test(String(hashes.plaintext_export)) ||
      !SHA256.test(String(hashes.compressed)) ||
      !SHA256.test(String(hashes.encrypted_artifact)) ||
      artifact.content_type !== "application/vnd.car-zone.backup-v2.database" ||
      typeof artifact.filename !== "string" || !/^database-[0-9a-f]{64}\.czb2$/.test(artifact.filename) ||
      typeof root.generation_key !== "string" || !/^backup-v2-generation:[0-9a-f]{64}$/.test(root.generation_key) ||
      typeof root.artifact_id !== "string" || root.artifact_id !== artifactId(root.generation_key) ||
      typeof root.created_at !== "string" || !Number.isFinite(Date.parse(root.created_at))) {
    fail("BACKUP_V2_SQL_ARTIFACT_INVALID", "Plain SQL manifest fields are invalid");
  }
  return root as unknown as PlainSqlArtifactManifest;
}

export async function exportSimplifiedPlainSqlDatabase(input: {
  readonly root: string;
  readonly identity: PlainSqlExportIdentity;
  readonly exporter: PlainSqlDatabaseExporter;
  readonly recoveryKey: Uint8Array;
  readonly signal?: AbortSignal;
}): Promise<SimplifiedComponentResult> {
  if (input.exporter.representation !== POSTGRES_PLAIN_SQL_REPRESENTATION ||
      input.exporter.postgresMajor !== POSTGRES_PLAIN_SQL_MAJOR ||
      !input.exporter.safeArguments.includes("--format=plain")) {
    fail("BACKUP_V2_SIMPLIFIED_DATABASE_EXPORTER_INVALID", "Database exporter is not the approved PostgreSQL 17 plain-SQL exporter");
  }
  const key = requireKey(input.recoveryKey);
  const directory = path.join(input.root, "database");
  const sqlPath = path.join(directory, POSTGRES_PLAIN_SQL_FILENAME);
  const id = artifactId(input.identity.bindingKey);
  const encryptedPath = path.join(directory, `${id}.czb2`);
  const manifestPath = path.join(directory, `${id}.manifest.json`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await input.exporter.exportToFile(sqlPath, input.signal);
    const plaintext = await assertPlainSqlFile(sqlPath);
    const keyFingerprint = sha256Hex(key);
    const aad = plainSqlAad({
      runId: input.identity.runId,
      generationKey: input.identity.bindingKey,
      artifactId: id,
      createdAt: input.identity.createdAt,
      catalogFingerprint: input.identity.catalogFingerprint,
      catalogPolicyVersion: input.identity.catalogPolicyVersion,
      preflightSnapshotId: input.identity.preflightSnapshotId,
      toolVersion: input.exporter.toolVersion,
      safeArguments: input.exporter.safeArguments,
      keyFingerprint,
      plaintextSha256: plaintext.sha256,
    });
    const layers = await writeBackupV2EncryptedArtifact({
      source: createReadStream(sqlPath),
      outputPath: encryptedPath,
      encryptionKey: key,
      aad,
      magic: PLAIN_SQL_MAGIC,
      compressionLevel: 9,
      maxPlaintextBytes: MAX_PLAINTEXT_BYTES,
      signal: input.signal,
    });
    if (layers.plaintextBytes !== plaintext.bytes || layers.plaintextHash !== plaintext.sha256) {
      fail("BACKUP_V2_INTEGRITY_FAILED", "Plain SQL changed between measurement and encryption");
    }
    const manifest = withIntegrity({
      manifest_version: POSTGRES_PLAIN_SQL_MANIFEST_VERSION,
      backup_v2_version: POSTGRES_PLAIN_SQL_BACKUP_VERSION,
      run_id: input.identity.runId,
      generation_key: input.identity.bindingKey,
      artifact_id: id,
      component: "database",
      created_at: input.identity.createdAt,
      representation: POSTGRES_PLAIN_SQL_REPRESENTATION,
      filename: POSTGRES_PLAIN_SQL_FILENAME,
      restore_strategy: PSQL_FILE_RESTORE_STRATEGY,
      postgres_major: POSTGRES_PLAIN_SQL_MAJOR,
      catalog: { fingerprint: input.identity.catalogFingerprint, policy_version: input.identity.catalogPolicyVersion },
      preflight: { snapshot_id: input.identity.preflightSnapshotId, outcome: "go" },
      export: {
        tool: "pg_dump",
        tool_version: input.exporter.toolVersion,
        format: "plain",
        arguments: input.exporter.safeArguments,
        production_source_access: "READ_ONLY",
      },
      compression: { algorithm: "gzip", format_version: "rfc1952", level: 9 },
      encryption: {
        algorithm: "aes-256-gcm",
        format_version: "car-zone-aesgcm-envelope-v1",
        nonce_base64: layers.nonce.toString("base64"),
        auth_tag_base64: layers.authTag.toString("base64"),
        key_version: "operator-recovery-key-v1",
        key_reference: "external-operator-recovery-key",
        key_fingerprint: keyFingerprint,
        aad_sha256: sha256Hex(aad),
      },
      byte_counts: {
        plaintext_export: layers.plaintextBytes.toString(),
        compressed: layers.compressedBytes.toString(),
        encrypted_artifact: layers.encryptedArtifactBytes.toString(),
      },
      hashes: {
        algorithm: "sha256",
        plaintext_export: layers.plaintextHash,
        compressed: layers.compressedHash,
        encrypted_artifact: layers.encryptedArtifactHash,
      },
      artifact: {
        filename: `${id}.czb2`,
        content_type: "application/vnd.car-zone.backup-v2.database",
      },
    });
    await writeCanonicalManifest(manifestPath, manifest);
    parsePlainSqlArtifactManifest(await readFile(manifestPath, "utf8"));
    const artifactMeasured = await measureFile(encryptedPath);
    const manifestMeasured = await measureFile(manifestPath);
    if (artifactMeasured.bytes !== layers.encryptedArtifactBytes ||
        artifactMeasured.sha256 !== layers.encryptedArtifactHash) {
      fail("BACKUP_V2_INTEGRITY_FAILED", "Encrypted Plain SQL artifact changed after creation");
    }
    return Object.freeze({
      component: "database",
      artifactId: id,
      artifactPath: encryptedPath,
      manifestPath,
      artifactBytes: artifactMeasured.bytes,
      artifactSha256: artifactMeasured.sha256,
      manifestBytes: manifestMeasured.bytes,
      manifestSha256: manifestMeasured.sha256,
      plaintextBytes: plaintext.bytes,
      plaintextSha256: plaintext.sha256,
      logicalCount: BigInt(1),
      formatVersion: POSTGRES_PLAIN_SQL_REPRESENTATION,
      representation: POSTGRES_PLAIN_SQL_REPRESENTATION,
      plaintextFilename: POSTGRES_PLAIN_SQL_FILENAME,
      restoreStrategy: PSQL_FILE_RESTORE_STRATEGY,
      postgresMajor: POSTGRES_PLAIN_SQL_MAJOR,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    key.fill(0);
    await rm(sqlPath, { force: true });
  }
}

function manifestAad(manifest: PlainSqlArtifactManifest): Buffer {
  return plainSqlAad({
    runId: manifest.run_id,
    generationKey: manifest.generation_key,
    artifactId: manifest.artifact_id,
    createdAt: manifest.created_at,
    catalogFingerprint: manifest.catalog.fingerprint,
    catalogPolicyVersion: manifest.catalog.policy_version,
    preflightSnapshotId: manifest.preflight.snapshot_id,
    toolVersion: manifest.export.tool_version,
    safeArguments: manifest.export.arguments,
    keyFingerprint: manifest.encryption.key_fingerprint,
    plaintextSha256: manifest.hashes.plaintext_export,
  });
}

class SafeFileSink extends Writable {
  readonly #path: string;
  #handle: Awaited<ReturnType<typeof open>> | null = null;
  #aborted = false;

  constructor(filePath: string) {
    super();
    this.#path = filePath;
  }

  override _write(chunk: Buffer | string, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    const value = Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk, encoding);
    void (async () => {
      if (this.#aborted) fail("BACKUP_V2_DECRYPT_FAILED", "Plain SQL staging was cancelled");
      this.#handle ??= await open(this.#path, "wx", 0o600);
      if (this.#aborted) fail("BACKUP_V2_DECRYPT_FAILED", "Plain SQL staging was cancelled");
      await this.#handle.write(value);
    })().then(() => callback(), callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (!this.#handle) { callback(); return; }
    const handle = this.#handle;
    this.#handle = null;
    void handle.sync().then(() => handle.close()).then(() => callback(), callback);
  }

  async abort(): Promise<void> {
    this.#aborted = true;
    await this.#handle?.close().catch(() => undefined);
    this.#handle = null;
    await rm(this.#path, { force: true });
  }
}

export async function stageAndRestorePlainSqlArtifact(input: {
  readonly artifactPath: string;
  readonly manifestPath: string;
  readonly restoreRoot: string;
  readonly recoveryKey: Uint8Array;
  readonly executor: PlainSqlRestoreExecutor;
  readonly target: PlainSqlRestoreTarget;
  readonly signal?: AbortSignal;
}): Promise<PlainSqlRestoreEvidence> {
  const manifest = parsePlainSqlArtifactManifest(await readFile(input.manifestPath, "utf8"));
  if (input.target.postgresMajor !== POSTGRES_PLAIN_SQL_MAJOR) {
    fail("BACKUP_V2_POSTGRES_MAJOR_UNSUPPORTED", "Restore target must be PostgreSQL 17");
  }
  const key = requireKey(input.recoveryKey);
  if (manifest.encryption.key_fingerprint !== sha256Hex(key)) {
    key.fill(0);
    fail("BACKUP_V2_DECRYPT_FAILED", "Recovery key does not match the Plain SQL artifact");
  }
  await mkdir(input.restoreRoot, { recursive: true, mode: 0o700 });
  const partial = path.join(input.restoreRoot, `${POSTGRES_PLAIN_SQL_FILENAME}.partial-${randomUUID()}`);
  const sqlPath = path.join(input.restoreRoot, POSTGRES_PLAIN_SQL_FILENAME);
  try {
    try {
      await lstat(sqlPath);
      fail("BACKUP_V2_STALE_STAGING_FILE", "Stale database.sql cannot be reused");
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
    }
    const aad = manifestAad(manifest);
    if (sha256Hex(aad) !== manifest.encryption.aad_sha256) {
      fail("BACKUP_V2_INTEGRITY_FAILED", "Plain SQL authenticated metadata changed");
    }
    const sink = new SafeFileSink(partial);
    try {
      await verifyBackupV2EncryptedArtifact({
        artifactPath: input.artifactPath,
        encryptionKey: key,
        aad,
        magic: PLAIN_SQL_MAGIC,
        nonce: Buffer.from(manifest.encryption.nonce_base64, "base64"),
        authTag: Buffer.from(manifest.encryption.auth_tag_base64, "base64"),
        plaintextBytes: BigInt(manifest.byte_counts.plaintext_export),
        compressedBytes: BigInt(manifest.byte_counts.compressed),
        encryptedArtifactBytes: BigInt(manifest.byte_counts.encrypted_artifact),
        plaintextHash: manifest.hashes.plaintext_export,
        compressedHash: manifest.hashes.compressed,
        encryptedArtifactHash: manifest.hashes.encrypted_artifact,
        maxPlaintextBytes: MAX_PLAINTEXT_BYTES,
        maxCompressionRatio: 500,
        plaintextSink: sink,
      });
    } catch (error) {
      await sink.abort();
      if (error instanceof BackupV2FailClosedError) throw error;
      throw new BackupV2FailClosedError("BACKUP_V2_DECRYPT_FAILED", "Plain SQL decrypt/decompress failed safely");
    }
    await rename(partial, sqlPath);
    const staged = await assertPlainSqlFile(sqlPath);
    if (staged.bytes !== BigInt(manifest.byte_counts.plaintext_export) ||
        staged.sha256 !== manifest.hashes.plaintext_export) {
      fail("BACKUP_V2_INTEGRITY_FAILED", "Staged database.sql failed plaintext integrity");
    }
    return await input.executor.restore(sqlPath, input.target, input.signal);
  } finally {
    key.fill(0);
    await rm(partial, { force: true });
    await rm(sqlPath, { force: true });
  }
}

function minimalDockerEnvironment(password?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { NODE_ENV: process.env.NODE_ENV ?? "production" };
  for (const name of ["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "DOCKER_HOST", "DOCKER_CONTEXT"]) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  if (password !== undefined) environment.PGPASSWORD = password;
  return environment;
}

async function dockerCommand(input: {
  args: readonly string[];
  operation: PostgresOperationName;
  tool: PostgresDiagnosticTool;
  code: string;
  password?: string;
  capture?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...input.args], {
      env: minimalDockerEnvironment(input.password),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let childError: unknown;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (input.capture !== false) stdout = `${stdout}${chunk}`.slice(0, 1_048_576);
    });
    child.stderr.on("data", (chunk: string) => { stderr = `${stderr}${chunk}`.slice(0, 8192); });
    const cancel = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
    if (input.signal?.aborted) cancel();
    input.signal?.addEventListener("abort", cancel, { once: true });
    child.once("error", (error) => { childError = error; });
    child.once("close", (exitCode, exitSignal) => {
      input.signal?.removeEventListener("abort", cancel);
      if (exitCode === 0 && exitSignal === null && childError === undefined) { resolve(stdout); return; }
      reject(createPostgresToolExecutionError({
        operation: input.operation,
        tool: childError === undefined ? input.tool : "docker",
        exitCode,
        signalClass: postgresSignalClass(exitSignal, input.signal?.aborted === true, input.signal?.reason),
        rawStderr: stderr || (childError instanceof Error ? childError.message : ""),
        systemError: childError,
        stdinClosed: true,
        childExitedBeforeWrite: false,
        code: input.code,
      }));
    });
  });
}

export interface PlainSqlRestoreOperations {
  prepare(input: { target: PlainSqlRestoreTarget; directory: string; signal?: AbortSignal }): Promise<void>;
  copy(input: { target: PlainSqlRestoreTarget; sourcePath: string; destinationPath: string; signal?: AbortSignal }): Promise<void>;
  inspect(input: { target: PlainSqlRestoreTarget; path: string; signal?: AbortSignal }): Promise<{ bytes: bigint; sha256: string }>;
  restore(input: { target: PlainSqlRestoreTarget; path: string; signal?: AbortSignal }): Promise<void>;
  cleanup(input: { target: PlainSqlRestoreTarget; directory: string; signal?: AbortSignal }): Promise<void>;
}

function defaultPlainSqlRestoreOperations(): PlainSqlRestoreOperations {
  const operations: PlainSqlRestoreOperations = {
    async prepare({ target, directory, signal }) {
      await dockerCommand({
        args: ["exec", target.containerName, "mkdir", "-m", "700", directory],
        operation: "RESTORE_DB_DOCKER_DIRECTORY", tool: "docker",
        code: "BACKUP_V2_DOCKER_UNAVAILABLE", signal,
      });
    },
    async copy({ target, sourcePath, destinationPath, signal }) {
      await dockerCommand({
        args: ["cp", sourcePath, `${target.containerName}:${destinationPath}`],
        operation: "RESTORE_DB_DOCKER_COPY", tool: "docker",
        code: "BACKUP_V2_DOCKER_COPY_FAILED", signal,
      });
    },
    async inspect({ target, path: containerPath, signal }) {
      const size = (await dockerCommand({
        args: ["exec", target.containerName, "stat", "-c", "%s", containerPath],
        operation: "RESTORE_DB_DOCKER_SIZE_VERIFY", tool: "docker",
        code: "BACKUP_V2_DOCKER_COPY_FAILED", signal,
      })).trim();
      const hash = (await dockerCommand({
        args: ["exec", target.containerName, "sha256sum", containerPath],
        operation: "RESTORE_DB_DOCKER_SHA256_VERIFY", tool: "docker",
        code: "BACKUP_V2_DOCKER_COPY_FAILED", signal,
      })).trim();
      const match = /^([0-9a-f]{64})(?:\s|$)/.exec(hash);
      if (!DECIMAL.test(size) || !match) fail("BACKUP_V2_DOCKER_COPY_FAILED", "Copied database.sql evidence is invalid");
      return { bytes: BigInt(size), sha256: match[1] };
    },
    async restore({ target, path: containerPath, signal }) {
      await dockerCommand({
        args: [
          "exec",
          "--env", "PGHOST=127.0.0.1",
          "--env", "PGPORT=5432",
          "--env", `PGDATABASE=${target.database}`,
          "--env", `PGUSER=${target.user}`,
          "--env", "PGPASSWORD",
          target.containerName,
          "psql",
          "-X",
          "--set", "ON_ERROR_STOP=on",
          "-f", containerPath,
        ],
        operation: "RESTORE_DB_PSQL_FILE", tool: "psql",
        code: "BACKUP_V2_PSQL_RESTORE_FAILED", password: target.password,
        capture: false, signal,
      });
    },
    async cleanup({ target, directory, signal }) {
      await dockerCommand({
        args: ["exec", target.containerName, "rm", "-rf", directory],
        operation: "RESTORE_DB_FILE_CLEANUP", tool: "docker",
        code: "BACKUP_V2_CLEANUP_FAILED", signal,
      });
    },
  };
  return Object.freeze(operations);
}

function validateRestoreTarget(target: PlainSqlRestoreTarget): PlainSqlRestoreTarget {
  const user = target.user || target.username;
  if (target.host !== "127.0.0.1" || !Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535 ||
      !/^carzone_backup_v2_restore_[a-z0-9_]{8,80}$/.test(target.database) ||
      typeof user !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(user) ||
      typeof target.password !== "string" || target.password.length < 8 ||
      !SAFE_CONTAINER.test(target.containerName) || !SAFE_MARKER.test(target.marker) ||
      target.postgresMajor !== POSTGRES_PLAIN_SQL_MAJOR) {
    fail("BACKUP_V2_SIMPLIFIED_UNSAFE_RESTORE_TARGET", "Restore target is not an isolated PostgreSQL 17 container");
  }
  return Object.freeze({ ...target, user, postgresMajor: POSTGRES_PLAIN_SQL_MAJOR });
}

export function createFileBasedPsqlRestoreExecutor(input: {
  readonly target: PlainSqlRestoreTarget;
  readonly verifyTarget: () => Promise<void>;
  readonly operations?: PlainSqlRestoreOperations;
}): PlainSqlRestoreExecutor {
  const provisioned = validateRestoreTarget(input.target);
  const operations = input.operations ?? defaultPlainSqlRestoreOperations();
  return Object.freeze({
    async restore(sqlPath: string, targetValue: PlainSqlRestoreTarget, signal?: AbortSignal): Promise<PlainSqlRestoreEvidence> {
      const target = validateRestoreTarget(targetValue);
      if (target.containerName !== provisioned.containerName || target.marker !== provisioned.marker ||
          target.database !== provisioned.database || target.user !== provisioned.user) {
        fail("BACKUP_V2_RESTORE_TARGET_IDENTITY_DENIED", "Restore target differs from the verified provision");
      }
      await input.verifyTarget();
      const expected = await assertPlainSqlFile(sqlPath);
      const directory = `/tmp/carzone-backup-v2-sql-${target.marker.slice(0, 24)}-${sha256Hex(sqlPath).slice(0, 12)}`;
      const containerPath = `${directory}/${POSTGRES_PLAIN_SQL_FILENAME}`;
      let primaryError: unknown;
      try {
        await operations.prepare({ target, directory, signal });
        await operations.copy({ target, sourcePath: sqlPath, destinationPath: containerPath, signal });
        const copied = await operations.inspect({ target, path: containerPath, signal });
        if (copied.bytes !== expected.bytes || !SHA256.test(copied.sha256) ||
            !timingSafeEqual(Buffer.from(copied.sha256, "hex"), Buffer.from(expected.sha256, "hex"))) {
          fail("BACKUP_V2_DOCKER_COPY_FAILED", "Copied database.sql differs from local staging");
        }
        await operations.restore({ target, path: containerPath, signal });
        await input.verifyTarget();
      } catch (error) {
        primaryError = error;
        throw error;
      } finally {
        try {
          await operations.cleanup({ target, directory, signal });
        } catch (cleanupError) {
          if (primaryError === undefined) throw cleanupError;
        }
      }
      return Object.freeze({
        bytes: expected.bytes,
        sha256: expected.sha256,
        dockerCopy: "PASS",
        psqlX: true,
        onErrorStop: true,
        stdinSqlPayload: false,
        cleanup: "PASS",
      });
    },
  });
}
