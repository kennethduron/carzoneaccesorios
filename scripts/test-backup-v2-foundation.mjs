import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  RECOVERY_EVIDENCE_ORIGINS, BackupV2FailClosedError, assertFullDrReady, assertStateMachineIsComplete,
  evaluateRecoverySet, requireBackupV2Scope, requireMeasurementGateScopes,
  isRecoveryEvidenceOrigin, retryModeForOperation, transitionBackupV2State,
} from "../src/lib/backups/v2/index.ts";

function mustFailClosed(callback, expectedCode) {
  assert.throws(callback, (error) => {
    assert.ok(error instanceof BackupV2FailClosedError);
    assert.equal(error.code, expectedCode);
    return true;
  });
}

const now = "2026-08-13T12:00:00.000Z";
const verifiedAt = "2026-08-13T11:55:00.000Z";
const freshness = { now, maxMeasurementAgeMs: 60 * 60 * 1000 };
const policy = {
  policyVersion: "typed-recovery-v2",
  components: ["database", "auth", "storage_objects"].map((scope) => ({
    scope, requirement: "required", copies: [
      { kind: "primary", requirement: "required" },
      { kind: "independent_offsite", requirement: "optional" },
    ],
  })),
  recoveryKeyRequirement: "required",
  maxEvidenceAgeMs: 60 * 60 * 1000,
};
function component(scope, overrides = {}) {
  return {
    scope, artifact: "present", completion: "completed", integrity: "verified",
    compatibility: {
      status: "verified", backupFormatVersion: "backup-v2-format-1",
      schemaCompatibilityRef: "migration-head:synthetic-current",
      exporterVersion: "phase4a-contract-1", verifiedAt,
    },
    copies: [{ kind: "primary", status: "verified", verifiedAt, providerNeutralRef: `primary:${scope}` }],
    failClosedReasons: [], evidenceOrigin: "synthetic_fixture", ...overrides,
  };
}
const keyEvidence = {
  status: "availability_attested", keyVersion: "offline-key-v1",
  safeReference: "offline-custody-attestation:synthetic",
  publicFingerprint: "SHA256:synthetic-public-fingerprint-only", attestedAt: verifiedAt,
};
function evaluate(components, overrides = {}) {
  return evaluateRecoverySet({ policy, components, recoveryKey: keyEvidence,
    environment: "synthetic_test", evaluatedAt: now, ...overrides });
}

assertStateMachineIsComplete();
for (const [from, to] of [["requested", "preflight"], ["preflight", "running"],
  ["running", "validating"], ["validating", "completed"]]) {
  assert.equal(transitionBackupV2State(from, to), to);
}
mustFailClosed(() => transitionBackupV2State("requested", "completed"), "BACKUP_V2_INVALID_TRANSITION");
mustFailClosed(() => transitionBackupV2State("completed", "running"), "BACKUP_V2_TERMINAL_STATE_IMMUTABLE");
mustFailClosed(() => transitionBackupV2State("not_a_state", "running"), "BACKUP_V2_UNKNOWN_STATE");
mustFailClosed(() => requireBackupV2Scope("unknown_relation"), "BACKUP_V2_UNKNOWN_SCOPE");
assert.equal(retryModeForOperation("primary_upload"), "same_artifact_operation");
assert.equal(retryModeForOperation("export"), "fresh_backup_attempt");
mustFailClosed(() => retryModeForOperation("retry_everything"), "BACKUP_V2_UNKNOWN_RETRY_OPERATION");

const all = [component("database"), component("auth"), component("storage_objects")];
assert.equal(evaluate([component("database")]).fullDrReady, false, "database completed is not full DR");
assert.equal(evaluate(all.map((item) => item.scope === "database" ? { ...item, copies: [] } : item)).fullDrReady, false);
assert.equal(evaluate(all, { recoveryKey: null }).fullDrReady, false);
assert.equal(evaluate(all.map((item) => item.scope === "auth" ? { ...item,
  compatibility: { ...item.compatibility, schemaCompatibilityRef: null } } : item)).fullDrReady, false);
assert.equal(evaluate(all.map((item) => item.scope === "storage_objects" ? { ...item, integrity: "unknown" } : item)).fullDrReady, false);
assert.equal(evaluate(all.map((item) => item.scope === "database" ? { ...item,
  compatibility: { ...item.compatibility, verifiedAt: "2026-08-13T12:00:00.001Z" } } : item)).fullDrReady, false);
assert.equal(evaluate(all.map((item) => item.scope === "database" ? { ...item,
  copies: [{ ...item.copies[0], verifiedAt: "2026-08-13T10:00:00.000Z" }] } : item)).fullDrReady, false);
assert.equal(evaluateRecoverySet({ policy: { ...policy, components: policy.components.map((item) =>
  item.scope === "auth" ? { ...item, copies: item.copies.map((copy) =>
    copy.kind === "independent_offsite" ? { ...copy, requirement: "required" } : copy) } : item) },
components: all, recoveryKey: keyEvidence, environment: "synthetic_test", evaluatedAt: now }).fullDrReady, false);
assert.equal(evaluate(all).fullDrReady, true);
assert.doesNotThrow(() => assertFullDrReady({ policy, components: all, recoveryKey: keyEvidence,
  environment: "synthetic_test", evaluatedAt: now }));
assert.equal(evaluateRecoverySet({ policy, components: all, recoveryKey: keyEvidence,
  environment: "runtime", evaluatedAt: now }).fullDrReady, false);
const runtimeComponents = all.map((item) => ({ ...item, evidenceOrigin: "runtime_verified" }));
assert.deepEqual(RECOVERY_EVIDENCE_ORIGINS, ["runtime_verified", "synthetic_fixture"]);
assert.equal(evaluateRecoverySet({ policy, components: runtimeComponents, recoveryKey: keyEvidence,
  environment: "runtime", evaluatedAt: now }).fullDrReady, true);
for (const invalidOrigin of [
  "unknown_origin", "runtime", "production", "verified", "manual", "provider", "", " ",
  null, undefined, 123, {}, [], "RUNTIME_VERIFIED", "runtime_verified ", "runtime_verifed",
]) {
  assert.equal(isRecoveryEvidenceOrigin(invalidOrigin), false, `origin must be closed: ${String(invalidOrigin)}`);
  const invalidComponents = runtimeComponents.map((item) => ({ ...item, evidenceOrigin: invalidOrigin }));
  const result = evaluateRecoverySet({ policy, components: invalidComponents, recoveryKey: keyEvidence,
    environment: "runtime", evaluatedAt: now });
  assert.equal(result.fullDrReady, false, `invalid origin must not establish full DR: ${String(invalidOrigin)}`);
  assert.ok(result.blockingReasons.some((reason) => reason.endsWith(":unknown_evidence_origin")));
}
assert.equal(evaluateRecoverySet({ policy, components: all, recoveryKey: keyEvidence,
  environment: "synthetic_test", evaluatedAt: now }).fullDrReady, true);
mustFailClosed(() => evaluateRecoverySet({ policy, components: runtimeComponents, recoveryKey: keyEvidence,
  environment: "production", evaluatedAt: now }), "BACKUP_V2_UNKNOWN_RECOVERY_ENVIRONMENT");
mustFailClosed(() => evaluateRecoverySet({ policy: { ...policy, components: [...policy.components,
  { scope: "unknown", requirement: "required", copies: [] }] }, components: all,
  recoveryKey: keyEvidence, evaluatedAt: now }), "BACKUP_V2_UNKNOWN_SCOPE");
mustFailClosed(() => evaluateRecoverySet({ policy: { ...policy, components: policy.components.map((item) =>
  item.scope === "auth" ? { ...item, requirement: "sometimes" } : item) }, components: all,
  recoveryKey: keyEvidence, evaluatedAt: now }), "BACKUP_V2_UNKNOWN_REQUIREMENT");
mustFailClosed(() => evaluateRecoverySet({ policy: { ...policy, maxEvidenceAgeMs: Number.NaN }, components: all,
  recoveryKey: keyEvidence, evaluatedAt: now }), "BACKUP_V2_INVALID_EVIDENCE_AGE");
mustFailClosed(() => evaluateRecoverySet({ policy, components: [...all, component("database")],
  recoveryKey: keyEvidence, evaluatedAt: now }), "BACKUP_V2_DUPLICATE_RECOVERY_COMPONENT");
mustFailClosed(() => evaluateRecoverySet({ policy: { ...policy, components: policy.components.map((item) =>
  item.scope === "database" ? { ...item, copies: [{ kind: "unknown_copy", requirement: "required" }] } : item) },
components: all, recoveryKey: keyEvidence, evaluatedAt: now }), "BACKUP_V2_UNKNOWN_COPY_KIND");

const fixtureUrl = new URL("./fixtures/backup-v2-measurements.synthetic.json", import.meta.url);
const measurements = JSON.parse(await readFile(fixtureUrl, "utf8"));
assert.doesNotThrow(() => requireMeasurementGateScopes(measurements, freshness));
mustFailClosed(() => requireMeasurementGateScopes(measurements.filter(({ scope }) => scope !== "auth"), freshness),
  "BACKUP_V2_MEASUREMENT_GATE_INCOMPLETE");
mustFailClosed(() => requireMeasurementGateScopes(measurements, { ...freshness, maxMeasurementAgeMs: Number.NaN }),
  "BACKUP_V2_INVALID_MEASUREMENT_FRESHNESS_POLICY");
mustFailClosed(() => requireMeasurementGateScopes(measurements.map((item) => item.scope === "database"
  ? { ...item, encryptedBytes: Number.NaN } : item), freshness), "BACKUP_V2_INVALID_MEASUREMENT_VALUE");
mustFailClosed(() => requireMeasurementGateScopes(measurements.map((item) => item.scope === "database"
  ? { ...item, measuredAt: "2026-08-13T12:00:00.001Z" } : item), freshness), "BACKUP_V2_FUTURE_MEASUREMENT");
mustFailClosed(() => requireMeasurementGateScopes(measurements.map((item) => item.scope === "database"
  ? { ...item, measuredAt: "2026-08-13T10:00:00.000Z" } : item), freshness), "BACKUP_V2_STALE_MEASUREMENT");
for (const field of ["encryptedBytes", "temporaryPeakBytes", "objectCount", "operationCount"]) {
  mustFailClosed(() => requireMeasurementGateScopes(measurements.map((item) => item.scope === "database"
    ? { ...item, [field]: Number.MAX_SAFE_INTEGER + 1 } : item), freshness),
  "BACKUP_V2_INVALID_MEASUREMENT_VALUE");
}
mustFailClosed(() => requireMeasurementGateScopes(measurements,
  { ...freshness, maxMeasurementAgeMs: Number.MAX_SAFE_INTEGER + 1 }),
"BACKUP_V2_INVALID_MEASUREMENT_FRESHNESS_POLICY");

console.log("Backup V2 foundation contracts: PASS");
