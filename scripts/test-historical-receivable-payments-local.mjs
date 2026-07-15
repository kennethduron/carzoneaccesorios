import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const PREFIX = "TEST-HISTORICAL-AR-LOCAL-20260714";
const container = process.env.LOCAL_PG_DOCKER_CONTAINER ?? "car-zone-schema-validation-local";
const dbHost = process.env.LOCAL_PG_HOST ?? "127.0.0.1";
const dbName = process.env.LOCAL_PG_DATABASE ?? "postgres";
const dbUser = process.env.LOCAL_PG_USER ?? "supabase_admin";
const dbPassword = process.env.LOCAL_PG_PASSWORD ?? "";

function refuse(message) {
  console.error(message);
  process.exit(1);
}

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") refuse("ALLOW_LOCAL_MUTATING_TESTS=true is required.");
if (!["127.0.0.1", "localhost"].includes(dbHost)) refuse("Only localhost/127.0.0.1 is allowed.");
if ([dbHost, dbName, dbUser, container].some((value) => value.includes(".supabase.co"))) refuse("Remote Supabase target detected.");
if (!["car-zone-schema-validation-local", "car-zone-phase-a-postgres"].includes(container)) refuse("Unexpected Docker container for local mutating test.");
if (!dbPassword || dbPassword.includes("supabase.co")) refuse("A temporary local DB password is required.");

const ids = {
  adminRole: randomUUID(),
  deniedRole: randomUUID(),
  actor: randomUUID(),
  deniedActor: randomUUID(),
  normalCustomer: randomUUID(),
  historicalCustomer: randomUUID(),
  normalOrder: randomUUID(),
  normalPayment: randomUUID(),
  normalReceivable: randomUUID(),
  historicalReceivable: randomUUID(),
  rejectReceivable: randomUUID(),
  cancelledReceivable: randomUUID(),
  paidReceivable: randomUUID(),
  concurrentReceivable: randomUUID(),
};

const workDir = mkdtempSync(join(tmpdir(), "historical-ar-local-"));
const manifestPath = join(workDir, "manifest.json");
writeFileSync(manifestPath, JSON.stringify({ prefix: PREFIX, ids, cleanupComplete: false }, null, 2));

function psql(sql) {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "-e",
      `PGPASSWORD=${dbPassword}`,
      container,
      "psql",
      "-U",
      dbUser,
      "-d",
      dbName,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ],
    { input: sql, encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 15000 },
  ).trim();
}

async function psqlAsync(sql) {
  const { stdout } = await execFileAsync(
    "docker",
    [
      "exec",
      "-e",
      `PGPASSWORD=${dbPassword}`,
      container,
      "psql",
      "-U",
      dbUser,
      "-d",
      dbName,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-c",
      sql,
    ],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 30000 },
  );
  return stdout.trim();
}
function sqlLiteral(value) {
  return String(value).replaceAll("'", "''");
}

function sessionSql(actorId, statement) {
  return `
    begin;
    select set_config('request.jwt.claim.sub', '${actorId}', true);
    select set_config('request.jwt.claim.role', 'authenticated', true);
    select set_config('request.jwt.claims', jsonb_build_object('sub', '${actorId}', 'role', 'authenticated')::text, true);
    ${statement}
    commit;
  `;
}

function callPayment({ actorId = ids.actor, receivableId, amount, key, method = "bank_transfer", reference = "LOCAL-REF" }) {
  return psql(sessionSql(actorId, `
    select payment_id || '|' || receivable_status || '|' || balance_due || '|' || total_paid
    from public.register_credit_receivable_payment(
      '${receivableId}'::uuid,
      ${amount},
      '${sqlLiteral(method)}',
      '${sqlLiteral(reference)}',
      now(),
      '${PREFIX}',
      null,
      null,
      '${sqlLiteral(key)}'
    );
  `)).split(/\r?\n/).find((line) => line.includes("|"));
}

function expectReject(label, sql) {
  try {
    psql(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.doesNotMatch(message, /syntax error|SQLSTATE|duplicate key value violates unique constraint/i, label);
    return;
  }
  throw new Error(`Expected rejection did not occur: ${label}`);
}

function cleanup() {
  psql(`
    delete from public.email_queue where related_id = any(array['${ids.normalReceivable}','${ids.historicalReceivable}','${ids.rejectReceivable}','${ids.cancelledReceivable}','${ids.paidReceivable}','${ids.concurrentReceivable}']::uuid[]) or idempotency_key like '${PREFIX}%';
    delete from public.internal_notifications where metadata::text like '%${PREFIX}%' or order_id = '${ids.normalOrder}'::uuid or customer_id = any(array['${ids.normalCustomer}','${ids.historicalCustomer}']::uuid[]);
    delete from public.audit_logs where record_id = any(array['${ids.normalReceivable}','${ids.historicalReceivable}','${ids.rejectReceivable}','${ids.cancelledReceivable}','${ids.paidReceivable}','${ids.concurrentReceivable}']::uuid[]) or user_id = any(array['${ids.actor}','${ids.deniedActor}']::uuid[]);
    delete from public.accounts_receivable_payments where receivable_id = any(array['${ids.normalReceivable}','${ids.historicalReceivable}','${ids.rejectReceivable}','${ids.cancelledReceivable}','${ids.paidReceivable}','${ids.concurrentReceivable}']::uuid[]);
    delete from public.accounts_receivable where id = any(array['${ids.normalReceivable}','${ids.historicalReceivable}','${ids.rejectReceivable}','${ids.cancelledReceivable}','${ids.paidReceivable}','${ids.concurrentReceivable}']::uuid[]);
    delete from public.payments where id = '${ids.normalPayment}'::uuid or order_id = '${ids.normalOrder}'::uuid;
    delete from public.orders where id = '${ids.normalOrder}'::uuid;
    delete from public.customers where id = any(array['${ids.normalCustomer}','${ids.historicalCustomer}']::uuid[]);
    delete from public.users where id = any(array['${ids.actor}','${ids.deniedActor}']::uuid[]);
    delete from auth.users where id = any(array['${ids.actor}','${ids.deniedActor}']::uuid[]);
    delete from public.roles where id = any(array['${ids.adminRole}','${ids.deniedRole}']::uuid[]);
  `);
}

try {
  cleanup();

  psql(`
    insert into public.roles (id, name, description, permissions) values
      ('${ids.adminRole}', 'admin', '${PREFIX}', '["credit:mark_paid"]'::jsonb),
      ('${ids.deniedRole}', 'vendedor', '${PREFIX}', '[]'::jsonb);

    insert into auth.users (id, aud, role, email, confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at) values
      ('${ids.actor}', 'authenticated', 'authenticated', '${PREFIX.toLowerCase()}-admin@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now()),
      ('${ids.deniedActor}', 'authenticated', 'authenticated', '${PREFIX.toLowerCase()}-denied@example.invalid', now(), '{}'::jsonb, '{}'::jsonb, now(), now());

    insert into public.users (id, role_id, full_name, email, active) values
      ('${ids.actor}', '${ids.adminRole}', '${PREFIX} Admin', '${PREFIX.toLowerCase()}-admin@example.invalid', true),
      ('${ids.deniedActor}', '${ids.deniedRole}', '${PREFIX} Denied', '${PREFIX.toLowerCase()}-denied@example.invalid', true);

    insert into public.customers (id, contact_name, business_name, email, phone, active, user_id) values
      ('${ids.normalCustomer}', '${PREFIX} Normal', '${PREFIX} Normal Business', null, '22220000', true, null),
      ('${ids.historicalCustomer}', '${PREFIX} Historical', '${PREFIX} Historical Business', null, '22220001', true, null);

    insert into public.orders (id, order_number, customer_id, customer_name, email, phone, customer_phone, delivery_address, payment_method, price_mode, subtotal, tax, total, status)
    values ('${ids.normalOrder}', '${PREFIX}-ORDER-001', '${ids.normalCustomer}', '${PREFIX} Normal', null, '22220000', '22220000', '${PREFIX} Local', 'commercial_credit', 'retail', 10000, 0, 10000, 'entregado');

    insert into public.payments (id, order_id, customer_id, method, payment_method, status, payment_status, amount)
    values ('${ids.normalPayment}', '${ids.normalOrder}', '${ids.normalCustomer}', 'commercial_credit', 'commercial_credit', 'pending', 'pending', 10000);

    insert into public.accounts_receivable (id, customer_id, order_id, invoice_id, original_amount, balance_due, due_date, status, historical_invoice_number, paid_at, payment_received_method) values
      ('${ids.normalReceivable}', '${ids.normalCustomer}', '${ids.normalOrder}', null, 10000, 10000, current_date + 15, 'open', null, null, null),
      ('${ids.historicalReceivable}', '${ids.historicalCustomer}', null, null, 12000, 12000, current_date + 15, 'open', '${PREFIX}-HIST-001', null, null),
      ('${ids.rejectReceivable}', '${ids.historicalCustomer}', null, null, 1000, 1000, current_date + 15, 'open', '${PREFIX}-REJECT', null, null),
      ('${ids.cancelledReceivable}', '${ids.historicalCustomer}', null, null, 1000, 0, current_date + 15, 'cancelled', '${PREFIX}-CANCELLED', null, null),
      ('${ids.paidReceivable}', '${ids.historicalCustomer}', null, null, 1000, 0, current_date + 15, 'paid', '${PREFIX}-PAID', now(), 'bank_transfer'),
      ('${ids.concurrentReceivable}', '${ids.historicalCustomer}', null, null, 1000, 1000, current_date + 15, 'open', '${PREFIX}-CONCURRENT', null, null);
  `);

  assert.match(callPayment({ receivableId: ids.normalReceivable, amount: 2000, key: `${PREFIX}-normal-1` }), /\|partial\|8000\.00\|2000\.00$/);
  assert.match(callPayment({ receivableId: ids.normalReceivable, amount: 3000, key: `${PREFIX}-normal-2` }), /\|partial\|5000\.00\|5000\.00$/);
  assert.match(callPayment({ receivableId: ids.normalReceivable, amount: 5000, key: `${PREFIX}-normal-3` }), /\|paid\|0\.00\|10000\.00$/);

  assert.match(callPayment({ receivableId: ids.historicalReceivable, amount: 2500, key: `${PREFIX}-hist-1` }), /\|partial\|9500\.00\|2500\.00$/);
  assert.match(callPayment({ receivableId: ids.historicalReceivable, amount: 3500, key: `${PREFIX}-hist-2` }), /\|partial\|6000\.00\|6000\.00$/);
  assert.match(callPayment({ receivableId: ids.historicalReceivable, amount: 6000, key: `${PREFIX}-hist-3` }), /\|paid\|0\.00\|12000\.00$/);

  expectReject("zero amount", sessionSql(ids.actor, `select * from public.register_credit_receivable_payment('${ids.rejectReceivable}', 0, 'bank_transfer', null, now(), '${PREFIX}', null, null, '${PREFIX}-reject-zero');`));
  expectReject("negative amount", sessionSql(ids.actor, `select * from public.register_credit_receivable_payment('${ids.rejectReceivable}', -1, 'bank_transfer', null, now(), '${PREFIX}', null, null, '${PREFIX}-reject-negative');`));
  expectReject("overpay", sessionSql(ids.actor, `select * from public.register_credit_receivable_payment('${ids.rejectReceivable}', 1001, 'bank_transfer', null, now(), '${PREFIX}', null, null, '${PREFIX}-reject-overpay');`));
  expectReject("missing receivable", sessionSql(ids.actor, `select * from public.register_credit_receivable_payment('${randomUUID()}', 1, 'bank_transfer', null, now(), '${PREFIX}', null, null, '${PREFIX}-reject-missing');`));
  expectReject("cancelled receivable", sessionSql(ids.actor, `select * from public.register_credit_receivable_payment('${ids.cancelledReceivable}', 1, 'bank_transfer', null, now(), '${PREFIX}', null, null, '${PREFIX}-reject-cancelled');`));
  expectReject("paid receivable", sessionSql(ids.actor, `select * from public.register_credit_receivable_payment('${ids.paidReceivable}', 1, 'bank_transfer', null, now(), '${PREFIX}', null, null, '${PREFIX}-reject-paid');`));
  expectReject("denied user", sessionSql(ids.deniedActor, `select * from public.register_credit_receivable_payment('${ids.rejectReceivable}', 1, 'bank_transfer', null, now(), '${PREFIX}', null, null, '${PREFIX}-reject-denied');`));

  const once = callPayment({ receivableId: ids.rejectReceivable, amount: 100, key: `${PREFIX}-idem` });
  const twice = callPayment({ receivableId: ids.rejectReceivable, amount: 100, key: `${PREFIX}-idem` });
  assert.equal(once, twice);

  const sameKeySql = sessionSql(ids.actor, `
    select payment_id || '|' || receivable_status || '|' || balance_due || '|' || total_paid
    from public.register_credit_receivable_payment('${ids.concurrentReceivable}', 100, 'bank_transfer', null, now(), '${PREFIX}', null, null, '${PREFIX}-concurrent-same');
  `);
  const sameKeyResults = await Promise.allSettled([psqlAsync(sameKeySql), psqlAsync(sameKeySql)]);
  assert.equal(sameKeyResults.filter((item) => item.status === "fulfilled").length, 2);
  assert.equal(Number(psql(`select count(*) from public.accounts_receivable_payments where receivable_id='${ids.concurrentReceivable}' and idempotency_key='${PREFIX}-concurrent-same';`)), 1);
  assert.equal(psql(`select balance_due::text from public.accounts_receivable where id='${ids.concurrentReceivable}';`), "900.00");

  const distinctResults = await Promise.allSettled([
    psqlAsync(sessionSql(ids.actor, `select * from public.register_credit_receivable_payment('${ids.concurrentReceivable}', 200, 'bank_transfer', null, now(), '${PREFIX}', null, null, '${PREFIX}-concurrent-a');`)),
    psqlAsync(sessionSql(ids.actor, `select * from public.register_credit_receivable_payment('${ids.concurrentReceivable}', 300, 'bank_transfer', null, now(), '${PREFIX}', null, null, '${PREFIX}-concurrent-b');`)),
  ]);
  assert.equal(distinctResults.filter((item) => item.status === "fulfilled").length, 2);
  assert.equal(psql(`select balance_due::text from public.accounts_receivable where id='${ids.concurrentReceivable}';`), "400.00");
  const summary = psql(`
    select jsonb_build_object(
      'normalPayments', (select count(*) from public.accounts_receivable_payments where receivable_id='${ids.normalReceivable}'),
      'historicalPayments', (select count(*) from public.accounts_receivable_payments where receivable_id='${ids.historicalReceivable}' and order_id is null),
      'ordersCreatedForHistorical', (select count(*) from public.orders where customer_id='${ids.historicalCustomer}'),
      'creditAccountsCreated', (select count(*) from public.customer_credit_accounts where customer_id='${ids.historicalCustomer}'),
      'auditRows', (select count(*) from public.audit_logs where record_id = any(array['${ids.normalReceivable}','${ids.historicalReceivable}']::uuid[])),
      'notifications', (select count(*) from public.internal_notifications where metadata::text like '%${PREFIX}%'),
      'emailRows', (select count(*) from public.email_queue where idempotency_key like '${PREFIX}%'),
      'journalEntries', (select count(*) from public.journal_entries where source_id like '${PREFIX}%'),
      'normalPaymentStatus', (select payment_status::text from public.payments where id='${ids.normalPayment}')
    );
  `);
  const parsed = JSON.parse(summary);
  assert.equal(parsed.normalPayments, 3);
  assert.equal(parsed.historicalPayments, 3);
  assert.equal(parsed.ordersCreatedForHistorical, 0);
  assert.equal(parsed.creditAccountsCreated, 0);
  assert.ok(parsed.auditRows >= 2);
  assert.ok(parsed.notifications >= 1);
  assert.equal(parsed.emailRows, 0);
  assert.equal(parsed.journalEntries, 0);
  assert.equal(parsed.normalPaymentStatus, "approved");

  cleanup();
  const leftovers = JSON.parse(psql(`
    select jsonb_build_object(
      'authUsers', (select count(*) from auth.users where id = any(array['${ids.actor}','${ids.deniedActor}']::uuid[])),
      'users', (select count(*) from public.users where id = any(array['${ids.actor}','${ids.deniedActor}']::uuid[])),
      'customers', (select count(*) from public.customers where id = any(array['${ids.normalCustomer}','${ids.historicalCustomer}']::uuid[])),
      'orders', (select count(*) from public.orders where id='${ids.normalOrder}'::uuid),
      'receivables', (select count(*) from public.accounts_receivable where id = any(array['${ids.normalReceivable}','${ids.historicalReceivable}','${ids.rejectReceivable}','${ids.cancelledReceivable}','${ids.paidReceivable}','${ids.concurrentReceivable}']::uuid[])),
      'payments', (select count(*) from public.accounts_receivable_payments where receivable_id = any(array['${ids.normalReceivable}','${ids.historicalReceivable}','${ids.rejectReceivable}','${ids.cancelledReceivable}','${ids.paidReceivable}','${ids.concurrentReceivable}']::uuid[])),
      'roles', (select count(*) from public.roles where id = any(array['${ids.adminRole}','${ids.deniedRole}']::uuid[]))
    );
  `));
  assert.deepEqual(leftovers, { authUsers: 0, users: 0, customers: 0, orders: 0, receivables: 0, payments: 0, roles: 0 });

  writeFileSync(manifestPath, JSON.stringify({ prefix: PREFIX, ids, cleanupComplete: true }, null, 2));
  rmSync(workDir, { recursive: true, force: true });
  console.log("Historical receivable local integration checks passed.", parsed);
} catch (error) {
  try {
    cleanup();
  } catch (cleanupError) {
    const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
    console.error("Cleanup failed:", cleanupMessage.replaceAll(dbPassword, "[LOCAL_DB_PASSWORD_REDACTED]"));
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.replaceAll(dbPassword, "[LOCAL_DB_PASSWORD_REDACTED]"));
  console.error(`Manifest retained at ${manifestPath}`);
  process.exit(1);
}
