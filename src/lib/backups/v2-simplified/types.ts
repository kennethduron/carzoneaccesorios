import "server-only";

import type { ComponentSource } from "../v2/component-payload.ts";
import type { BackupV2StorageProvider } from "../v2/storage-contract.ts";
import type {
  PlainSqlDatabaseExporter,
  PlainSqlRestoreExecutor,
  PlainSqlRestoreTarget,
} from "./plain-sql.ts";

export const SIMPLIFIED_COMPONENTS = ["database", "auth", "storage_metadata", "storage_objects", "external_assets"] as const;
export type SimplifiedComponent = (typeof SIMPLIFIED_COMPONENTS)[number];

export const SIMPLIFIED_RUN_STATUSES = ["PENDING", "RUNNING", "FAILED", "VERIFIED", "RECOVERABILITY_PROVEN"] as const;
export type SimplifiedRunStatus = (typeof SIMPLIFIED_RUN_STATUSES)[number];

export type SimplifiedStage =
  | "CONFIG_VALIDATION" | "SOURCE_PREFLIGHT" | "DATABASE_EXPORT" | "AUTH_EXPORT"
  | "STORAGE_METADATA_EXPORT" | "STORAGE_OBJECTS_EXPORT" | "EXTERNAL_ASSETS_EXPORT"
  | "MANIFEST" | "LOCAL_INTEGRITY" | "ENCRYPTION" | "B2_UPLOAD" | "B2_REMOTE_VERIFY"
  | "B2_DOWNLOAD" | "REMOTE_SHA256" | "ISOLATED_RESTORE" | "RECOVERY_VERIFICATION"
  | "TEMP_CLEANUP" | "COMPLETE";

export interface SimplifiedSourceMeasurements {
  readonly databaseBytes: bigint; readonly databaseObjects: bigint;
  readonly authBytes: bigint; readonly authObjects: bigint;
  readonly storageMetadataBytes: bigint; readonly storageMetadataObjects: bigint;
  readonly storageObjectBytes: bigint; readonly storageObjects: bigint;
  readonly externalAssetBytes: bigint; readonly externalAssets: bigint;
}

export interface SimplifiedBackupSources {
  readonly database: PlainSqlDatabaseExporter;
  readonly auth: ComponentSource;
  readonly storageMetadata: ComponentSource;
  readonly storageObjects: ComponentSource;
  readonly externalAssets: ComponentSource;
  readonly mutationMethods: readonly [];
  measureCanonicalSource(): Promise<SimplifiedSourceMeasurements>;
  cleanup(): Promise<void>;
}

export interface SimplifiedRestoreProvision {
  readonly target: PlainSqlRestoreTarget;
  readonly executor: PlainSqlRestoreExecutor;
  verifyDatabase(): Promise<Readonly<Record<string, string | number | boolean>>>;
  cleanup(): Promise<void>;
}

export interface SimplifiedArtifactDescriptor {
  readonly component: SimplifiedComponent | "backup_manifest" | "backup_index";
  readonly kind: "encrypted_payload" | "manifest_sidecar" | "encrypted_manifest" | "index";
  readonly localPath: string; readonly objectKey: string; readonly bytes: bigint;
  readonly sha256: string; readonly artifactId: string;
}

export interface SimplifiedComponentManifestEntry {
  readonly component: SimplifiedComponent; readonly artifact_id: string;
  readonly artifact_object_key: string; readonly artifact_bytes: string; readonly artifact_sha256: string;
  readonly manifest_object_key: string; readonly manifest_bytes: string; readonly manifest_sha256: string;
  readonly plaintext_bytes: string; readonly plaintext_sha256: string; readonly logical_count: string;
  readonly format_version: string; readonly encryption_envelope: "car-zone-aesgcm-envelope-v1";
  readonly representation: string;
  readonly plaintext_filename: string | null;
  readonly restore_strategy: string;
  readonly postgres_major: 17 | null;
}

export interface SimplifiedBackupManifestBody {
  readonly schema: "car-zone-backup-v2-simplified-manifest-v1";
  readonly application: "car-zone-accesorios"; readonly run_id: string; readonly created_at: string;
  readonly local_artifact_binding: string; readonly remote_prefix: string;
  readonly components: readonly SimplifiedComponentManifestEntry[];
  readonly production_source_access: "READ_ONLY"; readonly production_mutations: 0;
  readonly independent_secondary_present: false; readonly full_dr_ready: false;
}

export interface SimplifiedBackupManifest extends SimplifiedBackupManifestBody {
  readonly integrity: { readonly manifest_sha256: string };
}

export interface SimplifiedBackupIndex {
  readonly schema: "car-zone-backup-v2-simplified-index-v1";
  readonly run_id: string; readonly created_at: string; readonly manifest_object_key: string;
  readonly manifest_encrypted_bytes: string; readonly manifest_encrypted_sha256: string;
  readonly manifest_plaintext_bytes: string; readonly manifest_plaintext_sha256: string;
  readonly manifest_compressed_bytes: string; readonly manifest_compressed_sha256: string;
  readonly encryption: { readonly algorithm: "aes-256-gcm"; readonly envelope: "car-zone-aesgcm-envelope-v1";
    readonly nonce_base64: string; readonly auth_tag_base64: string; readonly aad_sha256: string };
  readonly integrity: { readonly index_sha256: string };
}

export interface SimplifiedComponentResult {
  readonly component: SimplifiedComponent; readonly artifactId: string;
  readonly artifactPath: string; readonly manifestPath: string;
  readonly artifactBytes: bigint; readonly artifactSha256: string;
  readonly manifestBytes: bigint; readonly manifestSha256: string;
  readonly plaintextBytes: bigint; readonly plaintextSha256: string;
  readonly logicalCount: bigint; readonly formatVersion: string;
  readonly representation: string;
  readonly plaintextFilename: string | null;
  readonly restoreStrategy: string;
  readonly postgresMajor: 17 | null;
}

export interface SimplifiedFinalReport {
  readonly schema: "car-zone-backup-v2-simplified-report-v1";
  readonly backupV2Simplified: "FAILED" | "RECOVERABILITY_PROVEN";
  readonly runId: string; readonly startedAt: string; readonly completedAt: string;
  readonly status: SimplifiedRunStatus; readonly failedStage: SimplifiedStage | null;
  readonly code: string | null; readonly retryability: "TRANSIENT" | "NON_RETRYABLE" | "UNKNOWN" | null;
  readonly subprocess: "pg_dump" | "pg_restore" | "psql" | "docker" | null;
  readonly systemCode: string | null;
  readonly subprocessExitCode: number | null;
  readonly subprocessSignalClass: string | null;
  readonly stderrClass: string | null;
  readonly stdinClosed: boolean | null;
  readonly childExitedBeforeWrite: boolean | null;
  readonly productionMutation: "NONE";
  readonly componentResults: Readonly<Record<SimplifiedComponent, "PASS" | "FAIL" | "NOT_RUN">>;
  readonly componentEvidence: Readonly<Record<SimplifiedComponent, {
    readonly logicalCount: string;
    readonly plaintextBytes: string;
    readonly encryptedBytes: string;
    readonly encryptedSha256: string;
    readonly remoteVerified: boolean;
    readonly restoreVerified: boolean;
  } | null>>;
  readonly remoteObjectsVerified: number;
  readonly backupVerified: boolean; readonly recoverabilityProven: boolean;
  readonly independentSecondaryPresent: false; readonly fullDrReady: false;
  readonly cleanup: "PASS" | "FAIL"; readonly safeDiagnostics: readonly string[];
}

export interface RunSimplifiedBackupInput {
  readonly stateParent: string; readonly sources: SimplifiedBackupSources;
  readonly recoveryKey: Uint8Array; readonly storageProvider: BackupV2StorageProvider;
  readonly restore: () => Promise<SimplifiedRestoreProvision>;
  readonly sourceDatabaseUrl?: string;
  readonly clock?: () => string; readonly randomUuid?: () => string;
  readonly availableDiskBytes?: (pathValue: string) => Promise<bigint>;
  readonly minimumDiskSafetyMarginBytes?: bigint; readonly remoteMaxAttempts?: number;
  readonly remoteSoftBudgetBytes?: bigint;
  readonly remoteRetryBaseDelayMs?: number;
  readonly stageHook?: (stage: SimplifiedStage) => void | Promise<void>;
}

export interface SimplifiedRunResult {
  readonly stateRoot: string; readonly reportPath: string; readonly report: SimplifiedFinalReport;
}
