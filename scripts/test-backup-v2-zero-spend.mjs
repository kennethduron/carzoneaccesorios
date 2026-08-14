import assert from "node:assert/strict";
import { automaticCapacityDeletionPlan, evaluateZeroSpend } from "../src/lib/backups/v2/index.ts";

const now = "2026-08-13T12:00:00.000Z";
const fresh = "2026-08-13T11:55:00.000Z";
const maxMeasurementAgeMs = 60 * 60 * 1000;
function evaluate(used, projectedNextOperation = 0, overrides = {}, inputOverrides = {}) {
  return evaluateZeroSpend({ now, maxMeasurementAgeMs, dimensions: [{
    name: "storage_bytes", quota: 10_000, used, projectedNextOperation, measuredAt: fresh,
    requiredProviderDataAvailable: true, ...overrides,
  }], ...inputOverrides });
}

for (const [label, used, expected] of [
  ["69.99", 6_999, "normal"], ["70", 7_000, "warning"], ["79", 7_900, "warning"],
  ["79.99", 7_999, "warning"], ["80", 8_000, "critical_capacity"],
  ["89", 8_900, "critical_capacity"], ["89.99", 8_999, "critical_capacity"],
  ["90", 9_000, "blocked_budget"], [">90", 9_500, "blocked_budget"],
]) assert.equal(evaluate(used).state, expected, `${label}% exact ordinary boundary`);

assert.equal(evaluate(7_500, 1_500).state, "blocked_budget");
assert.equal(evaluate(7_500, 1_600).state, "blocked_budget");

for (const overrides of [
  { quota: 0 }, { quota: null }, { quota: Number.NaN }, { quota: Number.POSITIVE_INFINITY },
  { quota: -1 }, { quota: 1.5 }, { used: -1 }, { used: 1.5 }, { used: Number.NaN },
  { used: Number.NEGATIVE_INFINITY }, { projectedNextOperation: -1 }, { projectedNextOperation: 1.5 },
  { projectedNextOperation: Number.NaN }, { projectedNextOperation: Number.POSITIVE_INFINITY },
  { measuredAt: "not-a-time" }, { measuredAt: "2026-08-13T12:00:00.001Z" },
  { measuredAt: "2026-08-12T00:00:00.000Z" }, { requiredProviderDataAvailable: false },
]) assert.equal(evaluate(1_000, 0, overrides).state, "blocked_budget");

for (const invalidExactText of ["", " ", "01", "+1", "-1", "1.0", "1e3", "0x10", "1 "]) {
  assert.equal(evaluate(1_000, 0, { quota: invalidExactText }).state, "blocked_budget");
}

for (const unsafeNumber of [
  Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 2, 1e100, Number.MAX_VALUE,
]) {
  assert.equal(evaluate(1_000, 0, { quota: unsafeNumber }).state, "blocked_budget");
  assert.equal(evaluate(unsafeNumber).state, "blocked_budget");
  assert.equal(evaluate(1_000, unsafeNumber).state, "blocked_budget");
}

for (const invalidAge of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(evaluate(1_000, 0, {}, { maxMeasurementAgeMs: invalidAge }).state, "blocked_budget");
}
assert.equal(evaluateZeroSpend({ now, maxMeasurementAgeMs, dimensions: [] }).state, "blocked_budget");

const largeQuota = 100_000_000_000_000_000_000n;
for (const [label, numerator, expected] of [
  ["69.99", 6_999n, "normal"], ["70", 7_000n, "warning"], ["79", 7_900n, "warning"],
  ["79.99", 7_999n, "warning"], ["80", 8_000n, "critical_capacity"],
  ["89", 8_900n, "critical_capacity"], ["89.99", 8_999n, "critical_capacity"],
  ["90", 9_000n, "blocked_budget"], [">90", 9_001n, "blocked_budget"],
]) {
  const used = largeQuota * numerator / 10_000n;
  assert.equal(evaluateZeroSpend({ now, maxMeasurementAgeMs, dimensions: [{
    name: "large_exact_bytes", quota: largeQuota.toString(), used: used.toString(),
    projectedNextOperation: "0", measuredAt: fresh, requiredProviderDataAvailable: true,
  }] }).state, expected, `${label}% exact large boundary`);
}

const adversarialQuota = 9_007_199_254_740_995n;
const adversarialUsed = 8_106_479_329_266_896n;
assert.equal(adversarialUsed * 10n >= adversarialQuota * 9n, true);
assert.equal(evaluateZeroSpend({ now, maxMeasurementAgeMs, dimensions: [{
  name: "original_precision_reproduction", quota: Number(adversarialQuota), used: Number(adversarialUsed),
  projectedNextOperation: 0, measuredAt: fresh, requiredProviderDataAvailable: true,
}] }).state, "blocked_budget", "lossy Number reproduction must fail closed before conversion");
assert.equal(evaluateZeroSpend({ now, maxMeasurementAgeMs, dimensions: [{
  name: "original_precision_exact", quota: adversarialQuota.toString(), used: adversarialUsed.toString(),
  projectedNextOperation: "0", measuredAt: fresh, requiredProviderDataAvailable: true,
}] }).state, "blocked_budget", "same exact quantities must block at true >=90%");

assert.equal(evaluateZeroSpend({ now, maxMeasurementAgeMs, dimensions: [{
  name: "large_projected_crossing", quota: largeQuota.toString(),
  used: (largeQuota * 89n / 100n).toString(), projectedNextOperation: (largeQuota / 100n).toString(),
  measuredAt: fresh, requiredProviderDataAvailable: true,
}] }).state, "blocked_budget");
assert.equal(evaluateZeroSpend({ now, maxMeasurementAgeMs, dimensions: [{
  name: "safe_current_huge_projected", quota: largeQuota.toString(), used: "1",
  projectedNextOperation: largeQuota.toString(), measuredAt: fresh, requiredProviderDataAvailable: true,
}] }).state, "blocked_budget");

const blocked = evaluate(8_900, 200);
assert.equal(blocked.ownerDecisionRequired, true);
assert.equal(blocked.automaticDeletionAllowed, false);
const deletionPlan = automaticCapacityDeletionPlan([
  { id: "latest-db", protectedReasons: ["latest_verified_database"] },
  { id: "latest-dr", protectedReasons: ["latest_full_dr_ready"] },
  { id: "latest-restore", protectedReasons: ["latest_restore_verified"] },
  { id: "previous", protectedReasons: ["required_previous_verified_generation"] },
  { id: "hold", protectedReasons: ["legal_or_incident_hold"] },
  { id: "incremental", protectedReasons: ["incremental_dependency"] },
  { id: "old-key", protectedReasons: ["requires_historical_key_version"] },
  { id: "ordinary", protectedReasons: [] },
]);
assert.deepEqual(deletionPlan.candidates, []);
assert.equal(deletionPlan.ownerDecisionRequired, true);
assert.equal(deletionPlan.protectedArtifactIds.length, 7);
console.log("Backup V2 zero-spend contracts: PASS");
