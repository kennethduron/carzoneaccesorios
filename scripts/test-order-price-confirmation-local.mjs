import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") {
  throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required.");
}
const container = process.env.LOCAL_PG_DOCKER_CONTAINER ?? "supabase_db_car-zone-accesorios";
assert.equal(container, "supabase_db_car-zone-accesorios", "Only the approved local Supabase database is allowed.");
const sql = readFileSync("scripts/test-order-price-confirmation-local.sql", "utf8");
const result = spawnSync(
  "docker",
  ["exec", "-i", container, "psql", "-X", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q"],
  { input: sql, encoding: "utf8", windowsHide: true, timeout: 120_000 },
);
const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
assert.equal(result.status, 0, output);
assert.match(output, /zero-residue checks passed/);
console.log("Order price confirmation local integration checks passed.");
