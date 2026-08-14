import {
  BackupV2FailClosedError, type BackupV2Measurement, type MeasurementScope,
  type MeasurementFreshnessPolicy, requireMeasurementScope,
} from "./types.ts";

const NON_NEGATIVE_INTEGER_FIELDS = [
  "encryptedBytes", "temporaryPeakBytes", "objectCount", "operationCount",
] as const satisfies readonly (keyof BackupV2Measurement)[];
const NON_NEGATIVE_FINITE_FIELDS = [
  "runtimeSeconds", "githubActionsMinutes",
] as const satisfies readonly (keyof BackupV2Measurement)[];

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
    "database", "auth", "storage_objects", "full_recovery_set", "runtime",
  ];
  const missing = required.filter((scope) => !byScope.has(scope));
  if (missing.length) {
    throw new BackupV2FailClosedError(
      "BACKUP_V2_MEASUREMENT_GATE_INCOMPLETE", `Measurement gate is missing: ${missing.join(", ")}`,
    );
  }
}
