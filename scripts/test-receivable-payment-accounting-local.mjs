import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";

const container = process.env.LOCAL_PG_DOCKER_CONTAINER ?? "supabase_db_car-zone-accesorios";
const allowedContainers = new Set(["supabase_db_car-zone-accesorios", "car-zone-schema-validation-local"]);
if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") {
  throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required.");
}
if (!allowedContainers.has(container) || container.includes("supabase.co")) {
  throw new Error("Only the approved local PostgreSQL container is allowed.");
}

const dockerArgs = ["exec", "-i", container, "psql", "-X", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-q"];

function runSql(sql, expectedFailure) {
  const result = spawnSync("docker", dockerArgs, { input: sql, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  if (expectedFailure) {
    assert.notEqual(result.status, 0, `Expected SQL failure but it passed: ${output}`);
    assert.match(output, expectedFailure);
    return output;
  }
  assert.equal(result.status, 0, output);
  return (result.stdout ?? "").trim();
}

function runSqlAsync(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", dockerArgs, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`${stdout}${stderr}`)));
    child.stdin.end(sql);
  });
}

const integrationSql = readFileSync("scripts/test-receivable-payment-accounting-local.sql", "utf8");
const integrationOutput = runSql(integrationSql);
const summaryLine = integrationOutput.split(/\r?\n/).findLast((line) => line.startsWith("{"));
assert.ok(summaryLine, integrationOutput);
const summary = JSON.parse(summaryLine);
assert.equal(summary.authorized_roles, 4);
assert.equal(summary.payments, 6);
assert.equal(summary.outboxes, 6);
assert.equal(summary.events, 6);
assert.equal(summary.drafts, 3);
assert.equal(summary.published, 1);
assert.equal(summary.global_mode_unchanged, true);

const concurrencyIds = {
  customer: "94600000-0000-4000-8000-000000000001",
  receivable: "94600000-0000-4000-8000-000000000002",
  payment: "94600000-0000-4000-8000-000000000003",
};
const cleanupSql = `
delete from public.accounting_outbox where source_id = '${concurrencyIds.payment}';
delete from public.accounts_receivable_payments where id = '${concurrencyIds.payment}';
delete from public.accounts_receivable where id = '${concurrencyIds.receivable}';
delete from public.customers where id = '${concurrencyIds.customer}';
`;

try {
  runSql(cleanupSql);
  runSql(`
    insert into public.customers (id, contact_name, business_name, active)
    values ('${concurrencyIds.customer}', 'RP Concurrency', 'RP Concurrency', true);
    insert into public.accounts_receivable (id, customer_id, original_amount, balance_due, due_date, status, historical_invoice_number)
    values ('${concurrencyIds.receivable}', '${concurrencyIds.customer}', 10, 10, current_date + 1, 'open', 'RP-CONCURRENCY');
    insert into public.accounts_receivable_payments (id, receivable_id, customer_id, amount, payment_method, received_at)
    values ('${concurrencyIds.payment}', '${concurrencyIds.receivable}', '${concurrencyIds.customer}', 1, 'cash', now());
  `);

  const locked = runSqlAsync(`begin; select id from public.accounting_outbox where source_id='${concurrencyIds.payment}' for update; select pg_sleep(2); rollback;`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const skipped = runSql(`
    begin;
    select set_config('request.jwt.claims', '{"role":"service_role"}', true);
    select public.process_receivable_payment_accounting_outbox_v1(
      (select id from public.accounting_outbox where source_id='${concurrencyIds.payment}'),
      'rp-concurrent-worker', false
    );
    rollback;
  `);
  await locked;
  const skippedJson = JSON.parse(skipped.split(/\r?\n/).findLast((line) => line.startsWith("{")));
  assert.equal(skippedJson.claimed, false);
  assert.equal(skippedJson.reason, "already_processing");
} finally {
  runSql(cleanupSql);
}

const residue = JSON.parse(runSql(`
  select jsonb_build_object(
    'fixture_users', (select count(*) from auth.users where email like 'rp-%@example.invalid'),
    'fixture_customers', (select count(*) from public.customers where business_name like 'RECEIVABLE_PAYMENT_ACCOUNTING_LOCAL%'),
    'concurrency_customer', (select count(*) from public.customers where id='${concurrencyIds.customer}'),
    'concurrency_receivable', (select count(*) from public.accounts_receivable where id='${concurrencyIds.receivable}'),
    'concurrency_payment', (select count(*) from public.accounts_receivable_payments where id='${concurrencyIds.payment}'),
    'concurrency_outbox', (select count(*) from public.accounting_outbox where source_id='${concurrencyIds.payment}')
  );
`));
assert.deepEqual(residue, {
  fixture_users: 0,
  fixture_customers: 0,
  concurrency_customer: 0,
  concurrency_receivable: 0,
  concurrency_payment: 0,
  concurrency_outbox: 0,
});

console.log("Receivable-payment local SQL integration checks passed.", { summary, residue });
