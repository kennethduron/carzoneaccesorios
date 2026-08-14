import {
  BackupV2FailClosedError, type BackupV2Measurement, type MeasurementScope,
  type MeasurementFreshnessPolicy, MEASUREMENT_QUALITIES, type MeasurementQuality,
  requireMeasurementScope,
} from "./types.ts";

const NON_NEGATIVE_INTEGER_FIELDS = [
  "encryptedBytes", "temporaryPeakBytes", "objectCount", "operationCount",
] as const satisfies readonly (keyof BackupV2Measurement)[];
const NON_NEGATIVE_FINITE_FIELDS = [
  "runtimeSeconds", "githubActionsMinutes",
] as const satisfies readonly (keyof BackupV2Measurement)[];
const OPTIONAL_EXACT_BYTE_FIELDS = [
  "databaseTotalBytes", "tableBytes", "indexBytes", "estimatedLogicalBytes",
  "observedArtifactBytes", "storageMetadataBytes", "storageObjectBytes", "externalAssetBytes",
  "runnerTempDiskAvailableBytes", "providerQuotaBytes",
] as const satisfies readonly (keyof BackupV2Measurement)[];
const CANONICAL_DECIMAL_INTEGER = /^(0|[1-9][0-9]*)$/;

export function parseExactByteQuantity(value: unknown, fieldName = "bytes"): bigint {
  if (typeof value === "bigint" && value >= BigInt(0)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && CANONICAL_DECIMAL_INTEGER.test(value)) return BigInt(value);
  throw new BackupV2FailClosedError(
    "BACKUP_V2_UNSAFE_NUMERIC_EVIDENCE", `${fieldName} must be an exact non-negative integer`,
  );
}

export function serializeExactByteQuantity(value: unknown, fieldName = "bytes"): string {
  return parseExactByteQuantity(value, fieldName).toString(10);
}

export function requireMeasurementQuality(value: unknown): MeasurementQuality {
  if (typeof value !== "string" || !MEASUREMENT_QUALITIES.includes(value as MeasurementQuality)) {
    throw new BackupV2FailClosedError(
      "BACKUP_V2_UNKNOWN_MEASUREMENT_QUALITY", `Rejected measurement quality: ${String(value)}`,
    );
  }
  return value as MeasurementQuality;
}

export function requireSafetyCriticalMeasurement(value: BackupV2Measurement): void {
  if (requireMeasurementQuality(value.quality ?? "unknown") !== "measured") {
    throw new BackupV2FailClosedError(
      "BACKUP_V2_EXACT_MEASUREMENT_REQUIRED", "Safety-critical decisions require measured evidence",
    );
  }
}

function requireFreshnessPolicy(policy: MeasurementFreshnessPolicy): { nowMs: number; maxAgeMs: number } {
  const nowMs = Date.parse(policy.now);
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(policy.maxMeasurementAgeMs) ||
      policy.maxMeasurementAgeMs <= 0) {
    throw new BackupV2FailClosedError(
      "BACKUP_V2_INVALID_MEASUREMENT_FRESHNESS_POLICY",
      "Measurement clock and maximum age must be finite and valid",
    );
  }
  return { nowMs, maxAgeMs: policy.maxMeasurementAgeMs };
}

export function validateSyntheticMeasurement(
  value: BackupV2Measurement,
  policy: MeasurementFreshnessPolicy,
): BackupV2Measurement {
  requireMeasurementScope(value.scope);
  if (value.source !== "synthetic_local") {
    throw new BackupV2FailClosedError(
      "BACKUP_V2_NON_SYNTHETIC_MEASUREMENT_REJECTED", "Phase 4A accepts synthetic/local measurements only",
    );
  }
  const measuredAtMs = Date.parse(value.measuredAt);
  if (!Number.isSafeInteger(measuredAtMs)) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_MEASUREMENT_TIME", "Invalid measurement timestamp");
  }
  const { nowMs, maxAgeMs } = requireFreshnessPolicy(policy);
  if (measuredAtMs > nowMs) {
    throw new BackupV2FailClosedError("BACKUP_V2_FUTURE_MEASUREMENT", "Future measurement rejected");
  }
  const measurementAgeMs = nowMs - measuredAtMs;
  if (!Number.isSafeInteger(measurementAgeMs) || measurementAgeMs > maxAgeMs) {
    throw new BackupV2FailClosedError("BACKUP_V2_STALE_MEASUREMENT", "Stale measurement rejected");
  }
  for (const field of NON_NEGATIVE_INTEGER_FIELDS) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "number" || !Number.isSafeInteger(fieldValue) || fieldValue < 0) {
      throw new BackupV2FailClosedError(
        "BACKUP_V2_INVALID_MEASUREMENT_VALUE", `${field} must be a safe non-negative integer`,
      );
    }
  }
  for (const field of NON_NEGATIVE_FINITE_FIELDS) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0) {
      throw new BackupV2FailClosedError(
        "BACKUP_V2_INVALID_MEASUREMENT_VALUE", `${field} must be a finite non-negative number`,
      );
    }
  }
  return value;
}

export function validateRuntimeMeasurement(
  value: BackupV2Measurement,
  policy: MeasurementFreshnessPolicy,
): BackupV2Measurement {
  requireMeasurementScope(value.scope);
  if (value.source !== "runtime_verified") {
    throw new BackupV2FailClosedError(
      "BACKUP_V2_RUNTIME_MEASUREMENT_REQUIRED", "Runtime sizing requires runtime-verified evidence",
    );
  }
  requireMeasurementQuality(value.quality ?? "unknown");
  const measuredAtMs = Date.parse(value.measuredAt);
  const { nowMs, maxAgeMs } = requireFreshnessPolicy(policy);
  if (!Number.isSafeInteger(measuredAtMs)) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_MEASUREMENT_TIME", "Invalid measurement timestamp");
  }
  if (measuredAtMs > nowMs) {
    throw new BackupV2FailClosedError("BACKUP_V2_FUTURE_MEASUREMENT", "Future measurement rejected");
  }
  if (!Number.isSafeInteger(nowMs - measuredAtMs) || nowMs - measuredAtMs > maxAgeMs) {
    throw new BackupV2FailClosedError("BACKUP_V2_STALE_MEASUREMENT", "Stale measurement rejected");
  }
  parseExactByteQuantity(value.encryptedBytes, "encryptedBytes");
  parseExactByteQuantity(value.temporaryPeakBytes, "temporaryPeakBytes");
  for (const field of OPTIONAL_EXACT_BYTE_FIELDS) {
    const fieldValue = value[field];
    if (fieldValue !== null && fieldValue !== undefined) parseExactByteQuantity(fieldValue, field);
  }
  for (const field of ["objectCount", "operationCount"] as const) {
    if (!Number.isSafeInteger(value[field]) || value[field] < 0) {
      throw new BackupV2FailClosedError(
        "BACKUP_V2_INVALID_MEASUREMENT_VALUE", `${field} must be a safe non-negative integer`,
      );
    }
  }
  for (const field of NON_NEGATIVE_FINITE_FIELDS) {
    const fieldValue = value[field];
    if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue) || fieldValue < 0) {
      throw new BackupV2FailClosedError(
        "BACKUP_V2_INVALID_MEASUREMENT_VALUE", `${field} must be a finite non-negative number`,
      );
    }
  }
  return value;
}

export function measurementsByScope(
  values: readonly BackupV2Measurement[],
  policy: MeasurementFreshnessPolicy,
): ReadonlyMap<MeasurementScope, BackupV2Measurement> {
  const result = new Map<MeasurementScope, BackupV2Measurement>();
  for (const raw of values) {
    const measurement = validateSyntheticMeasurement(raw, policy);
    if (result.has(measurement.scope)) {
      throw new BackupV2FailClosedError(
        "BACKUP_V2_DUPLICATE_MEASUREMENT_SCOPE", `Duplicate measurement scope ${measurement.scope}`,
      );
    }
    result.set(measurement.scope, measurement);
  }
  return result;
}

export function requireMeasurementGateScopes(
  values: readonly BackupV2Measurement[],
  policy: MeasurementFreshnessPolicy,
): void {
  const byScope = measurementsByScope(values, policy);
  const required: readonly MeasurementScope[] = [
    "database", "auth", "storage_metadata", "storage_objects", "external_assets",
    "full_recovery_set", "runtime",
  ];
  const missing = required.filter((scope) => !byScope.has(scope));
  if (missing.length) {
    throw new BackupV2FailClosedError(
      "BACKUP_V2_MEASUREMENT_GATE_INCOMPLETE", `Measurement gate is missing: ${missing.join(", ")}`,
    );
  }
}
