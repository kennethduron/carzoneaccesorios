export const ZERO_SPEND_WARNING_RATIO = 0.7;
export const ZERO_SPEND_CRITICAL_RATIO = 0.8;
export const ZERO_SPEND_BLOCK_RATIO = 0.9;
export type ZeroSpendState = "normal" | "warning" | "critical_capacity" | "blocked_budget";
export type ExactByteQuantity = number | bigint | string;

export interface ZeroSpendDimension {
  name: string;
  quota: ExactByteQuantity | null;
  used: ExactByteQuantity | null;
  projectedNextOperation: ExactByteQuantity | null;
  measuredAt: string | null;
  requiredProviderDataAvailable: boolean;
}
export interface ZeroSpendEvaluationInput {
  dimensions: readonly ZeroSpendDimension[];
  now: string;
  maxMeasurementAgeMs: number;
}
export interface ZeroSpendEvaluation {
  state: ZeroSpendState;
  ownerDecisionRequired: boolean;
  automaticDeletionAllowed: false;
  reasons: readonly string[];
  maximumCurrentRatio: number | null;
  maximumProjectedRatio: number | null;
}

export const PROTECTED_ARTIFACT_REASONS = [
  "latest_verified_database", "latest_full_dr_ready", "latest_restore_verified",
  "required_previous_verified_generation", "legal_or_incident_hold",
  "incremental_dependency", "requires_historical_key_version",
] as const;
export type ProtectedArtifactReason = (typeof PROTECTED_ARTIFACT_REASONS)[number];
export interface RetainedArtifact { id: string; protectedReasons: readonly ProtectedArtifactReason[]; }

const CANONICAL_INTEGER = /^(0|[1-9][0-9]*)$/;
const RATIO_DISPLAY_SCALE = BigInt(1_000_000);

function normalizeExactByteQuantity(value: ExactByteQuantity | null): bigint | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === "bigint") return value >= BigInt(0) ? value : null;
  if (typeof value === "string" && CANONICAL_INTEGER.test(value)) return BigInt(value);
  return null;
}

function isAtLeastPercent(value: bigint, quota: bigint, percent: 70 | 80 | 90): boolean {
  return value * BigInt(100) >= quota * BigInt(percent);
}

function diagnosticRatio(value: bigint, quota: bigint): number {
  const scaled = value * RATIO_DISPLAY_SCALE / quota;
  const capped = scaled > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : scaled;
  return Number(capped) / Number(RATIO_DISPLAY_SCALE);
}

export function evaluateZeroSpend(input: ZeroSpendEvaluationInput): ZeroSpendEvaluation {
  const reasons: string[] = [];
  const currentRatios: number[] = [];
  const projectedRatios: number[] = [];
  const nowMs = Date.parse(input.now);
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(input.maxMeasurementAgeMs) ||
      input.maxMeasurementAgeMs <= 0) reasons.push("invalid_clock_or_measurement_age");
  if (input.dimensions.length === 0) reasons.push("required_provider_data_unavailable");
  const names = new Set<string>();
  let highestHealthyState: Exclude<ZeroSpendState, "blocked_budget"> = "normal";
  for (const dimension of input.dimensions) {
    if (typeof dimension.name !== "string" || dimension.name.trim().length === 0 || names.has(dimension.name)) {
      reasons.push("invalid_or_duplicate_dimension_name");
      continue;
    }
    names.add(dimension.name);
    if (!dimension.requiredProviderDataAvailable) {
      reasons.push(`${dimension.name}:required_provider_data_unavailable`);
      continue;
    }
    const quota = normalizeExactByteQuantity(dimension.quota);
    const used = normalizeExactByteQuantity(dimension.used);
    const projectedNextOperation = normalizeExactByteQuantity(dimension.projectedNextOperation);
    if (quota === null || quota === BigInt(0) || used === null || projectedNextOperation === null) {
      reasons.push(`${dimension.name}:quota_or_usage_unknown`);
      continue;
    }
    const measuredAtMs = dimension.measuredAt === null ? Number.NaN : Date.parse(dimension.measuredAt);
    if (!Number.isSafeInteger(measuredAtMs) || !Number.isSafeInteger(nowMs)) {
      reasons.push(`${dimension.name}:measurement_invalid`);
      continue;
    }
    if (measuredAtMs > nowMs) {
      reasons.push(`${dimension.name}:measurement_future`);
      continue;
    }
    const measurementAgeMs = nowMs - measuredAtMs;
    if (!Number.isSafeInteger(input.maxMeasurementAgeMs) || input.maxMeasurementAgeMs <= 0 ||
        !Number.isSafeInteger(measurementAgeMs) || measurementAgeMs > input.maxMeasurementAgeMs) {
      reasons.push(`${dimension.name}:measurement_stale`);
      continue;
    }
    const projectedTotal = used + projectedNextOperation;
    currentRatios.push(diagnosticRatio(used, quota));
    projectedRatios.push(diagnosticRatio(projectedTotal, quota));
    if (isAtLeastPercent(used, quota, 90)) {
      reasons.push(`${dimension.name}:current_usage_at_or_above_budget_threshold`);
    }
    if (isAtLeastPercent(projectedTotal, quota, 90)) {
      reasons.push(`${dimension.name}:next_operation_may_exceed_budget_threshold`);
    }
    if (isAtLeastPercent(used, quota, 80)) highestHealthyState = "critical_capacity";
    else if (highestHealthyState === "normal" && isAtLeastPercent(used, quota, 70)) {
      highestHealthyState = "warning";
    }
  }
  const maximumCurrentRatio = currentRatios.length ? Math.max(...currentRatios) : null;
  const maximumProjectedRatio = projectedRatios.length ? Math.max(...projectedRatios) : null;
  if (reasons.length) return {
    state: "blocked_budget", ownerDecisionRequired: true, automaticDeletionAllowed: false,
    reasons, maximumCurrentRatio, maximumProjectedRatio,
  };
  return {
    state: highestHealthyState, ownerDecisionRequired: false, automaticDeletionAllowed: false, reasons: [],
    maximumCurrentRatio, maximumProjectedRatio,
  };
}

export function automaticCapacityDeletionPlan(
  artifacts: readonly RetainedArtifact[],
): { candidates: readonly never[]; ownerDecisionRequired: true; protectedArtifactIds: readonly string[] } {
  return {
    candidates: [], ownerDecisionRequired: true,
    protectedArtifactIds: artifacts.filter((item) => item.protectedReasons.length > 0).map((item) => item.id),
  };
}
