import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { catalogFingerprint, classifyDatabaseRelation } from "../src/lib/backups/v2/index.ts";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") {
  throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required for the disposable concurrency test.");
}

const container = process.env.BACKUP_V2_DB_CONTAINER ?? "supabase_db_car-zone-accesorios";
function sql(query) {
  return execFileSync("docker", [
    "exec", container, "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-qAt", "-c", query,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function lockRun(runId) {
  const token = "READY-" + randomUUID();
  const child = spawn("docker", [
    "exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-qAt",
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  let errorOutput = "";
  const ready = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.includes(token)) resolve();
    });
    child.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (!output.includes(token)) reject(new Error("Gate exited " + code + ": " + errorOutput));
    });
  });
  child.stdin.write("begin;\nselect id from public.backup_v2_runs where id='" + runId
    + "' for update;\nselect '" + token + "';\n");
  return {
    ready,
    async release() {
      const exited = new Promise((resolve, reject) => {
        child.once("exit", (code) => code === 0
          ? resolve() : reject(new Error("Gate failed: " + errorOutput)));
      });
      child.stdin.end("commit;\n\\q\n");
      await exited;
    },
  };
}
function claim(runId, owner) {
  return new Promise((resolve) => {
    const child = spawn("docker", [
      "exec", container, "psql", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-qAt", "-c",
      "select lease_owner_ref||':'||lease_generation from public.claim_backup_v2_run_lease('"
        + runId + "','" + owner + "',60);",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("exit", (code) => resolve({
      owner, code, stdout: stdout.trim(), stderr: stderr.trim(),
    }));
  });
}
function runQuery(query) {
  return new Promise((resolve) => {
    const child = spawn("docker", [
      "exec", container, "psql", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", "-qAt", "-c", query,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("exit", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
  });
}
async function waitForTwoBlockedClaims(runId) {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const count = Number(sql(
      "select count(*) from pg_stat_activity where wait_event_type='Lock'"
      + " and query like '%claim_backup_v2_run_lease%' and query like '%" + runId + "%';",
    ));
    if (count >= 2) return;
    await delay(50);
  }
  throw new Error("Both claim sessions did not reach the controlled row lock.");
}

assert.equal(sql("select to_regclass('public.backup_v2_catalog_snapshots') is not null;"), "t");
const catalog = JSON.parse(sql(
  "select jsonb_agg(jsonb_build_object('schemaName',schema_name,'relationName',relation_name,"
  + "'relationKind',relation_kind,'sqlClassification',classification,'sqlReason',classification_reason)"
  + " order by convert_to(schema_name||'.'||relation_name,'UTF8')) from public.backup_v2_current_catalog();",
));
const classifiedCatalog = catalog.map((entry) => {
  const classified = classifyDatabaseRelation({
    schemaName: entry.schemaName,
    relationName: entry.relationName,
    relationKind: entry.relationKind,
    estimatedRows: "0",
    totalBytes: "0",
    tableBytes: "0",
    indexBytes: "0",
    discoveredAt: new Date().toISOString(),
    evidenceOrigin: "runtime_verified",
  });
  assert.equal(classified.classification, entry.sqlClassification, entry.relationName);
  assert.equal(classified.classificationReason, entry.sqlReason, entry.relationName);
  return classified;
});
assert.equal(
  catalogFingerprint(classifiedCatalog),
  sql("select public.backup_v2_current_catalog_fingerprint();"),
  "TypeScript and PostgreSQL must produce the same UTF-8 canonical catalog fingerprint",
);
const idempotencyManualId = "idempotency-" + randomUUID();
const idempotencyBoundary = new Date().toISOString();
const concurrentCreationSql = "select id from public.create_or_get_backup_v2_generation("
  + "'policy-v1','local-disposable','" + idempotencyBoundary
  + "'::timestamptz,array['external_assets','external_assets'],'manual','"
  + idempotencyManualId + "');";
const creationOutcomes = await Promise.all([
  runQuery(concurrentCreationSql), runQuery(concurrentCreationSql),
]);
assert.deepEqual(creationOutcomes.map(({ code }) => code), [0, 0], JSON.stringify(creationOutcomes));
assert.equal(creationOutcomes[0].stdout, creationOutcomes[1].stdout,
  "concurrent identical creation must return one logical generation");
sql("delete from public.backup_v2_runs where id='" + creationOutcomes[0].stdout + "';");
const manualId = "concurrency-" + randomUUID();
const runId = sql(
  "select id from public.create_or_get_backup_v2_generation("
  + "'policy-v1','local-disposable',now(),array['database'],'manual','" + manualId + "');",
);
const measurement = "'{\"encrypted_bytes\":\"1\",\"temporary_peak_bytes\":\"1\","
  + "\"object_count\":\"1\",\"operation_count\":\"1\",\"runtime_seconds\":\"1\","
  + "\"github_actions_minutes\":\"0\",\"database_total_bytes\":\"1\","
  + "\"observed_artifact_bytes\":\"1\",\"runner_temp_disk_available_bytes\":\"1000\","
  + "\"provider_quota_bytes\":\"1000\"}'::jsonb";
for (const scope of ["database", "full_recovery_set", "runtime"]) {
  sql("select id from public.record_backup_v2_measurement('" + runId + "','" + scope
    + "',now()-interval '1 second'," + measurement + ");");
}
assert.equal(sql(
  "select preflight_outcome from public.prepare_backup_v2_preflight('" + runId + "',3600);",
), "go");

const gate = lockRun(runId);
await gate.ready;
const first = claim(runId, "concurrent-a");
const second = claim(runId, "concurrent-b");
await waitForTwoBlockedClaims(runId);
await gate.release();
const outcomes = await Promise.all([first, second]);
const winners = outcomes.filter(({ code }) => code === 0);
const losers = outcomes.filter(({ code }) => code !== 0);
assert.equal(winners.length, 1, JSON.stringify(outcomes));
assert.equal(losers.length, 1, JSON.stringify(outcomes));
assert.match(losers[0].stderr, /BACKUP_V2_LEASE_UNAVAILABLE/);
assert.equal(sql(
  "select lease_owner_ref from public.backup_v2_runs where id='" + runId + "';",
), winners[0].owner);
assert.equal(sql(
  "select count(*) from public.backup_v2_runs where id='" + runId + "' and lease_owner_ref is not null;",
), "1");
sql(
  "select lifecycle_state from public.transition_backup_v2_run_fenced('" + runId
  + "','database','preflight','failed','" + winners[0].owner + "',1,'worker','"
  + winners[0].owner + "',1,'CONCURRENCY_TEST_COMPLETE','{}'::jsonb);",
);
console.log("Backup V2 Phase 4B.1 true concurrency: PASS", {
  runId, winner: winners[0].owner, loser: losers[0].owner, activeOwners: 1,
});
