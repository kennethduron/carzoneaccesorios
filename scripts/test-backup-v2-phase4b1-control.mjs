import assert from "node:assert/strict";
import {
  assertLeaseAuthority, classifyDatabaseRelation, classifyRetry, createCatalogSnapshot, evaluatePreflight,
  generationKey, parseExactByteQuantity,
  requireSafetyCriticalMeasurement, retryRequiresNewLease, semanticRequestKey,
  serializeExactByteQuantity, validateLease, validateRuntimeMeasurement,
} from "../src/lib/backups/v2/index.ts";

const boundary = "2026-08-14T12:00:00.000Z";
const request = { policyVersion: "policy-v1", sourceEnvironment: "production", generationBoundary: boundary,
  scopes: ["database", "auth", "storage_metadata", "storage_objects", "external_assets"],
  triggerType: "scheduled", executionId: "uuid-a" };
const key = semanticRequestKey(request);
assert.equal(key, semanticRequestKey({ ...request, scopes: [...request.scopes, "auth"].reverse(), executionId: "uuid-b" }));
assert.equal(generationKey(request), key.replace("backup-v2:", "backup-v2-generation:"));
assert.equal(key, semanticRequestKey({ ...request, sourceEnvironment: " PRODUCTION ", executionId: "uuid-c",
  irrelevantObservedAt: "2099-01-01T00:00:00.000Z" }));
assert.notEqual(key, semanticRequestKey({ ...request, generationBoundary: "2026-08-14T13:00:00.000Z" }));
assert.notEqual(key, semanticRequestKey({ ...request, scopes: ["database"] }));

function relation(relationName) {
  return { schemaName: "public", relationName, relationKind: "base_table", estimatedRows: "0", totalBytes: "0",
    tableBytes: "0", indexBytes: "0", discoveredAt: boundary, evidenceOrigin: "synthetic_fixture" };
}
const goCatalog = createCatalogSnapshot([classifyDatabaseRelation(relation("products"))], "policy-v1", boundary);
const reviewCatalog = createCatalogSnapshot([classifyDatabaseRelation(relation("future_table"))], "policy-v1", boundary);
assert.equal(evaluatePreflight({ catalog: goCatalog }).outcome, "go");
assert.throws(() => evaluatePreflight([]));
assert.equal(evaluatePreflight({ catalog: goCatalog,
  findings: [{ reason: "quota_unknown", detail: "quota has not been configured" }] }).outcome, "blocked");
assert.equal(evaluatePreflight({ catalog: reviewCatalog }).outcome, "review_required");
assert.equal(evaluatePreflight({ catalog: reviewCatalog,
  findings: [{ reason: "quota_unknown", detail: "quota has not been configured" }] }).outcome, "blocked");
assert.throws(() => evaluatePreflight({ catalog: goCatalog, findings: [{ reason: "future_reason", detail: "x" }] }));

for (const [reason, expected] of [["provider_unavailable", "retryable"], ["integrity_failed", "fail_closed"],
  ["unknown_relation", "manual_review"], ["encryption_failed", "terminal"], ["lease_lost", "retryable"]]) {
  assert.equal(classifyRetry(reason), expected);
}
assert.equal(retryRequiresNewLease("lease_lost"), true);
assert.throws(() => classifyRetry("retry_everything"));

assert.equal(parseExactByteQuantity("90071992547409930"), BigInt("90071992547409930"));
assert.equal(serializeExactByteQuantity(BigInt("90071992547409930")), "90071992547409930");
for (const unsafe of [Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE, Number.NaN, Infinity, "1e3", "-1", "01"])
  assert.throws(() => parseExactByteQuantity(unsafe));

const runtimeMeasurement = { scope: "database", source: "runtime_verified", quality: "measured", measuredAt: boundary,
  encryptedBytes: "90071992547409930", temporaryPeakBytes: "90071992547409931", objectCount: 1,
  operationCount: 1, runtimeSeconds: 1, githubActionsMinutes: 0, databaseTotalBytes: "90071992547409932" };
assert.doesNotThrow(() => validateRuntimeMeasurement(runtimeMeasurement,
  { now: "2026-08-14T12:01:00.000Z", maxMeasurementAgeMs: 3600000 }));
assert.doesNotThrow(() => requireSafetyCriticalMeasurement(runtimeMeasurement));
assert.throws(() => requireSafetyCriticalMeasurement({ ...runtimeMeasurement, quality: "estimated" }));
assert.throws(() => validateRuntimeMeasurement({ ...runtimeMeasurement, databaseTotalBytes: Number.MAX_SAFE_INTEGER + 1 },
  { now: "2026-08-14T12:01:00.000Z", maxMeasurementAgeMs: 3600000 }));
assert.equal(evaluatePreflight({ catalog: goCatalog, measurements: [runtimeMeasurement],
  requiredMeasurementScopes: ["database"],
  measurementPolicy: { now: "2026-08-14T12:01:00.000Z", maxMeasurementAgeMs: 3600000 } }).outcome, "go");
assert.equal(evaluatePreflight({ catalog: goCatalog,
  measurements: [{ ...runtimeMeasurement, quality: "estimated" }], requiredMeasurementScopes: ["database"],
  measurementPolicy: { now: "2026-08-14T12:01:00.000Z", maxMeasurementAgeMs: 3600000 } }).outcome, "blocked");

const lease = { ownerRef: "worker-a", acquiredAt: boundary, heartbeatAt: "2026-08-14T12:00:10.000Z",
  expiresAt: "2026-08-14T12:05:00.000Z", generation: 2 };
assert.doesNotThrow(() => validateLease(lease, "2026-08-14T12:01:00.000Z"));
assert.doesNotThrow(() => assertLeaseAuthority(lease, "worker-a", 2, "2026-08-14T12:01:00.000Z"));
assert.throws(() => assertLeaseAuthority(lease, "worker-b", 2, "2026-08-14T12:01:00.000Z"));
assert.throws(() => assertLeaseAuthority(lease, "worker-a", 1, "2026-08-14T12:01:00.000Z"));
assert.throws(() => assertLeaseAuthority(lease, "worker-a", 2, "2026-08-14T12:06:00.000Z"));
console.log("Backup V2 Phase 4B.1 control contracts: PASS");
