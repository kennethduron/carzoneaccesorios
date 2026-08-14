import {
  BACKUP_V2_SCOPES, RECOVERY_EVIDENCE_ORIGIN_CAPABILITIES, BackupV2FailClosedError,
  type BackupV2Scope,
  type CompatibilityEvidence, type CopyKind, type RecoveryCopyEvidence,
  type RecoveryEvaluationEnvironment, type RecoveryKeyEvidence,
  type RecoverySetComponent, type RecoverySetEvaluation, type RecoverySetEvaluationInput,
  type RecoverySetPolicy, isRecoveryEvidenceOrigin, requireBackupV2Scope,
  requireRecoveryEvaluationEnvironment,
} from "./types.ts";

const COPY_KINDS: readonly CopyKind[] = ["primary", "independent_offsite"];
const REQUIREMENTS = ["required", "optional"] as const;

function requireNonEmpty(value: string | null, reason: string, blockers: string[]): void {
  if (value === null || value.trim().length === 0) blockers.push(reason);
}

function evidenceTimeBlocker(
  value: string | null,
  evaluatedAtMs: number,
  maxEvidenceAgeMs: number | null,
  reasonPrefix: string,
): string | null {
  if (value === null) return `${reasonPrefix}:verification_time_missing`;
  const evidenceMs = Date.parse(value);
  if (!Number.isFinite(evidenceMs)) return `${reasonPrefix}:verification_time_invalid`;
  if (evidenceMs > evaluatedAtMs) return `${reasonPrefix}:verification_time_future`;
  if (maxEvidenceAgeMs !== null && evaluatedAtMs - evidenceMs > maxEvidenceAgeMs) {
    return `${reasonPrefix}:verification_stale`;
  }
  return null;
}

function validatePolicy(policy: RecoverySetPolicy): Map<BackupV2Scope, RecoverySetPolicy["components"][number]> {
  if (policy.policyVersion.trim().length === 0) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_RECOVERY_POLICY", "Policy version is required");
  }
  if (!REQUIREMENTS.includes(policy.recoveryKeyRequirement)) {
    throw new BackupV2FailClosedError("BACKUP_V2_UNKNOWN_REQUIREMENT", "Unknown recovery-key requirement");
  }
  if (policy.maxEvidenceAgeMs !== null &&
      (!Number.isFinite(policy.maxEvidenceAgeMs) || policy.maxEvidenceAgeMs <= 0)) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_EVIDENCE_AGE", "Evidence age must be finite and positive");
  }
  const requirements = new Map<BackupV2Scope, RecoverySetPolicy["components"][number]>();
  for (const component of policy.components) {
    const scope = requireBackupV2Scope(component.scope);
    if (!REQUIREMENTS.includes(component.requirement)) {
      throw new BackupV2FailClosedError("BACKUP_V2_UNKNOWN_REQUIREMENT", `Unknown requirement for ${scope}`);
    }
    if (requirements.has(scope)) {
      throw new BackupV2FailClosedError("BACKUP_V2_DUPLICATE_REQUIREMENT", `Duplicate requirement for ${scope}`);
    }
    const copyKinds = new Set<CopyKind>();
    for (const copy of component.copies) {
      if (!COPY_KINDS.includes(copy.kind)) {
        throw new BackupV2FailClosedError("BACKUP_V2_UNKNOWN_COPY_KIND", `Unknown copy kind: ${String(copy.kind)}`);
      }
      if (!REQUIREMENTS.includes(copy.requirement)) {
        throw new BackupV2FailClosedError("BACKUP_V2_UNKNOWN_REQUIREMENT", `Unknown ${copy.kind} requirement`);
      }
      if (copyKinds.has(copy.kind)) {
        throw new BackupV2FailClosedError("BACKUP_V2_DUPLICATE_COPY_REQUIREMENT", `Duplicate ${copy.kind}`);
      }
      copyKinds.add(copy.kind);
    }
    if (!copyKinds.has("primary")) {
      throw new BackupV2FailClosedError("BACKUP_V2_PRIMARY_COPY_REQUIREMENT_MISSING", `${scope} lacks primary policy`);
    }
    requirements.set(scope, component);
  }
  if (!requirements.has("database")) {
    throw new BackupV2FailClosedError("BACKUP_V2_DATABASE_REQUIREMENT_MISSING", "Database requirement is mandatory");
  }
  return requirements;
}

function compatibilityBlockers(
  scope: BackupV2Scope,
  evidence: CompatibilityEvidence,
  evaluatedAtMs: number,
  maxEvidenceAgeMs: number | null,
): string[] {
  const blockers: string[] = [];
  if (evidence.status !== "verified") blockers.push(`${scope}:compatibility_${evidence.status}`);
  requireNonEmpty(evidence.backupFormatVersion, `${scope}:backup_format_missing`, blockers);
  requireNonEmpty(evidence.schemaCompatibilityRef, `${scope}:schema_compatibility_missing`, blockers);
  requireNonEmpty(evidence.exporterVersion, `${scope}:exporter_version_missing`, blockers);
  const timeBlocker = evidenceTimeBlocker(
    evidence.verifiedAt, evaluatedAtMs, maxEvidenceAgeMs, `${scope}:compatibility`,
  );
  if (timeBlocker) blockers.push(timeBlocker);
  return blockers;
}

function copyBlockers(
  scope: BackupV2Scope,
  evidence: RecoveryCopyEvidence | undefined,
  kind: CopyKind,
  evaluatedAtMs: number,
  maxEvidenceAgeMs: number | null,
): string[] {
  if (!evidence) return [`${scope}:${kind}_copy_missing`];
  const blockers: string[] = [];
  if (evidence.status !== "verified") blockers.push(`${scope}:${kind}_copy_${evidence.status}`);
  requireNonEmpty(evidence.providerNeutralRef, `${scope}:${kind}_copy_reference_missing`, blockers);
  const timeBlocker = evidenceTimeBlocker(
    evidence.verifiedAt, evaluatedAtMs, maxEvidenceAgeMs, `${scope}:${kind}_copy`,
  );
  if (timeBlocker) blockers.push(timeBlocker);
  return blockers;
}

function componentBlockers(
  component: RecoverySetComponent,
  requiredCopyKinds: readonly CopyKind[],
  evaluatedAtMs: number,
  maxEvidenceAgeMs: number | null,
): string[] {
  const blockers: string[] = [];
  if (component.artifact !== "present") blockers.push(`${component.scope}:artifact_${component.artifact}`);
  if (component.completion !== "completed") blockers.push(`${component.scope}:scope_${component.completion}`);
  if (component.integrity !== "verified") blockers.push(`${component.scope}:integrity_${component.integrity}`);
  blockers.push(...compatibilityBlockers(component.scope, component.compatibility, evaluatedAtMs, maxEvidenceAgeMs));
  const byKind = new Map<CopyKind, RecoveryCopyEvidence>();
  for (const copy of component.copies) {
    if (!COPY_KINDS.includes(copy.kind)) {
      blockers.push(`${component.scope}:unknown_copy_kind`);
      continue;
    }
    if (byKind.has(copy.kind)) blockers.push(`${component.scope}:${copy.kind}_copy_duplicate`);
    else byKind.set(copy.kind, copy);
  }
  for (const kind of requiredCopyKinds) {
    blockers.push(...copyBlockers(component.scope, byKind.get(kind), kind, evaluatedAtMs, maxEvidenceAgeMs));
  }
  for (const reason of component.failClosedReasons) blockers.push(`${component.scope}:fail_closed:${reason}`);
  return blockers;
}

function recoveryKeyBlockers(
  evidence: RecoveryKeyEvidence | null,
  evaluatedAtMs: number,
  maxEvidenceAgeMs: number | null,
): string[] {
  if (!evidence) return ["recovery_key:evidence_missing"];
  const blockers: string[] = [];
  if (evidence.status !== "availability_attested") blockers.push(`recovery_key:${evidence.status}`);
  requireNonEmpty(evidence.keyVersion, "recovery_key:version_missing", blockers);
  requireNonEmpty(evidence.safeReference, "recovery_key:safe_reference_missing", blockers);
  requireNonEmpty(evidence.publicFingerprint, "recovery_key:fingerprint_missing", blockers);
  const timeBlocker = evidenceTimeBlocker(
    evidence.attestedAt, evaluatedAtMs, maxEvidenceAgeMs, "recovery_key",
  );
  if (timeBlocker) blockers.push(timeBlocker);
  return blockers;
}

export function evaluateRecoverySet(input: RecoverySetEvaluationInput): RecoverySetEvaluation {
  const environment: RecoveryEvaluationEnvironment = requireRecoveryEvaluationEnvironment(
    input.environment ?? "runtime",
  );
  const evaluatedAtMs = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs)) {
    throw new BackupV2FailClosedError("BACKUP_V2_INVALID_EVALUATION_TIME", "Evaluation time is invalid");
  }
  const requirements = validatePolicy(input.policy);
  const byScope = new Map<BackupV2Scope, RecoverySetComponent>();
  const blockingReasons: string[] = [];
  for (const component of input.components) {
    const scope = requireBackupV2Scope(component.scope);
    if (byScope.has(scope)) {
      throw new BackupV2FailClosedError("BACKUP_V2_DUPLICATE_RECOVERY_COMPONENT", `Duplicate ${scope}`);
    }
    if (!requirements.has(scope)) {
      throw new BackupV2FailClosedError("BACKUP_V2_UNDECLARED_RECOVERY_COMPONENT", `${scope} is not in policy`);
    }
    if (!isRecoveryEvidenceOrigin(component.evidenceOrigin)) {
      blockingReasons.push(`${scope}:unknown_evidence_origin`);
    } else {
      const capabilities = RECOVERY_EVIDENCE_ORIGIN_CAPABILITIES[component.evidenceOrigin];
      const originEligible = environment === "runtime"
        ? capabilities.runtimeFullDrReady
        : capabilities.syntheticTestEvaluation;
      if (!originEligible) blockingReasons.push(`${scope}:evidence_origin_not_eligible_for_${environment}`);
    }
    byScope.set(scope, component);
  }
  const requiredScopes = [...requirements.values()]
    .filter(({ requirement }) => requirement === "required")
    .map(({ scope }) => scope);
  const missingScopes = requiredScopes.filter((scope) => !byScope.has(scope));
  blockingReasons.push(...missingScopes.map((scope) => `${scope}:missing`));
  for (const requirement of requirements.values()) {
    if (requirement.requirement !== "required") continue;
    const component = byScope.get(requirement.scope);
    if (!component) continue;
    const requiredCopies = requirement.copies
      .filter(({ requirement: copyRequirement }) => copyRequirement === "required")
      .map(({ kind }) => kind);
    blockingReasons.push(...componentBlockers(
      component, requiredCopies, evaluatedAtMs, input.policy.maxEvidenceAgeMs,
    ));
  }
  if (input.policy.recoveryKeyRequirement === "required") {
    blockingReasons.push(...recoveryKeyBlockers(
      input.recoveryKey, evaluatedAtMs, input.policy.maxEvidenceAgeMs,
    ));
  }
  const fullDrReady = missingScopes.length === 0 && blockingReasons.length === 0;
  return { state: fullDrReady ? "full_dr_ready" : "assembling", fullDrReady, missingScopes, blockingReasons };
}

export function assertFullDrReady(input: RecoverySetEvaluationInput): void {
  const result = evaluateRecoverySet(input);
  if (!result.fullDrReady) {
    throw new BackupV2FailClosedError(
      "BACKUP_V2_RECOVERY_SET_INCOMPLETE",
      `Recovery set cannot claim full_dr_ready: ${result.blockingReasons.join(", ")}`,
    );
  }
}

export const CURRENT_RECOVERY_SCOPES: readonly BackupV2Scope[] = BACKUP_V2_SCOPES;
