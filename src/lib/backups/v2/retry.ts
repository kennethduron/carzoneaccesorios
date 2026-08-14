import { BackupV2FailClosedError } from "./types.ts";

export const BACKUP_V2_FAILURE_REASONS = [
  "database_unavailable", "catalog_changed", "unknown_relation", "export_failed", "encryption_failed",
  "integrity_failed", "runner_capacity", "provider_unavailable", "quota_blocked", "key_metadata_missing",
  "lease_lost", "artifact_conflict", "auth_export_failed", "storage_metadata_export_failed",
  "storage_export_failed", "external_asset_export_failed",
] as const;
export type BackupV2FailureReason = (typeof BACKUP_V2_FAILURE_REASONS)[number];
export type RetryClassification = "retryable" | "terminal" | "manual_review" | "fail_closed";

const CLASSIFICATION: Record<BackupV2FailureReason, RetryClassification> = {
  database_unavailable: "retryable", catalog_changed: "manual_review", unknown_relation: "manual_review",
  export_failed: "retryable", encryption_failed: "terminal", integrity_failed: "fail_closed",
  runner_capacity: "manual_review", provider_unavailable: "retryable", quota_blocked: "manual_review",
  key_metadata_missing: "fail_closed", lease_lost: "retryable", artifact_conflict: "fail_closed",
  auth_export_failed: "retryable", storage_metadata_export_failed: "retryable",
  storage_export_failed: "retryable", external_asset_export_failed: "retryable",
};

export function classifyRetry(value: unknown): RetryClassification {
  if (typeof value !== "string" || !BACKUP_V2_FAILURE_REASONS.includes(value as BackupV2FailureReason)) {
    throw new BackupV2FailClosedError("BACKUP_V2_UNKNOWN_FAILURE_REASON", `Unknown failure reason: ${String(value)}`);
  }
  return CLASSIFICATION[value as BackupV2FailureReason];
}

export function retryRequiresNewLease(value: unknown): boolean {
  return value === "lease_lost" && classifyRetry(value) === "retryable";
}
