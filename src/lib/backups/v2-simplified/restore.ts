import "server-only";

import { lstat, readFile } from "node:fs/promises";

import { BackupV2FailClosedError } from "../v2/types.ts";
import { restoreSimplifiedComponents, type RestoredComponentSummary } from "./component-restore.ts";
import { measureFile, safeHashEqual } from "./core.ts";
import {
  parsePlainSqlArtifactManifest,
  stageAndRestorePlainSqlArtifact,
  type PlainSqlRestoreEvidence,
  type PlainSqlRestoreTarget,
} from "./plain-sql.ts";
import type {
  SimplifiedArtifactDescriptor,
  SimplifiedBackupManifest,
  SimplifiedRestoreProvision,
} from "./types.ts";

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

export function assertSimplifiedRestoreTarget(
  target: PlainSqlRestoreTarget,
  sourceDatabaseUrl?: string,
): PlainSqlRestoreTarget {
  if (target.host !== "127.0.0.1" || target.postgresMajor !== 17 ||
      !Number.isSafeInteger(target.port) || target.port < 1 || target.port > 65535 ||
      !/^carzone_backup_v2_restore_[a-z0-9_]{8,80}$/.test(target.database) ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(target.user) ||
      typeof target.password !== "string" || target.password.length < 8 ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(target.containerName)) {
    fail("BACKUP_V2_SIMPLIFIED_UNSAFE_RESTORE_TARGET", "Restore target is not an isolated PostgreSQL 17 container");
  }
  if (sourceDatabaseUrl) {
    let source: URL;
    try { source = new URL(sourceDatabaseUrl); }
    catch { fail("BACKUP_V2_SIMPLIFIED_UNSAFE_RESTORE_TARGET", "Source database URL is invalid"); }
    const sourcePort = source.port ? Number(source.port) : 5432;
    const sourceDatabase = decodeURIComponent(source.pathname.replace(/^\//, ""));
    if (source.hostname.toLowerCase() === target.host && sourcePort === target.port &&
        sourceDatabase === target.database) {
      fail("BACKUP_V2_SIMPLIFIED_UNSAFE_RESTORE_TARGET", "Production source and restore target are identical");
    }
  }
  return target;
}

function descriptor(
  descriptors: readonly SimplifiedArtifactDescriptor[],
  kind: "encrypted_payload" | "manifest_sidecar",
): SimplifiedArtifactDescriptor {
  const matches = descriptors.filter((item) => item.component === "database" && item.kind === kind);
  if (matches.length !== 1) fail("BACKUP_V2_COMPONENT_MISSING", "Plain SQL database descriptor is missing or duplicated");
  return matches[0];
}

async function assertDownloaded(filePath: string, expected: SimplifiedArtifactDescriptor): Promise<void> {
  const stat = await lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("BACKUP_V2_INTEGRITY_FAILED", "Downloaded database artifact is unsafe");
  const measured = await measureFile(filePath);
  if (measured.bytes !== expected.bytes || !safeHashEqual(measured.sha256, expected.sha256)) {
    fail("BACKUP_V2_INTEGRITY_FAILED", "Downloaded database artifact failed SHA-256 verification");
  }
}

export interface SimplifiedRecoveryEvidence {
  readonly components: readonly {
    readonly component: "database" | RestoredComponentSummary["component"];
    readonly verificationStatus: "verified";
    readonly restoredLogicalCount: bigint;
  }[];
  readonly database: PlainSqlRestoreEvidence;
  readonly completeSameGenerationRestore: true;
  readonly recoverabilityProven: true;
  readonly fullDrReady: false;
}

export interface SimplifiedRestoreResult {
  readonly recovery: SimplifiedRecoveryEvidence;
  readonly databaseVerification: Readonly<Record<string, string | number | boolean>>;
  readonly componentSummaries: readonly RestoredComponentSummary[];
}

export async function restoreAndVerifySimplifiedBackup(input: {
  readonly manifest: SimplifiedBackupManifest;
  readonly descriptors: readonly SimplifiedArtifactDescriptor[];
  readonly downloadedPaths: ReadonlyMap<string, string>;
  readonly restoreRoot: string;
  readonly recoveryKey: Uint8Array;
  readonly provision: SimplifiedRestoreProvision;
  readonly sourceDatabaseUrl?: string;
  readonly signal?: AbortSignal;
}): Promise<SimplifiedRestoreResult> {
  const target = assertSimplifiedRestoreTarget(input.provision.target, input.sourceDatabaseUrl);
  if (input.manifest.components.length !== 5) fail("BACKUP_V2_COMPONENT_MISSING", "Exactly five components are required");
  const databaseEntry = input.manifest.components.find((item) => item.component === "database");
  if (!databaseEntry || databaseEntry.representation !== "postgres_plain_sql_v1" ||
      databaseEntry.restore_strategy !== "psql_file_restore_v1" ||
      databaseEntry.plaintext_filename !== "database.sql" ||
      databaseEntry.postgres_major !== 17) {
    fail("BACKUP_V2_SQL_ARTIFACT_INVALID", "Database manifest entry is not the approved Plain SQL contract");
  }
  const artifactDescriptor = descriptor(input.descriptors, "encrypted_payload");
  const manifestDescriptor = descriptor(input.descriptors, "manifest_sidecar");
  if (artifactDescriptor.artifactId !== databaseEntry.artifact_id ||
      manifestDescriptor.artifactId !== databaseEntry.artifact_id ||
      artifactDescriptor.objectKey !== databaseEntry.artifact_object_key ||
      manifestDescriptor.objectKey !== databaseEntry.manifest_object_key) {
    fail("BACKUP_V2_SIMPLIFIED_CROSS_RUN_DENIED", "Database descriptors differ from the authenticated manifest");
  }
  const artifactPath = input.downloadedPaths.get(artifactDescriptor.objectKey);
  const manifestPath = input.downloadedPaths.get(manifestDescriptor.objectKey);
  if (!artifactPath || !manifestPath) fail("BACKUP_V2_COMPONENT_MISSING", "Downloaded Plain SQL database artifact is absent");
  await assertDownloaded(artifactPath, artifactDescriptor);
  await assertDownloaded(manifestPath, manifestDescriptor);
  const sidecar = parsePlainSqlArtifactManifest(await readFile(manifestPath, "utf8"));
  if (sidecar.run_id !== input.manifest.run_id ||
      sidecar.generation_key !== input.manifest.local_artifact_binding ||
      sidecar.artifact_id !== databaseEntry.artifact_id) {
    fail("BACKUP_V2_SIMPLIFIED_CROSS_RUN_DENIED", "Plain SQL sidecar is outside the authenticated run");
  }
  const database = await stageAndRestorePlainSqlArtifact({
    artifactPath,
    manifestPath,
    restoreRoot: `${input.restoreRoot}/database`,
    recoveryKey: input.recoveryKey,
    executor: input.provision.executor,
    target,
    signal: input.signal,
  });
  const componentSummaries = await restoreSimplifiedComponents({
    manifest: input.manifest,
    descriptors: input.descriptors,
    downloadedPaths: input.downloadedPaths,
    restoreRoot: input.restoreRoot,
    recoveryKey: input.recoveryKey,
  });
  const databaseVerification = await input.provision.verifyDatabase();
  if (Object.keys(databaseVerification).length === 0) {
    fail("BACKUP_V2_SEMANTIC_VALIDATION_FAILED", "Database semantic validation returned no evidence");
  }
  const components = Object.freeze([
    Object.freeze({ component: "database" as const, verificationStatus: "verified" as const, restoredLogicalCount: BigInt(1) }),
    ...componentSummaries.map((item) => Object.freeze({
      component: item.component,
      verificationStatus: "verified" as const,
      restoredLogicalCount: item.recordCount,
    })),
  ]);
  if (components.length !== 5 || new Set(components.map((item) => item.component)).size !== 5) {
    fail("BACKUP_V2_COMPONENT_MISSING", "Recovery verification is incomplete");
  }
  return Object.freeze({
    recovery: Object.freeze({
      components,
      database,
      completeSameGenerationRestore: true,
      recoverabilityProven: true,
      fullDrReady: false,
    }),
    databaseVerification,
    componentSummaries,
  });
}
