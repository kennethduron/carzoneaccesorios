import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

assert.equal(
  process.env.ALLOW_LOCAL_MUTATING_TESTS,
  "true",
  "ALLOW_LOCAL_MUTATING_TESTS=true is required for the disposable PostgreSQL test.",
);

const execAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const preludePath = new URL("scripts/fixtures/invoice-commercial-reversal-prelude.sql", root);
const migrationPath = new URL("supabase/migrations/202608170001_full_invoice_commercial_reversal.sql", root);
const adminRecoveryMigrationPath = new URL("supabase/migrations/202608170002_full_invoice_reversal_admin_recovery.sql", root);
const fixturePath = new URL("scripts/fixtures/invoice-commercial-reversal-local.sql", root);
const protectedProductionRef = "mbowrapstbufzzfefipn";
const runId = randomUUID().replaceAll("-", "").slice(0, 12);
const container = `carzone-invoice-reversal-test-${runId}`;
const password = `local-only-${runId}`;
const database = "postgres";

assert.match(container, /^carzone-invoice-reversal-test-[a-f0-9]{12}$/);
assert.equal(
  Object.values(process.env).some((value) => String(value ?? "").includes(protectedProductionRef)),
  false,
  "Protected production project reference detected; local mutating test denied.",
);

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 30 * 1024 * 1024,
    windowsHide: true,
    ...options,
  }).trim();
}

function psqlArgs(sql) {
  return [
    "exec", container, "psql", "-U", "postgres", "-d", database,
    "-At", "-v", "ON_ERROR_STOP=1", "-c", sql,
  ];
}

async function waitForPostgres() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      docker(["exec", container, "pg_isready", "-U", "postgres", "-d", "postgres"], { timeout: 5_000 });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("Disposable PostgreSQL did not become ready.");
}

let containerCreated = false;
try {
  const existing = docker(["ps", "-a", "--filter", `name=^${container}$`, "--format", "{{.Names}}"]);
  assert.equal(existing, "", "Disposable container name collision.");
  docker([
    "run", "--name", container, "--network", "none",
    "-e", `POSTGRES_PASSWORD=${password}`, "-d",
    "postgres:17-alpine",
  ]);
  containerCreated = true;
  await waitForPostgres();

  docker(["cp", preludePath.pathname.replace(/^\/(.:)/, "$1"), `${container}:/tmp/prelude.sql`]);
  docker(["cp", migrationPath.pathname.replace(/^\/(.:)/, "$1"), `${container}:/tmp/reversal.sql`]);
  docker(["cp", adminRecoveryMigrationPath.pathname.replace(/^\/(.:)/, "$1"), `${container}:/tmp/admin-recovery.sql`]);
  docker(["cp", fixturePath.pathname.replace(/^\/(.:)/, "$1"), `${container}:/tmp/reversal-test.sql`]);
  docker([
    "exec", container, "psql", "-U", "postgres", "-d", database,
    "-v", "ON_ERROR_STOP=1", "-f", "/tmp/prelude.sql",
  ]);
  docker([
    "exec", container, "psql", "-U", "postgres", "-d", database,
    "-v", "ON_ERROR_STOP=1", "-f", "/tmp/reversal.sql",
  ]);
  docker([
    "exec", container, "psql", "-U", "postgres", "-d", database,
    "-v", "ON_ERROR_STOP=1", "-f", "/tmp/admin-recovery.sql",
  ]);
  const fixtureOutput = docker([
    "exec", container, "psql", "-U", "postgres", "-d", database,
    "-v", "ON_ERROR_STOP=1", "-f", "/tmp/reversal-test.sql",
  ]);
  assert.match(fixtureOutput, /"atomic_rollback": "PASS"/);
  assert.match(fixtureOutput, /"reinvoice_flow": "PASS"/);
  assert.match(fixtureOutput, /"recovery_role_matrix": "PASS"/);
  assert.match(fixtureOutput, /"recovery_replay": "PASS"/);

  const raceSql = [
    "begin",
    "select set_config('request.jwt.claim.sub','10000000-0000-0000-0000-000000000002',true)",
    "select public.cancel_sale_invoice_v1('80000000-0000-0000-0000-000000000002','Concurrencia sintetica segura',false,null)->>'status'",
    "commit",
  ].join("; ");
  const raceArgs = psqlArgs(raceSql);
  const [first, second] = await Promise.all([
    execAsync("docker", raceArgs, { encoding: "utf8", windowsHide: true, timeout: 120_000 }),
    execAsync("docker", raceArgs, { encoding: "utf8", windowsHide: true, timeout: 120_000 }),
  ]);
  const statuses = [first.stdout, second.stdout].flatMap((text) =>
    text.split(/\r?\n/).map((line) => line.trim()).filter((line) =>
      line === "REVERSED" || line === "ALREADY_REVERSED"
    )
  ).sort();
  assert.deepEqual(statuses, ["ALREADY_REVERSED", "REVERSED"]);

  const concurrencyState = docker(psqlArgs(
    "select p.stock,(select count(*) from public.inventory_movements m where m.reversal_of_movement_id='80000000-0000-0000-0000-000000000005'),(select count(*) from public.invoice_commercial_reversals r where r.invoice_id='80000000-0000-0000-0000-000000000002') from public.products p where p.id='80000000-0000-0000-0000-000000000003'"
  ));
  assert.equal(concurrencyState, "4|1|1");

  const prohibitedCapabilities = readFileSync(fixturePath, "utf8");
  assert.ok(!/https:\/\//i.test(prohibitedCapabilities));
  assert.ok(!/service_role|SUPABASE_URL|production/i.test(prohibitedCapabilities));

  console.log("Invoice full commercial reversal local integration: PASS", {
    postgres: "17",
    network: "none",
    stock4To3To4: true,
    secondAnnulStays4: true,
    concurrentAnnulStays4: true,
    quantityGreaterThanOne: true,
    multiline: true,
    unpaidCredit: true,
    partialAndPaidDenied: true,
    accountingExactlyOnce: true,
    rollback: true,
    reinvoiceIndependentSale: true,
    recoveryRoleMatrix: true,
    recoveryReplayExactlyOnce: true,
    productionConnections: 0,
  });
} finally {
  if (containerCreated) {
    assert.match(container, /^carzone-invoice-reversal-test-[a-f0-9]{12}$/);
    try { docker(["rm", "-f", container], { timeout: 30_000 }); } catch { /* best-effort exact cleanup */ }
  }
}
