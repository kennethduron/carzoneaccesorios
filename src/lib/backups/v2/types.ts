export const BACKUP_V2_SCOPES = ["database", "auth", "storage_objects"] as const;
export type BackupV2Scope = (typeof BACKUP_V2_SCOPES)[number];

export const BACKUP_V2_STATES = [
  "requested", "preflight", "running", "validating", "completed",
  "completed_with_warnings", "failed", "cancelled",
] as const;
export type BackupV2State = (typeof BACKUP_V2_STATES)[number];

export const BACKUP_V2_TERMINAL_STATES = [
  "completed", "completed_with_warnings", "failed", "cancelled",
] as const satisfies readonly BackupV2State[];
export type BackupV2TerminalState = (typeof BACKUP_V2_TERMINAL_STATES)[number];
export type BackupV2Trigger = "manual" | "scheduled" | "system";
export type RetryMode = "same_artifact_operation" | "fresh_backup_attempt";

export const RECOVERY_SET_STATES = ["assembling", "full_dr_ready", "failed", "expired"] as const;
export type RecoverySetState = (typeof RECOVERY_SET_STATES)[number];
export const RECOVERY_EVIDENCE_ORIGINS = ["runtime_verified", "synthetic_fixture"] as const;
export type RecoveryEvidenceOrigin = (typeof RECOVERY_EVIDENCE_ORIGINS)[number];
export const RECOVERY_EVIDENCE_ORIGIN_CAPABILITIES = {
  runtime_verified: { runtimeFullDrReady: true, syntheticTestEvaluation: true },
  synthetic_fixture: { runtimeFullDrReady: false, syntheticTestEvaluation: true },
} as const satisfies Record<RecoveryEvidenceOrigin, {
  runtimeFullDrReady: boolean;
  syntheticTestEvaluation: boolean;
}>;
export type RecoveryRequirement = "required" | "optional";
export type EvidencePresence = "present" | "missing" | "unknown";
export type CompletionEvidence = "completed" | "incomplete" | "failed" | "unknown";
export type VerificationEvidence = "verified" | "unverified" | "failed" | "unknown";
export type CopyKind = "primary" | "independent_offsite";

export interface RecoveryCopyRequirement {
  kind: CopyKind;
  requirement: RecoveryRequirement;
}

export interface RecoverySetComponentRequirement {
  scope: BackupV2Scope;
  requirement: RecoveryRequirement;
  copies: readonly RecoveryCopyRequirement[];
}

export interface RecoverySetPolicy {
  policyVersion: string;
  components: readonly RecoverySetComponentRequirement[];
  recoveryKeyRequirement: RecoveryRequirement;
  maxEvidenceAgeMs: number | null;
}

export interface CompatibilityEvidence {
  status: VerificationEvidence;
  backupFormatVersion: string | null;
  schemaCompatibilityRef: string | null;
  exporterVersion: string | null;
  verifiedAt: string | null;
}

export interface RecoveryCopyEvidence {
  kind: CopyKind;
  status: VerificationEvidence;
  verifiedAt: string | null;
  providerNeutralRef: string | null;
}

export interface RecoverySetComponent {
  scope: BackupV2Scope;
  artifact: EvidencePresence;
  completion: CompletionEvidence;
  integrity: VerificationEvidence;
  compatibility: CompatibilityEvidence;
  copies: readonly RecoveryCopyEvidence[];
  failClosedReasons: readonly string[];
  evidenceOrigin: RecoveryEvidenceOrigin;
}

export interface RecoveryKeyEvidence {
  status: "availability_attested" | "unattested" | "failed" | "unknown";
  keyVersion: string | null;
  safeReference: string | null;
  publicFingerprint: string | null;
  attestedAt: string | null;
}

export const RECOVERY_EVALUATION_ENVIRONMENTS = ["runtime", "synthetic_test"] as const;
export type RecoveryEvaluationEnvironment = (typeof RECOVERY_EVALUATION_ENVIRONMENTS)[number];
export interface RecoverySetEvaluationInput {
  policy: RecoverySetPolicy;
  components: readonly RecoverySetComponent[];
  recoveryKey: RecoveryKeyEvidence | null;
  environment?: RecoveryEvaluationEnvironment;
  evaluatedAt: string;
}
export interface RecoverySetEvaluation {
  state: "assembling" | "full_dr_ready";
  fullDrReady: boolean;
  missingScopes: readonly BackupV2Scope[];
  blockingReasons: readonly string[];
}

export const MEASUREMENT_SCOPES = [
  ...BACKUP_V2_SCOPES, "full_recovery_set", "runtime",
] as const;
export type MeasurementScope = (typeof MEASUREMENT_SCOPES)[number];

export interface BackupV2Measurement {
  scope: MeasurementScope;
  source: "synthetic_local";
  measuredAt: string;
  encryptedBytes: number;
  temporaryPeakBytes: number;
  objectCount: number;
  operationCount: number;
  runtimeSeconds: number;
  githubActionsMinutes: number;
}

export interface MeasurementFreshnessPolicy {
  now: string;
  maxMeasurementAgeMs: number;
}

export class BackupV2FailClosedError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BackupV2FailClosedError";
    this.code = code;
  }
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

export function isRecoveryEvidenceOrigin(value: unknown): value is RecoveryEvidenceOrigin {
  return isOneOf(value, RECOVERY_EVIDENCE_ORIGINS);
}

export function requireRecoveryEvaluationEnvironment(value: unknown): RecoveryEvaluationEnvironment {
  if (!isOneOf(value, RECOVERY_EVALUATION_ENVIRONMENTS)) {
    throw new BackupV2FailClosedError(
      "BACKUP_V2_UNKNOWN_RECOVERY_ENVIRONMENT", `Rejected recovery environment: ${String(value)}`,
    );
  }
  return value;
}

export function requireBackupV2Scope(value: unknown): BackupV2Scope {
  if (!isOneOf(value, BACKUP_V2_SCOPES)) {
    throw new BackupV2FailClosedError("BACKUP_V2_UNKNOWN_SCOPE", `Rejected unknown scope: ${String(value)}`);
  }
  return value;
}

export function requireBackupV2State(value: unknown): BackupV2State {
  if (!isOneOf(value, BACKUP_V2_STATES)) {
    throw new BackupV2FailClosedError("BACKUP_V2_UNKNOWN_STATE", `Rejected unknown state: ${String(value)}`);
  }
  return value;
}

export function requireMeasurementScope(value: unknown): MeasurementScope {
  if (!isOneOf(value, MEASUREMENT_SCOPES)) {
    throw new BackupV2FailClosedError(
      "BACKUP_V2_UNKNOWN_MEASUREMENT_SCOPE", `Rejected unknown measurement scope: ${String(value)}`,
    );
  }
  return value;
}
