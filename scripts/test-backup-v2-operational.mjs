import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  acquireOperationalLock,
  defaultOperationalStatus,
  readOperationalStatus,
  writeOperationalStatus,
} from "../src/lib/backups/v2-operational/local-state.ts";
import {
  B2_SOFT_BUDGET_BYTES,
  FIRST_RECOVERY_PROVEN_GENERATION,
  assertOperationalBudget,
  inventoryOperationalGenerations,
  planOperationalRetention,
  sanitizeOperationalText,
} from "../src/lib/backups/v2-operational/policy.ts";
import { BackupV2FailClosedError } from "../src/lib/backups/v2/types.ts";

function objectSet(runId, size = 100n) {
  const objects = [];
  for (const component of ["database", "auth", "storage_metadata", "storage_objects", "external_assets"]) {
    objects.push({ key: `car-zone/v2-simplified/${runId}/${component}/${component}-fixture.czb2`, sizeBytes: size });
    objects.push({ key: `car-zone/v2-simplified/${runId}/${component}/${component}-fixture.json`, sizeBytes: 10n });
  }
  objects.push({ key: `car-zone/v2-simplified/${runId}/manifest/backup-manifest.czb2`, sizeBytes: 20n });
  objects.push({ key: `car-zone/v2-simplified/${runId}/manifest/backup-index.json`, sizeBytes: 10n });
  return objects;
}

async function expectCode(action, code) {
  await assert.rejects(action, (error) => error instanceof BackupV2FailClosedError && error.code === code);
}

function runScheduledWithoutConfirmation(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--experimental-loader", "./scripts/ts-path-loader.mjs", "scripts/backup-v2-simplified-scheduled.mjs",
    ], {
      cwd: path.resolve(new URL("..", import.meta.url).pathname.slice(1)),
      env: { ...process.env, BACKUP_V2_SCHEDULED_EXECUTION_CONFIRMATION: "", BACKUP_V2_OPERATIONAL_ROOT: root },
      windowsHide: true,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });
}

const root = await mkdtemp(path.join(os.tmpdir(), "carzone-backup-v2-operational-test-"));
try {
  const firstRun = "2026-08-23T13-39-36-327Z_2ec889e8-2601-45d2-9a43-ef5d84ae1faf";
  const objects = [...objectSet(firstRun)];
  for (let index = 1; index <= 15; index += 1) {
    const day = String(index).padStart(2, "0");
    const suffix = String(index).padStart(12, "0");
    objects.push(...objectSet(`2026-07-${day}T09-00-00-000Z_00000000-0000-4000-8000-${suffix}`));
  }
  const generations = inventoryOperationalGenerations(objects);
  assert.equal(generations.find((generation) => generation.runId === firstRun)?.generationId, FIRST_RECOVERY_PROVEN_GENERATION);
  assert.ok(generations.every((generation) => generation.valid && generation.objectCount === 12));
  const dry = planOperationalRetention({ generations, successfulScheduledGenerations: 2, requestedMode: "ACTIVE" });
  assert.equal(dry.mode, "DRY_RUN");
  assert.equal(dry.destructiveEligible, false);
  assert.ok(dry.retainedGenerationIds.includes(FIRST_RECOVERY_PROVEN_GENERATION));
  assert.ok(dry.retainedGenerationIds.includes(generations[0].generationId));
  assert.ok(dry.retainedGenerationIds.includes(generations[1].generationId));
  assert.ok(!dry.deletionCandidateGenerationIds.includes(FIRST_RECOVERY_PROVEN_GENERATION));
  const active = planOperationalRetention({ generations, successfulScheduledGenerations: 3, requestedMode: "ACTIVE" });
  assert.equal(active.mode, "ACTIVE");
  assert.ok(!active.deletionCandidateGenerationIds.includes(generations[0].generationId));
  assert.ok(!active.deletionCandidateGenerationIds.includes(generations[1].generationId));

  assertOperationalBudget({ currentUsageBytes: 1_000n, estimatedSourceBytes: 2_000n, softBudgetBytes: B2_SOFT_BUDGET_BYTES });
  await expectCode(async () => assertOperationalBudget({
    currentUsageBytes: B2_SOFT_BUDGET_BYTES - 1n,
    estimatedSourceBytes: 2n,
    softBudgetBytes: B2_SOFT_BUDGET_BYTES,
  }), "BACKUP_V2_OPERATIONAL_BUDGET_BLOCKED");

  const injected = "token=super-secret-value\r\nFAKE=PASS postgresql://user:password@host/db";
  const sanitized = sanitizeOperationalText(injected);
  assert.doesNotMatch(sanitized, /super-secret|password@|\r|\n/);

  const lockPath = path.join(root, "locks", "scheduled.lock");
  const lock = await acquireOperationalLock(lockPath);
  await expectCode(() => acquireOperationalLock(lockPath), "BACKUP_V2_OPERATIONAL_ALREADY_RUNNING");
  await lock.release();
  await writeFile(lockPath, JSON.stringify({ pid: 2147483647, token: "stale" }), { mode: 0o600 });
  const old = new Date(Date.now() - 13 * 60 * 60 * 1000);
  await utimes(lockPath, old, old);
  const recovered = await acquireOperationalLock(lockPath);
  assert.equal(recovered.staleRecovered, true);
  await recovered.release();

  const statusPath = path.join(root, "status", "current.json");
  const status = defaultOperationalStatus();
  await writeOperationalStatus(statusPath, status);
  await writeOperationalStatus(statusPath, { ...status, lastResult: "PASS", successfulScheduledGenerations: 1 });
  assert.equal((await readOperationalStatus(statusPath)).lastResult, "PASS");
  assert.deepEqual((await readdir(path.dirname(statusPath))).filter((name) => name.endsWith(".tmp")), []);
  await writeFile(statusPath, "{partial", "utf8");
  await assert.rejects(() => readOperationalStatus(statusPath));

  const installer = await readFile(new URL("./install-backup-v2-scheduled-task.ps1", import.meta.url), "utf8");
  const wrapper = await readFile(new URL("./backup-v2-scheduled.ps1", import.meta.url), "utf8");
  const runner = await readFile(new URL("../src/lib/backups/v2-operational/run.ts", import.meta.url), "utf8");
  assert.match(installer, /WorkingDirectory \$stable/);
  assert.match(installer, /StartWhenAvailable/);
  assert.match(installer, /MultipleInstances IgnoreNew/);
  assert.match(installer, /RunLevel Limited/);
  assert.match(installer, /LogonType Interactive/);
  assert.doesNotMatch(installer, /C:\\tmp\\carzone-backup-v2-operational-20260823/);
  assert.match(wrapper, /BACKUP_V2_OPERATIONAL_CODE_SHA_MISMATCH/);
  assert.doesNotMatch(wrapper, /git\s+(?:pull|fetch|checkout|reset)/i);
  assert.match(runner, /executionMode: "OPERATIONAL_GENERATION"/);
  assert.doesNotMatch(runner, /provisionDisposablePostgresTarget|restoreAndVerifySimplifiedBackup/);

  const failure = await runScheduledWithoutConfirmation(root);
  assert.equal(failure.code, 1);
  assert.match(failure.stderr, /BACKUP_V2_OPERATIONAL_CONFIRMATION_REQUIRED/);
  assert.doesNotMatch(failure.stderr, /SUPABASE_DB_URL=|SERVICE_ROLE|postgresql:\/\//);

  process.stdout.write(`${JSON.stringify({
    budgetBlocked: "PASS",
    b2ReadbackFailure: "PASS_INHERITED_CORE_GATE",
    b2ShaMismatch: "PASS_INHERITED_CORE_GATE",
    concurrentRunner: "PASS",
    failureExitCodes: "PASS",
    latestTwoProtection: "PASS",
    logInjection: "PASS",
    partialStatusWrite: "PASS",
    pinnedGenerationProtection: "PASS",
    retentionDryRun: "PASS",
    schedulerCommandConstruction: "PASS",
    schedulerCommandSecretScan: "PASS",
    schedulerWrongDirectory: "PASS",
    singleInstance: "PASS",
    staleLockRecovery: "PASS",
    statusAtomicity: "PASS",
  })}\n`);
} finally {
  await rm(root, { recursive: true, force: true });
}
