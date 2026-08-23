import "server-only";

import path from "node:path";

import { createAwsSdkBackblazeB2Transport, type BackblazeB2S3Transport } from "../v2/b2-s3-transport.ts";
import {
  createBackblazeB2ArtifactStorageProvider,
  simplifiedBackupV2RealStorageAuthorization,
} from "../v2/backblaze-b2-storage-provider.ts";
import { createPostgresToolRunner } from "../v2/postgres-tool-runner.ts";
import { createProductionBackupSources } from "../v2/production-sources.ts";
import { BackupV2FailClosedError } from "../v2/types.ts";
import { loadSimplifiedRealConfig } from "../v2-simplified/config.ts";
import { simplifiedArtifactBinding } from "../v2-simplified/core.ts";
import { runSimplifiedBackup, SimplifiedBackupRunError } from "../v2-simplified/orchestrator.ts";
import type {
  SimplifiedBackupSources,
  SimplifiedFinalReport,
  SimplifiedRunResult,
  SimplifiedSourceMeasurements,
} from "../v2-simplified/types.ts";
import {
  acquireOperationalLock,
  appendOperationalLog,
  nextScheduledRun,
  readOperationalStatus,
  writeOperationalStatus,
  type OperationalStatus,
} from "./local-state.ts";
import {
  assertOperationalBudget,
  inventoryOperationalGenerations,
  planOperationalRetention,
  sanitizeOperationalText,
  type RemoteObjectEvidence,
} from "./policy.ts";

const CONFIRMATION = "SCHEDULED_BACKUP_V2_GENERATION";
const REPRESENTATION = "postgres_plain_sql_v1";
const RESTORE_STRATEGY = "psql_file_restore_v1";
const MAX_REMOTE_OBJECTS = 100_000;

function fail(code: string, message: string): never {
  throw new BackupV2FailClosedError(code, message);
}

function safeCode(error: unknown): string {
  if (error instanceof BackupV2FailClosedError && /^[A-Z0-9_]{3,120}$/.test(error.code)) return error.code;
  return "BACKUP_V2_OPERATIONAL_UNEXPECTED_FAILURE";
}

function sourceBytes(measurements: SimplifiedSourceMeasurements): bigint {
  return measurements.databaseBytes + measurements.authBytes + measurements.storageMetadataBytes +
    measurements.storageObjectBytes + measurements.externalAssetBytes;
}

export function isSafePreUploadSourceDriftRetry(
  report: Pick<SimplifiedFinalReport, "backupVerified" | "cleanup" | "code" | "failedStage" | "remoteObjectsVerified">,
  automaticRetryCount: number,
): boolean {
  return automaticRetryCount === 0 && report.code === "BACKUP_V2_SOURCE_OBJECT_CHANGED" &&
    report.cleanup === "PASS" && report.backupVerified === false && report.remoteObjectsVerified === 0 &&
    ["DATABASE_EXPORT", "AUTH_EXPORT", "STORAGE_METADATA_EXPORT", "STORAGE_OBJECTS_EXPORT", "EXTERNAL_ASSETS_EXPORT"]
      .includes(report.failedStage ?? "");
}

function requiredOperationalRoot(environment: NodeJS.ProcessEnv): string {
  const value = environment.BACKUP_V2_OPERATIONAL_ROOT?.trim();
  if (!value || value.includes("\0") || !path.isAbsolute(value)) {
    fail("BACKUP_V2_OPERATIONAL_ROOT_INVALID", "Operational root must be an absolute local path");
  }
  return path.resolve(value);
}

function validateScheduledContract(environment: NodeJS.ProcessEnv): void {
  if (environment.BACKUP_V2_SCHEDULED_EXECUTION_CONFIRMATION !== CONFIRMATION) {
    fail("BACKUP_V2_OPERATIONAL_CONFIRMATION_REQUIRED", "Scheduled operational confirmation is absent");
  }
  if (environment.BACKUP_V2_PRIMARY_REPRESENTATION !== REPRESENTATION ||
      environment.BACKUP_V2_PRIMARY_RESTORE_STRATEGY !== RESTORE_STRATEGY) {
    fail("BACKUP_V2_OPERATIONAL_STRATEGY_INVALID", "Operational generation requires the qualified Plain SQL strategy");
  }
  if ((environment.BACKUP_V2_RETENTION_MODE ?? "DRY_RUN") !== "DRY_RUN") {
    fail("BACKUP_V2_OPERATIONAL_RETENTION_ACTIVE_NOT_AUTHORIZED", "Destructive retention requires future explicit approval");
  }
}

async function listBucketObjects(transport: BackblazeB2S3Transport, bucket: string): Promise<readonly RemoteObjectEvidence[]> {
  const objects: RemoteObjectEvidence[] = [];
  let continuationToken: string | null = null;
  do {
    const page = await transport.listObjectsV2({
      bucket,
      prefix: "",
      continuationToken,
      maxKeys: 1_000,
      signal: AbortSignal.timeout(60_000),
    });
    objects.push(...page.objects);
    if (objects.length > MAX_REMOTE_OBJECTS) {
      fail("BACKUP_V2_OPERATIONAL_REMOTE_INVENTORY_LIMIT", "B2 inventory exceeded the operational safety limit");
    }
    continuationToken = page.nextContinuationToken;
  } while (continuationToken !== null);
  return Object.freeze(objects);
}

function totalBytes(objects: readonly RemoteObjectEvidence[]): bigint {
  return objects.reduce((sum, object) => sum + object.sizeBytes, BigInt(0));
}

function statusValue(input: Partial<OperationalStatus> & Pick<OperationalStatus,
  "lastAttemptAt" | "lastResult" | "consecutiveFailures" | "successfulScheduledGenerations">): OperationalStatus {
  return Object.freeze({
    schema: "car-zone-backup-v2-operational-status-v1",
    lastAttemptAt: input.lastAttemptAt,
    lastSuccessAt: input.lastSuccessAt ?? null,
    lastRunId: input.lastRunId ?? null,
    lastGenerationId: input.lastGenerationId ?? null,
    lastResult: input.lastResult,
    lastErrorCode: input.lastErrorCode ?? null,
    consecutiveFailures: input.consecutiveFailures,
    successfulScheduledGenerations: input.successfulScheduledGenerations,
    b2UsageBytes: input.b2UsageBytes ?? null,
    nextScheduledRun: nextScheduledRun(),
    retentionMode: input.retentionMode ?? "DRY_RUN",
  });
}

export interface ScheduledOperationalResult {
  readonly result: "PASS";
  readonly runId: string;
  readonly generationId: string;
  readonly remoteObjectsVerified: number;
  readonly componentResults: Readonly<Record<string, string>>;
  readonly componentEvidence: Readonly<Record<string, unknown>>;
  readonly b2UsageBytes: string;
  readonly retentionMode: "DRY_RUN";
  readonly retentionCandidates: number;
  readonly cleanup: "PASS";
  readonly fullRestoreExecuted: false;
  readonly staleLockRecovered: boolean;
  readonly automaticRetryCount: 0 | 1;
}

export async function runScheduledOperationalBackup(environment: NodeJS.ProcessEnv): Promise<ScheduledOperationalResult> {
  validateScheduledContract(environment);
  const root = requiredOperationalRoot(environment);
  const statusPath = path.join(root, "status", "current.json");
  const logPath = path.join(root, "logs", "backup-v2-operational.jsonl");
  const lock = await acquireOperationalLock(path.join(root, "locks", "scheduled.lock"));
  const attemptedAt = new Date().toISOString();
  const previous = await readOperationalStatus(statusPath);
  let config: ReturnType<typeof loadSimplifiedRealConfig> | null = null;
  let sources: SimplifiedBackupSources | null = null;
  try {
    await writeOperationalStatus(statusPath, statusValue({
      ...previous,
      lastAttemptAt: attemptedAt,
      lastResult: "RUNNING",
      consecutiveFailures: previous.consecutiveFailures,
      successfulScheduledGenerations: previous.successfulScheduledGenerations,
    }));
    config = loadSimplifiedRealConfig(environment);
    const transport = createAwsSdkBackblazeB2Transport(config.b2);
    const storageProvider = createBackblazeB2ArtifactStorageProvider({
      config: config.b2,
      transport,
      expectedConfigFingerprint: config.b2.configFingerprint,
      realExecutionAuthorization: simplifiedBackupV2RealStorageAuthorization(),
    });
    const beforeObjects = await listBucketObjects(transport, config.b2.bucket);
    const beforeUsage = totalBytes(beforeObjects);
    planOperationalRetention({
      generations: inventoryOperationalGenerations(beforeObjects),
      successfulScheduledGenerations: previous.successfulScheduledGenerations,
      requestedMode: "DRY_RUN",
    });
    const postgresRunner = createPostgresToolRunner({ mode: "CONTAINER" });
    let run: SimplifiedRunResult;
    let automaticRetryCount: 0 | 1 = 0;
    for (;;) {
      sources = await createProductionBackupSources({
        databaseUrl: config.databaseUrl,
        supabaseUrl: config.supabaseUrl,
        supabaseServiceRoleKey: config.supabaseServiceRoleKey,
        cloudinaryCloudName: config.cloudinaryCloudName,
        cloudinaryApiKey: config.cloudinaryApiKey,
        cloudinaryApiSecret: config.cloudinaryApiSecret,
        postgresRunner,
      });
      const measurements = await sources.measureCanonicalSource();
      const budget = assertOperationalBudget({
        currentUsageBytes: beforeUsage,
        estimatedSourceBytes: sourceBytes(measurements),
        softBudgetBytes: config.b2.softBudgetBytes,
      });
      try {
        run = await runSimplifiedBackup({
          stateParent: config.stateParent,
          sources,
          recoveryKey: config.recoveryKey,
          storageProvider,
          executionMode: "OPERATIONAL_GENERATION",
          remoteSoftBudgetBytes: budget.projectedBytes - beforeUsage,
        });
        sources = null;
        break;
      } catch (error) {
        sources = null;
        const failed = error instanceof SimplifiedBackupRunError ? error.result.report : null;
        if (!failed || !isSafePreUploadSourceDriftRetry(failed, automaticRetryCount)) throw error;
        const remote = await listBucketObjects(transport, config.b2.bucket);
        const failedPrefix = `car-zone/v2-simplified/${failed.runId}/`;
        if (remote.some((object) => object.key.startsWith(failedPrefix))) {
          fail("BACKUP_V2_OPERATIONAL_RETRY_REMOTE_STATE_AMBIGUOUS", "Source-drift retry found unexpected remote state");
        }
        automaticRetryCount = 1;
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
    if (!run.report.backupVerified || run.report.cleanup !== "PASS" ||
        Object.values(run.report.componentResults).some((value) => value !== "PASS")) {
      fail("BACKUP_V2_OPERATIONAL_GENERATION_INCOMPLETE", "Operational generation did not satisfy every required gate");
    }
    const generationId = simplifiedArtifactBinding(run.report.runId);
    const afterObjects = await listBucketObjects(transport, config.b2.bucket);
    const afterUsage = totalBytes(afterObjects);
    const afterGenerations = inventoryOperationalGenerations(afterObjects);
    const created = afterGenerations.find((generation) => generation.generationId === generationId);
    if (!created?.valid || created.objectCount !== 12) {
      fail("BACKUP_V2_OPERATIONAL_REMOTE_GENERATION_INVALID", "Operational generation is not complete in B2");
    }
    const successfulScheduledGenerations = previous.successfulScheduledGenerations + 1;
    const retention = planOperationalRetention({
      generations: afterGenerations,
      successfulScheduledGenerations,
      requestedMode: "DRY_RUN",
    });
    const completedAt = new Date().toISOString();
    const next = statusValue({
      ...previous,
      lastAttemptAt: attemptedAt,
      lastSuccessAt: completedAt,
      lastRunId: run.report.runId,
      lastGenerationId: generationId,
      lastResult: "PASS",
      lastErrorCode: null,
      consecutiveFailures: 0,
      successfulScheduledGenerations,
      b2UsageBytes: afterUsage.toString(),
      retentionMode: retention.mode,
    });
    await writeOperationalStatus(statusPath, next);
    const evidence = run.report.componentEvidence;
    await appendOperationalLog(logPath, {
      schema: "car-zone-backup-v2-operational-log-v1",
      result: "PASS",
      run_id: run.report.runId,
      generation_id: generationId,
      started_at: run.report.startedAt,
      completed_at: run.report.completedAt,
      duration_ms: Date.parse(run.report.completedAt) - Date.parse(run.report.startedAt),
      postgres: run.report.componentResults.database,
      auth: run.report.componentResults.auth,
      storage_metadata: run.report.componentResults.storage_metadata,
      storage_objects: run.report.componentResults.storage_objects,
      external_assets: run.report.componentResults.external_assets,
      postgres_count: evidence.database?.logicalCount ?? "0",
      postgres_plaintext_bytes: evidence.database?.plaintextBytes ?? "0",
      postgres_encrypted_bytes: evidence.database?.encryptedBytes ?? "0",
      auth_count: evidence.auth?.logicalCount ?? "0",
      auth_plaintext_bytes: evidence.auth?.plaintextBytes ?? "0",
      auth_encrypted_bytes: evidence.auth?.encryptedBytes ?? "0",
      storage_metadata_count: evidence.storage_metadata?.logicalCount ?? "0",
      storage_metadata_plaintext_bytes: evidence.storage_metadata?.plaintextBytes ?? "0",
      storage_metadata_encrypted_bytes: evidence.storage_metadata?.encryptedBytes ?? "0",
      storage_objects_count: evidence.storage_objects?.logicalCount ?? "0",
      storage_objects_plaintext_bytes: evidence.storage_objects?.plaintextBytes ?? "0",
      storage_objects_encrypted_bytes: evidence.storage_objects?.encryptedBytes ?? "0",
      external_assets_count: evidence.external_assets?.logicalCount ?? "0",
      external_assets_plaintext_bytes: evidence.external_assets?.plaintextBytes ?? "0",
      external_assets_encrypted_bytes: evidence.external_assets?.encryptedBytes ?? "0",
      manifest: "PASS",
      encryption: "AES_256_GCM_PASS",
      b2_upload: "PASS",
      b2_readback: "PASS",
      remote_objects_verified: run.report.remoteObjectsVerified,
      remote_sha256: "PASS",
      cleanup: run.report.cleanup,
      retention: retention.mode,
      b2_usage_bytes: afterUsage.toString(),
      automatic_retry_count: automaticRetryCount,
    });
    return Object.freeze({
      result: "PASS",
      runId: run.report.runId,
      generationId,
      remoteObjectsVerified: run.report.remoteObjectsVerified,
      componentResults: run.report.componentResults,
      componentEvidence: run.report.componentEvidence,
      b2UsageBytes: afterUsage.toString(),
      retentionMode: "DRY_RUN",
      retentionCandidates: retention.deletionCandidateGenerationIds.length,
      cleanup: "PASS",
      fullRestoreExecuted: false,
      staleLockRecovered: lock.staleRecovered,
      automaticRetryCount,
    });
  } catch (error) {
    const underlying = error instanceof SimplifiedBackupRunError ? error.result.report : null;
    const code = safeCode(error);
    const consecutiveFailures = previous.consecutiveFailures + 1;
    const failed = statusValue({
      ...previous,
      lastAttemptAt: attemptedAt,
      lastRunId: underlying?.runId ?? previous.lastRunId,
      lastResult: "FAIL",
      lastErrorCode: code,
      consecutiveFailures,
      successfulScheduledGenerations: previous.successfulScheduledGenerations,
      retentionMode: "DRY_RUN",
    });
    await writeOperationalStatus(statusPath, failed).catch(() => undefined);
    await appendOperationalLog(logPath, {
      schema: "car-zone-backup-v2-operational-log-v1",
      result: "FAIL",
      run_id: underlying?.runId ?? null,
      error_code: code,
      alert_level: consecutiveFailures >= 3 ? "CRITICAL" : consecutiveFailures === 2 ? "ELEVATED" : "WARNING",
      cleanup: underlying?.cleanup ?? "UNKNOWN",
      retention: "NOT_RUN",
    }).catch(() => undefined);
    throw new BackupV2FailClosedError(code, sanitizeOperationalText("Operational Backup V2 failed; inspect the protected local status"));
  } finally {
    if (sources) await sources.cleanup().catch(() => undefined);
    config?.destroy();
    await lock.release();
  }
}
