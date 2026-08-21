import assert from "node:assert/strict";
import {
  createProductSaveSingleFlightGuard,
  runProductPostSaveTasks,
} from "../src/lib/product-create-hardening.ts";

const attempted = [];
const diagnostics = [];
const result = await runProductPostSaveTasks([
  { stage: "asset_cleanup", run: () => attempted.push("asset_cleanup"), onFailure: () => undefined },
  { stage: "audit", run: () => { attempted.push("audit"); throw new Error("synthetic audit failure"); }, onFailure: () => diagnostics.push("audit") },
  { stage: "cache_revalidation", run: () => { attempted.push("cache_revalidation"); throw new Error("synthetic revalidation failure"); }, onFailure: () => { diagnostics.push("cache_revalidation"); throw new Error("synthetic diagnostic failure"); } },
]);
assert.deepEqual(attempted, ["asset_cleanup", "audit", "cache_revalidation"]);
assert.deepEqual(result.failedStages, ["audit", "cache_revalidation"]);
assert.deepEqual(diagnostics, ["audit", "cache_revalidation"]);

const guard = createProductSaveSingleFlightGuard();
assert.equal(guard.tryStart(), true);
assert.equal(guard.tryStart(), false, "a double submit must be rejected while the first is active");
guard.finish();
assert.equal(guard.tryStart(), true, "a corrected retry is allowed after the first attempt settles");
guard.finish();

console.log("product create hardening unit scenarios: PASS");
