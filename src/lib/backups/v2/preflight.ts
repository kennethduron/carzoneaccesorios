import { catalogFingerprint, type CatalogSnapshot } from "./catalog.ts";
import { requireSafetyCriticalMeasurement, validateRuntimeMeasurement } from "./measurement.ts";
import {
  BackupV2FailClosedError, type BackupV2Measurement, type MeasurementFreshnessPolicy, type MeasurementScope,
} from "./types.ts";

export const PREFLIGHT_OUTCOMES = ["go", "blocked", "review_required"] as const;
export type PreflightOutcome = (typeof PREFLIGHT_OUTCOMES)[number];
export const PREFLIGHT_REASONS = [
  "catalog_review_required", "unknown_relation", "catalog_changed", "measurement_missing",
  "measurement_exact_required", "measurement_stale", "quota_unknown", "active_run_exists",
  "lease_unavailable", "key_metadata_missing", "required_component_configuration_missing",
  "unsafe_numeric_evidence",
] as const;
export type PreflightReason = (typeof PREFLIGHT_REASONS)[number];
export interface PreflightFinding { reason: PreflightReason; detail: string; }
export interface PreflightEvaluation { outcome: PreflightOutcome; reasons: readonly PreflightFinding[]; }

export interface CanonicalPreflightInput {
  catalog: CatalogSnapshot;
  findings?: readonly PreflightFinding[];
  measurements?: readonly BackupV2Measurement[];
  requiredMeasurementScopes?: readonly MeasurementScope[];
  measurementPolicy?: MeasurementFreshnessPolicy;
}

const REVIEW_REASONS = new Set<PreflightReason>(["catalog_review_required", "unknown_relation", "catalog_changed"]);

function validateFinding(finding: PreflightFinding): void {
  if (!PREFLIGHT_REASONS.includes(finding.reason) || finding.detail.trim().length === 0) {
    throw new BackupV2FailClosedError("BACKUP_V2_UNKNOWN_PREFLIGHT_REASON", "Invalid preflight finding");
  }
}

function evaluateFindings(findings: readonly PreflightFinding[]): PreflightEvaluation {
  for (const finding of findings) validateFinding(finding);
  const hasBlocked = findings.some(({ reason }) => !REVIEW_REASONS.has(reason));
  if (hasBlocked) return { outcome: "blocked", reasons: findings };
  if (findings.length) return { outcome: "review_required", reasons: findings };
  return { outcome: "go", reasons: [] };
}

/**
 * Pure mirror of the database preflight contract. It never accepts a caller-approved catalog:
 * every catalog entry is revalidated and review-required entries become findings automatically.
 * PostgreSQL remains the authority that discovers, persists, binds, and accepts a run snapshot.
 */
export function evaluatePreflight(input: CanonicalPreflightInput): PreflightEvaluation {
  if (catalogFingerprint(input.catalog.entries) !== input.catalog.fingerprint) {
    throw new BackupV2FailClosedError("BACKUP_V2_CATALOG_CHANGED", "Catalog fingerprint is not canonical");
  }
  const findings: PreflightFinding[] = [...(input.findings ?? [])];
  for (const entry of input.catalog.entries) {
    if (entry.classification === "review_required") {
      findings.push({
        reason: entry.relationKind === "unknown" ? "unknown_relation" : "catalog_review_required",
        detail: `${entry.schemaName}.${entry.relationName}`,
      });
    }
  }

  const measurements = input.measurements ?? [];
  const requiredScopes = [...new Set(input.requiredMeasurementScopes ?? [])];
  for (const scope of requiredScopes) {
    const matches = measurements.filter((measurement) => measurement.scope === scope);
    if (matches.length !== 1 || !input.measurementPolicy) {
      findings.push({ reason: "measurement_missing", detail: `${scope} requires one verified measurement` });
      continue;
    }
    try {
      validateRuntimeMeasurement(matches[0], input.measurementPolicy);
      requireSafetyCriticalMeasurement(matches[0]);
    } catch (error) {
      const reason = error instanceof BackupV2FailClosedError && error.code === "BACKUP_V2_STALE_MEASUREMENT"
        ? "measurement_stale" : "measurement_exact_required";
      findings.push({ reason, detail: `${scope} lacks current measured runtime evidence` });
    }
  }
  return evaluateFindings(findings);
}
