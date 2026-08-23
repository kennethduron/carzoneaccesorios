import "server-only";

import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { canonicalJson, sha256Hex } from "../v2/database-artifact-format.ts";
import { BackupV2StorageError } from "../v2/storage-contract.ts";
import { sanitizedPostgresFailureEvidence } from "../v2/postgres-failure-observability.ts";
import { BackupV2FailClosedError } from "../v2/types.ts";
import {
  assertSufficientLocalDisk,
  canonicalTimestamp,
  createSimplifiedRunId,
  createSimplifiedStateRoot,
  safeHashEqual,
  writeCanonicalJsonFile,
  writeSafeReport,
} from "./core.ts";
import {
  createSimplifiedExportIdentity,
  exportSimplifiedComponent,
  verifySimplifiedLocalComponent,
} from "./export-components.ts";
import { exportSimplifiedPlainSqlDatabase } from "./plain-sql.ts";
import {
  componentArtifactDescriptors,
  decryptAndVerifySimplifiedManifest,
  writeSimplifiedManifestBundle,
} from "./manifest.ts";
import { downloadAndVerifySimplifiedArtifacts, uploadAndVerifySimplifiedArtifacts } from "./remote.ts";
import { restoreAndVerifySimplifiedBackup } from "./restore.ts";
import type {
  RunSimplifiedBackupInput,
  SimplifiedComponent,
  SimplifiedComponentResult,
  SimplifiedFinalReport,
  SimplifiedRestoreProvision,
  SimplifiedRunResult,
  SimplifiedStage,
} from "./types.ts";

const COMPONENT_RESULTS: Record<SimplifiedComponent, "NOT_RUN"> = {
  database: "NOT_RUN",
  auth: "NOT_RUN",
  storage_metadata: "NOT_RUN",
  storage_objects: "NOT_RUN",
  external_assets: "NOT_RUN",
};

function safeCode(error: unknown): string {
  if (error instanceof BackupV2FailClosedError && /^[A-Z0-9_]{3,120}$/.test(error.code)) return error.code;
  if (typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string" && /^[A-Z0-9_]{2,40}$/.test(error.code)) {
    return `BACKUP_V2_SIMPLIFIED_LOCAL_${error.code}`;
  }
  return "BACKUP_V2_SIMPLIFIED_UNEXPECTED_FAILURE";
}

function stageComponent(stage: SimplifiedStage): SimplifiedComponent | null {
  const values: Partial<Record<SimplifiedStage, SimplifiedComponent>> = {
    DATABASE_EXPORT: "database",
    AUTH_EXPORT: "auth",
    STORAGE_METADATA_EXPORT: "storage_metadata",
    STORAGE_OBJECTS_EXPORT: "storage_objects",
    EXTERNAL_ASSETS_EXPORT: "external_assets",
  };
  return values[stage] ?? null;
}

function measurementFingerprint(value: Awaited<ReturnType<RunSimplifiedBackupInput["sources"]["measureCanonicalSource"]>>): string {
  return sha256Hex(canonicalJson(Object.fromEntries(
    Object.entries(value).map(([name, count]) => [name, count.toString()]),
  )));
}

export class SimplifiedBackupRunError extends BackupV2FailClosedError {
  readonly result: SimplifiedRunResult;

  constructor(result: SimplifiedRunResult) {
    super(result.report.code ?? "BACKUP_V2_SIMPLIFIED_FAILED", "Simplified Backup V2 failed; inspect the safe local report");
    this.name = "SimplifiedBackupRunError";
    this.result = result;
  }
}

export async function runSimplifiedBackup(input: RunSimplifiedBackupInput): Promise<SimplifiedRunResult> {
  const clock = input.clock ?? (() => new Date().toISOString());
  const runId = createSimplifiedRunId(clock, input.randomUuid ?? randomUUID);
  const startedAt = canonicalTimestamp(clock);
  const stateRoot = await createSimplifiedStateRoot(input.stateParent, runId);
  const stagingRoot = path.join(stateRoot, "staging");
  const downloadRoot = path.join(stateRoot, "download");
  const restoreRoot = path.join(stateRoot, "restore");
  const reportPath = path.join(stateRoot, "backup-v2-simplified-report.json");
  const statePath = path.join(stateRoot, "state.json");
  await mkdir(stagingRoot, { mode: 0o700 });
  const key = Buffer.from(input.recoveryKey);
  const componentResults: Record<SimplifiedComponent, "PASS" | "FAIL" | "NOT_RUN"> = { ...COMPONENT_RESULTS };
  const diagnostics: string[] = [];
  let currentStage: SimplifiedStage = "CONFIG_VALIDATION";
  let provision: SimplifiedRestoreProvision | null = null;
  let sourceCleaned = false;
  const exportedResults: SimplifiedComponentResult[] = [];
  let backupVerified = false;
  let restoreVerified = false;
  let remoteObjectsVerified = 0;

  const componentEvidence = (): SimplifiedFinalReport["componentEvidence"] => Object.freeze(Object.fromEntries(
    (["database", "auth", "storage_metadata", "storage_objects", "external_assets"] as const).map((component) => {
      const result = exportedResults.find((item) => item.component === component);
      return [component, result ? Object.freeze({
        logicalCount: result.logicalCount.toString(),
        plaintextBytes: result.plaintextBytes.toString(),
        encryptedBytes: result.artifactBytes.toString(),
        encryptedSha256: result.artifactSha256,
        remoteVerified: backupVerified,
        restoreVerified,
      }) : null];
    }),
  )) as unknown as SimplifiedFinalReport["componentEvidence"];

  const enter = async (stage: SimplifiedStage): Promise<void> => {
    currentStage = stage;
    await writeCanonicalJsonFile(statePath, {
      schema: "car-zone-backup-v2-simplified-state-v1",
      run_id: runId,
      status: stage === "COMPLETE" ? "RECOVERABILITY_PROVEN" : backupVerified ? "VERIFIED" : "RUNNING",
      stage,
      production_mutation: "NONE",
      updated_at: canonicalTimestamp(clock),
    });
    try { await input.stageHook?.(stage); }
    catch { throw new BackupV2FailClosedError("BACKUP_V2_SIMPLIFIED_STAGE_HOOK_FAILED", "Synthetic stage hook failed safely"); }
  };

  const cleanup = async (success: boolean): Promise<"PASS" | "FAIL"> => {
    let passed = true;
    if (provision) {
      try { await provision.cleanup(); } catch { passed = false; diagnostics.push("DISPOSABLE_RESTORE_CLEANUP_FAILED"); }
      provision = null;
    }
    if (!sourceCleaned) {
      try { await input.sources.cleanup(); sourceCleaned = true; }
      catch { passed = false; diagnostics.push("SOURCE_READER_CLEANUP_FAILED"); }
    }
    try { await rm(restoreRoot, { recursive: true, force: true }); }
    catch { passed = false; diagnostics.push("PLAINTEXT_RESTORE_CLEANUP_FAILED"); }
    if (success) {
      try {
        await rm(stagingRoot, { recursive: true, force: true });
        await rm(downloadRoot, { recursive: true, force: true });
      } catch { passed = false; diagnostics.push("ENCRYPTED_STAGING_CLEANUP_FAILED"); }
    }
    return passed ? "PASS" : "FAIL";
  };

  await writeCanonicalJsonFile(statePath, {
    schema: "car-zone-backup-v2-simplified-state-v1",
    run_id: runId,
    status: "PENDING",
    stage: "CONFIG_VALIDATION",
    production_mutation: "NONE",
    updated_at: startedAt,
  });

  try {
    if (key.byteLength !== 32) {
      throw new BackupV2FailClosedError("BACKUP_V2_SIMPLIFIED_INVALID_RECOVERY_KEY", "Recovery key is invalid");
    }
    if (!Array.isArray(input.sources.mutationMethods) || input.sources.mutationMethods.length !== 0) {
      throw new BackupV2FailClosedError("BACKUP_V2_SIMPLIFIED_SOURCE_WRITE_CAPABILITY_DENIED", "Source adapter exposes mutation capability");
    }
    await enter("SOURCE_PREFLIGHT");
    const measurements = await input.sources.measureCanonicalSource();
    const measuredSourceBytes = measurements.databaseBytes + measurements.authBytes + measurements.storageMetadataBytes +
      measurements.storageObjectBytes + measurements.externalAssetBytes;
    if (input.remoteSoftBudgetBytes !== undefined && measuredSourceBytes > input.remoteSoftBudgetBytes) {
      throw new BackupV2FailClosedError("BACKUP_V2_SIMPLIFIED_B2_BUDGET_EXCEEDED", "Estimated backup exceeds the configured B2 soft budget");
    }
    await assertSufficientLocalDisk({
      pathValue: stateRoot,
      measurements,
      available: input.availableDiskBytes,
      safetyMarginBytes: input.minimumDiskSafetyMarginBytes,
    });
    const identity = createSimplifiedExportIdentity({
      runId,
      createdAt: startedAt,
      measurementsFingerprint: measurementFingerprint(measurements),
    });

    await enter("DATABASE_EXPORT");
    exportedResults.push(await exportSimplifiedPlainSqlDatabase({
      root: stagingRoot,
      identity: {
        ...identity,
        catalogPolicyVersion: "simplified-source-read-only-v1",
      },
      exporter: input.sources.database,
      recoveryKey: key,
    }));
    componentResults.database = "PASS";

    await enter("AUTH_EXPORT");
    const auth = await exportSimplifiedComponent({ root: stagingRoot, identity, source: input.sources.auth, recoveryKey: key });
    exportedResults.push(auth); componentResults.auth = "PASS";

    await enter("STORAGE_METADATA_EXPORT");
    const storageMetadata = await exportSimplifiedComponent({ root: stagingRoot, identity, source: input.sources.storageMetadata, recoveryKey: key });
    exportedResults.push(storageMetadata); componentResults.storage_metadata = "PASS";

    await enter("STORAGE_OBJECTS_EXPORT");
    const storageObjects = await exportSimplifiedComponent({
      root: stagingRoot, identity, source: input.sources.storageObjects, recoveryKey: key, storageMetadata,
    });
    exportedResults.push(storageObjects); componentResults.storage_objects = "PASS";

    await enter("EXTERNAL_ASSETS_EXPORT");
    const externalAssets = await exportSimplifiedComponent({ root: stagingRoot, identity, source: input.sources.externalAssets, recoveryKey: key });
    exportedResults.push(externalAssets); componentResults.external_assets = "PASS";

    await enter("MANIFEST");
    const bundle = await writeSimplifiedManifestBundle({
      root: stagingRoot,
      runId,
      createdAt: startedAt,
      bindingKey: identity.bindingKey,
      results: exportedResults,
      recoveryKey: key,
    });
    const componentDescriptors = componentArtifactDescriptors(runId, exportedResults);
    const descriptors = Object.freeze([...componentDescriptors, ...bundle.descriptors]);

    await enter("LOCAL_INTEGRITY");
    for (const result of exportedResults) await verifySimplifiedLocalComponent({ result, identity, recoveryKey: key });
    await enter("ENCRYPTION");
    const localManifestDescriptor = bundle.descriptors.find((item) => item.kind === "encrypted_manifest")!;
    const localIndexDescriptor = bundle.descriptors.find((item) => item.kind === "index")!;
    const locallyDecrypted = await decryptAndVerifySimplifiedManifest({
      encryptedManifestPath: localManifestDescriptor.localPath,
      indexPath: localIndexDescriptor.localPath,
      recoveryKey: key,
    });
    if (!safeHashEqual(locallyDecrypted.integrity.manifest_sha256, bundle.manifest.integrity.manifest_sha256)) {
      throw new BackupV2FailClosedError("BACKUP_V2_SIMPLIFIED_MANIFEST_TAMPERED", "Local encrypted manifest differs from its source");
    }

    await enter("B2_UPLOAD");
    await uploadAndVerifySimplifiedArtifacts({
      provider: input.storageProvider,
      runId,
      descriptors,
      maxAttempts: input.remoteMaxAttempts,
      baseDelayMs: input.remoteRetryBaseDelayMs,
    });
    await enter("B2_REMOTE_VERIFY");

    await enter("B2_DOWNLOAD");
    const downloaded = await downloadAndVerifySimplifiedArtifacts({
      provider: input.storageProvider,
      runId,
      descriptors,
      downloadRoot,
      maxAttempts: input.remoteMaxAttempts,
      baseDelayMs: input.remoteRetryBaseDelayMs,
    });
    await enter("REMOTE_SHA256");
    const remoteManifest = await decryptAndVerifySimplifiedManifest({
      encryptedManifestPath: downloaded.get(localManifestDescriptor.objectKey)!,
      indexPath: downloaded.get(localIndexDescriptor.objectKey)!,
      recoveryKey: key,
    });
    if (canonicalJson(remoteManifest) !== canonicalJson(bundle.manifest)) {
      throw new BackupV2FailClosedError("BACKUP_V2_SIMPLIFIED_CROSS_RUN_DENIED", "Remote manifest differs from the local verified manifest");
    }
    backupVerified = true;
    remoteObjectsVerified = descriptors.length;

    await enter("ISOLATED_RESTORE");
    await mkdir(restoreRoot, { mode: 0o700 });
    provision = await input.restore();
    await restoreAndVerifySimplifiedBackup({
      manifest: remoteManifest,
      descriptors,
      downloadedPaths: downloaded,
      restoreRoot,
      recoveryKey: key,
      provision,
      sourceDatabaseUrl: input.sourceDatabaseUrl,
    });
    restoreVerified = true;
    await enter("RECOVERY_VERIFICATION");
    await enter("TEMP_CLEANUP");
    const cleanupResult = await cleanup(true);
    if (cleanupResult !== "PASS") {
      throw new BackupV2FailClosedError("BACKUP_V2_SIMPLIFIED_CLEANUP_FAILED", "Sensitive temporary cleanup did not complete");
    }
    await enter("COMPLETE");
    const report: SimplifiedFinalReport = Object.freeze({
      schema: "car-zone-backup-v2-simplified-report-v1",
      backupV2Simplified: "RECOVERABILITY_PROVEN",
      runId,
      startedAt,
      completedAt: canonicalTimestamp(clock),
      status: "RECOVERABILITY_PROVEN",
      failedStage: null,
      code: null,
      retryability: null,
      subprocess: null,
      systemCode: null,
      subprocessExitCode: null,
      subprocessSignalClass: null,
      stderrClass: null,
      stdinClosed: null,
      childExitedBeforeWrite: null,
      productionMutation: "NONE",
      componentResults: Object.freeze({ ...componentResults }),
      componentEvidence: componentEvidence(),
      remoteObjectsVerified,
      backupVerified,
      recoverabilityProven: true,
      independentSecondaryPresent: false,
      fullDrReady: false,
      cleanup: "PASS",
      safeDiagnostics: Object.freeze([...diagnostics]),
    });
    await writeSafeReport(reportPath, report);
    return Object.freeze({ stateRoot, reportPath, report });
  } catch (error) {
    const failedComponent = stageComponent(currentStage);
    if (failedComponent) componentResults[failedComponent] = "FAIL";
    const cleanupResult = await cleanup(false);
    const code = safeCode(error);
    const postgres = sanitizedPostgresFailureEvidence(error);
    if (postgres) diagnostics.push(
      `POSTGRES_${postgres.failureOperation}_${postgres.failureTool}_${postgres.exitCode ?? "NO_EXIT"}_${postgres.stderrClass}`,
    );
    const retryability: SimplifiedFinalReport["retryability"] = error instanceof BackupV2StorageError
      ? error.retryable ? "TRANSIENT" : "NON_RETRYABLE"
      : postgres
        ? postgres.retryability === "NON_RETRYABLE_CONFIGURATION"
          ? "NON_RETRYABLE"
          : ["TRANSIENT_POSSIBLE", "ENVIRONMENT_OR_NETWORK"].includes(postgres.retryability)
            ? "TRANSIENT"
            : "UNKNOWN"
        : "NON_RETRYABLE";
    const report: SimplifiedFinalReport = Object.freeze({
      schema: "car-zone-backup-v2-simplified-report-v1",
      backupV2Simplified: "FAILED",
      runId,
      startedAt,
      completedAt: canonicalTimestamp(clock),
      status: "FAILED",
      failedStage: currentStage,
      code,
      retryability,
      subprocess: postgres?.failureTool ?? null,
      systemCode: postgres?.systemCode ?? null,
      subprocessExitCode: postgres?.exitCode ?? null,
      subprocessSignalClass: postgres?.signalClass ?? null,
      stderrClass: postgres?.stderrClass ?? null,
      stdinClosed: postgres?.stdinClosed ?? null,
      childExitedBeforeWrite: postgres?.childExitedBeforeWrite ?? null,
      productionMutation: "NONE",
      componentResults: Object.freeze({ ...componentResults }),
      componentEvidence: componentEvidence(),
      remoteObjectsVerified,
      backupVerified,
      recoverabilityProven: false,
      independentSecondaryPresent: false,
      fullDrReady: false,
      cleanup: cleanupResult,
      safeDiagnostics: Object.freeze([...diagnostics, `FAILED_STAGE_${currentStage}`, `SAFE_CODE_${code}`]),
    });
    await writeSafeReport(reportPath, report);
    await writeCanonicalJsonFile(statePath, {
      schema: "car-zone-backup-v2-simplified-state-v1",
      run_id: runId,
      status: "FAILED",
      stage: currentStage,
      code,
      subprocess: postgres?.failureTool ?? null,
      system_code: postgres?.systemCode ?? null,
      subprocess_exit_code: postgres?.exitCode ?? null,
      subprocess_signal_class: postgres?.signalClass ?? null,
      stderr_class: postgres?.stderrClass ?? null,
      stdin_closed: postgres?.stdinClosed ?? null,
      child_exited_before_write: postgres?.childExitedBeforeWrite ?? null,
      production_mutation: "NONE",
      updated_at: canonicalTimestamp(clock),
    });
    throw new SimplifiedBackupRunError(Object.freeze({ stateRoot, reportPath, report }));
  } finally {
    key.fill(0);
  }
}
