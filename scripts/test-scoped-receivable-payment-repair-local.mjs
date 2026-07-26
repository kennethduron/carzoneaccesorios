import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const container = process.env.LOCAL_PG_DOCKER_CONTAINER ?? "supabase_db_car-zone-accesorios";
if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") {
  throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required.");
}
if (!new Set(["supabase_db_car-zone-accesorios", "car-zone-schema-validation-local"]).has(container)) {
  throw new Error("Only an approved local PostgreSQL container is allowed.");
}

const id = {
  user: null,
  customer: "95100000-0000-4000-8000-000000000002",
  receivableA: "95100000-0000-4000-8000-000000000003",
  receivableB: "95100000-0000-4000-8000-000000000004",
  paymentA: "95100000-0000-4000-8000-000000000005",
  paymentB: "95100000-0000-4000-8000-000000000006",
  eventA: "95100000-0000-4000-8000-000000000007",
  eventB: "95100000-0000-4000-8000-000000000008",
  control: "95100000-0000-4000-8000-000000000009",
  debit: "95100000-0000-4000-8000-000000000010",
  credit: "95100000-0000-4000-8000-000000000011",
  debitMap: "95100000-0000-4000-8000-000000000012",
  creditMap: "95100000-0000-4000-8000-000000000013",
  period: "95100000-0000-4000-8000-000000000014",
};

function sql(statement) {
  const result = spawnSync("docker", [
    "exec", "-i", container, "psql", "-X", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-At", "-q",
  ], { input: statement, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  assert.equal(result.status, 0, output);
  return (result.stdout ?? "").trim();
}

function supabaseEnvironment() {
  const result = spawnSync(
    "cmd.exe",
    ["/d", "/s", "/c", "npx.cmd supabase status -o env"],
    { encoding: "utf8", windowsHide: true, timeout: 120_000 },
  );
  assert.equal(result.status, 0, `${result.stdout ?? ""}${result.stderr ?? ""}`);
  const values = {};
  for (const line of (result.stdout ?? "").split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(?:"(.*)"|(.*))$/.exec(line.trim());
    if (match) values[match[1]] = match[2] ?? match[3] ?? "";
  }
  for (const name of ["API_URL", "ANON_KEY", "SERVICE_ROLE_KEY"]) {
    assert.ok(values[name], `Missing local Supabase ${name}.`);
  }
  return values;
}

function repair(args, env, expectedStatus = 0) {
  const result = spawnSync(
    "node",
    ["scripts/accounting/repair-missing-receivable-payment-events.mjs", ...args],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
      env: {
        ...process.env,
        NEXT_PUBLIC_SUPABASE_URL: env.API_URL,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: env.ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: env.SERVICE_ROLE_KEY,
        SUPABASE_REPAIR_ACTOR_ACCESS_TOKEN: env.actorToken,
        RECEIVABLE_PAYMENT_REPAIR_CONFIRM: env.confirmation ?? "",
      },
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  assert.equal(result.status, expectedStatus, output);
  return output;
}

const cleanup = `
delete from public.accounting_event_log
where source_id in ('${id.paymentA}','${id.paymentB}')
   or entity_id in ('${id.eventA}','${id.eventB}','${id.control}');
delete from public.accounting_outbox where source_id in ('${id.paymentA}','${id.paymentB}');
delete from public.journal_entry_lines where journal_entry_id in (
  select id from public.journal_entries
  where source_type='financial_event' and source_id in ('${id.eventA}','${id.eventB}')
);
delete from public.journal_entries
where source_type='financial_event' and source_id in ('${id.eventA}','${id.eventB}');
delete from public.financial_events where id in ('${id.eventA}','${id.eventB}','${id.control}');
delete from public.accounts_receivable_payments where id in ('${id.paymentA}','${id.paymentB}');
delete from public.accounts_receivable where id in ('${id.receivableA}','${id.receivableB}');
delete from public.accounting_mappings where id in ('${id.debitMap}','${id.creditMap}');
delete from public.accounting_periods where id='${id.period}';
delete from public.accounting_accounts where id in ('${id.debit}','${id.credit}');
delete from public.customers where id='${id.customer}';
delete from auth.users where email='rp-scope@example.invalid';
`;

try {
  sql(cleanup);
  const env = supabaseEnvironment();
  const admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: "rp-scope@example.invalid",
    password: "ScopeLocalPass123!",
    email_confirm: true,
    user_metadata: { full_name: "RP Scope" },
  });
  assert.ifError(createError);
  assert.ok(created.user?.id);
  id.user = created.user.id;

  sql(`
update public.users actor set role_id=role_row.id,active=true
from public.roles role_row
where actor.id='${id.user}' and role_row.name='technical_owner';
insert into public.customers (id,contact_name,business_name,active)
values ('${id.customer}','RP Scope','RECEIVABLE_PAYMENT_SCOPE_LOCAL',true);
insert into public.accounts_receivable (
  id,customer_id,original_amount,balance_due,due_date,status,historical_invoice_number
) values
  ('${id.receivableA}','${id.customer}',200,200,'2026-07-31','open','RP-SCOPE-A'),
  ('${id.receivableB}','${id.customer}',300,300,'2026-07-31','open','RP-SCOPE-B');
insert into public.accounting_accounts (id,code,name,type,normal_balance,is_active) values
  ('${id.debit}','RP-SCOPE-BANK','RP Scope Bank','asset','debit',true),
  ('${id.credit}','RP-SCOPE-AR','RP Scope Receivable','asset','debit',true);
insert into public.accounting_mappings (id,mapping_type,source_key,account_id,priority,is_active) values
  ('${id.debitMap}','payment_method','bank_transfer','${id.debit}',1,true),
  ('${id.creditMap}','receivable','accounts_receivable','${id.credit}',1,true);
insert into public.accounts_receivable_payments (
  id,receivable_id,customer_id,amount,payment_method,received_at,recorded_by
) values
  ('${id.paymentA}','${id.receivableA}','${id.customer}',11340,'bank_transfer','2026-07-11 10:00:00-06','${id.user}'),
  ('${id.paymentB}','${id.receivableB}','${id.customer}',50,'bank_transfer','2026-07-12 10:00:00-06','${id.user}');
delete from public.accounting_outbox where source_id in ('${id.paymentA}','${id.paymentB}');
insert into public.financial_events (
  id,source_type,source_id,event_purpose,posting_version,status,occurred_at,
  source_snapshot,validation_errors,created_by
) values
  ('${id.eventA}','receivable_payment','${id.paymentA}','receivable_payment','v1','pending',
   '2026-07-11 10:00:00-06','{"event_type":"receivable_payment_received","amount":11340}','[]','${id.user}'),
  ('${id.eventB}','receivable_payment','${id.paymentB}','receivable_payment','v1','pending',
   '2026-07-12 10:00:00-06','{"event_type":"receivable_payment_received","amount":50}','[]','${id.user}'),
  ('${id.control}','accounts_receivable','${id.receivableA}','receivable_paid','v1','skipped',
   '2026-07-11 10:00:00-06','{"event_type":"receivable_paid"}','[]','${id.user}');
`);

  const auth = createClient(env.API_URL, env.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: signIn, error: signInError } = await auth.auth.signInWithPassword({
    email: "rp-scope@example.invalid",
    password: "ScopeLocalPass123!",
  });
  assert.ifError(signInError);
  assert.ok(signIn.session?.access_token);
  env.actorToken = signIn.session.access_token;

  const preview = repair([`--payment-id=${id.paymentA}`], env);
  assert.match(preview, /"selected_records": 1/);
  assert.match(preview, /"required": true/);
  assert.match(preview, /"global_collection": false/);
  assert.match(
    repair(["--payment-id=95100000-0000-4000-8000-000000000099"], env),
    /Abono no encontrado\. Cero modificaciones\./,
  );

  const applyArgs = [
    "--apply", `--payment-id=${id.paymentA}`, `--expected-event-id=${id.eventA}`,
    "--expected-amount=11340.00", "--expected-date=2026-07-11",
    "--expected-method=bank_transfer",
  ];
  assert.match(repair(applyArgs, env, 1), /Para aplicar se requiere/);
  const applied = repair(
    applyArgs,
    { ...env, confirmation: "APPLY_RECEIVABLE_PAYMENT_REPAIR" },
  );
  assert.match(applied, /"existing_event_reused": true/);
  assert.match(applied, /"journal_status": "borrador"/);
  assert.match(applied, /"published_entries": 0/);

  const afterPreview = repair([`--payment-id=${id.paymentA}`], env);
  assert.match(afterPreview, /"required": false/);
  assert.match(afterPreview, /"action": "none"/);
  assert.match(
    repair(
      applyArgs,
      { ...env, confirmation: "APPLY_RECEIVABLE_PAYMENT_REPAIR" },
      1,
    ),
    /ya tiene una partida vinculada/i,
  );

  const result = JSON.parse(sql(`
select jsonb_build_object(
  'a_payment',(select count(*) from public.accounts_receivable_payments where id='${id.paymentA}'),
  'a_event',(select count(*) from public.financial_events where id='${id.eventA}'),
  'a_outbox',(select count(*) from public.accounting_outbox where source_id='${id.paymentA}' and status='completed' and last_error is null),
  'a_draft',(select count(*) from public.journal_entries where source_type='financial_event' and source_id='${id.eventA}' and status='borrador' and posted_at is null),
  'a_debit',(select coalesce(sum(line.debit),0) from public.journal_entry_lines line join public.journal_entries entry on entry.id=line.journal_entry_id where entry.source_id='${id.eventA}'),
  'a_credit',(select coalesce(sum(line.credit),0) from public.journal_entry_lines line join public.journal_entries entry on entry.id=line.journal_entry_id where entry.source_id='${id.eventA}'),
  'a_audit',(select count(*) from public.accounting_event_log where source_id='${id.paymentA}'),
  'control',(select count(*) from public.financial_events where id='${id.control}' and status='skipped' and journal_entry_id is null),
  'b_payment',(select count(*) from public.accounts_receivable_payments where id='${id.paymentB}'),
  'b_event',(select count(*) from public.financial_events where id='${id.eventB}' and journal_entry_id is null),
  'b_outbox',(select count(*) from public.accounting_outbox where source_id='${id.paymentB}'),
  'b_journal',(select count(*) from public.journal_entries where source_id='${id.eventB}'),
  'b_audit',(select count(*) from public.accounting_event_log where source_id='${id.paymentB}'),
  'a_balance',(select balance_due from public.accounts_receivable where id='${id.receivableA}'),
  'b_balance',(select balance_due from public.accounts_receivable where id='${id.receivableB}')
);
`));
  assert.deepEqual(result, {
    a_payment: 1, a_event: 1, a_outbox: 1, a_draft: 1,
    a_debit: 11340, a_credit: 11340, a_audit: 2, control: 1,
    b_payment: 1, b_event: 1, b_outbox: 0, b_journal: 0, b_audit: 0,
    a_balance: 200, b_balance: 300,
  });
  console.log("Scoped local repair isolation checks passed.", result);
} finally {
  sql(cleanup);
}

const residue = JSON.parse(sql(`
select jsonb_build_object(
  'payments',(select count(*) from public.accounts_receivable_payments where id in ('${id.paymentA}','${id.paymentB}')),
  'events',(select count(*) from public.financial_events where id in ('${id.eventA}','${id.eventB}','${id.control}')),
  'outbox',(select count(*) from public.accounting_outbox where source_id in ('${id.paymentA}','${id.paymentB}')),
  'receivables',(select count(*) from public.accounts_receivable where id in ('${id.receivableA}','${id.receivableB}')),
  'customer',(select count(*) from public.customers where id='${id.customer}'),
  'actor',(select count(*) from auth.users where email='rp-scope@example.invalid')
);
`));
assert.deepEqual(residue, {
  payments: 0, events: 0, outbox: 0, receivables: 0, customer: 0, actor: 0,
});
console.log("Scoped local repair fixtures cleaned.", residue);
