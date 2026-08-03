import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [beforePath, afterPath] = process.argv.slice(2);
assert.ok(beforePath && afterPath, "Use: node scripts/compare-pos-stage-6-baselines.mjs <before> <after>.");
const before = JSON.parse(await readFile(beforePath, "utf8"));
const after = JSON.parse(await readFile(afterPath, "utf8"));
assert.equal(after.comparableSha256, before.comparableSha256, "Local baseline did not return to its original state.");
for (const [name, count] of Object.entries(after.prefixCounts)) {
  assert.equal(count, 0, `Residual ${after.marker} fixture detected in ${name}.`);
}
console.log("POS Stage 6 local restoration: PASS", {
  comparableSha256: after.comparableSha256,
  residualFixtures: 0,
});
