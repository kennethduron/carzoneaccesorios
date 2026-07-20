import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { allPermissions, rolePermissions } from "../src/lib/auth/permissions.ts";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") {
  throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required for the disposable PostgreSQL test.");
}

const accountingPermissions = [
  "accounting:read",
  "accounting:create",
  "accounting:post",
  "accounting:manage",
  "accounting:reverse",
  "accounting:export",
  "accounting:settings",
  "accounting:close_period",
  "accounting:reopen_period",
  "accounting:view_reports",
];
const unrelatedPermissions = [
  "products:manage",
  "inventory:manage",
  "users:read",
  "users:create",
  "users:manage",
  "roles:assign",
  "roles:assign_admin",
  "roles:assign_operational",
  "security:read",
  "security:manage",
  "system:monitoring",
  "system:backups",
  "technical:tools",
  "settings:manage",
  "commercial_settings:manage",
];

for (const role of ["technical_owner", "business_owner", "admin", "contadora"]) {
  const permissions = role === "technical_owner" ? allPermissions : rolePermissions[role];
  for (const permission of accountingPermissions) {
    assert.equal(permissions.includes(permission), true, role + " must have " + permission);
  }
}
for (const permission of unrelatedPermissions) {
  assert.equal(rolePermissions.contadora.includes(permission), false, "contadora must not gain " + permission);
}

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const migration = read("supabase/migrations/202607200003_grant_contadora_accounting_management.sql");
const seed = read("supabase/seed/seed.sql");
const accountingPage = read("src/app/admin/contabilidad/page.tsx");
const accountingActions = read("src/app/admin/contabilidad/actions.ts");
const financialCenter = read("src/components/admin/financial-center-manager.tsx");
const periodPage = read("src/app/admin/periodos-contables/page.tsx");
const periodActions = read("src/app/admin/periodos-contables/actions.ts");
const accountingSchema = read("supabase/migrations/202606250002_accounting_phase_1.sql");
const financialSchema = read("supabase/migrations/202606260001_financial_center_phase_2a.sql");
const reopeningSchema = read("supabase/migrations/202607080001_phase_2i3_controlled_period_reopening.sql");

assert.match(accountingPage, /requirePermission\("accounting:read"\)/);
assert.match(accountingPage, /"accounting:settings"/);
assert.match(accountingPage, /"accounting:reverse"/);
assert.match(accountingActions, /saveAccountingMappingAction[\s\S]*requirePermission\("accounting:settings"\)/);
assert.match(accountingActions, /toggleAccountingMappingAction[\s\S]*requirePermission\("accounting:settings"\)/);
assert.match(accountingActions, /updateAutomationModeAction[\s\S]*requirePermission\("accounting:settings"\)/);
assert.match(accountingActions, /saveAccountingAccountAction[\s\S]*requirePermission\("accounting:manage"\)[\s\S]*requirePermission\("accounting:create"\)/);
assert.match(accountingActions, /saveJournalDraftAction[\s\S]*requirePermission\("accounting:create"\)/);
assert.match(accountingActions, /postJournalEntryAction[\s\S]*requirePermission\("accounting:post"\)/);
assert.match(accountingActions, /reverseJournalEntryAction[\s\S]*requirePermission\("accounting:reverse"\)/);
assert.match(financialCenter, /disabled=\{!canConfigureAccounting \|\| isPending\}/);
assert.match(financialCenter, /Tienes acceso de lectura\. No puedes crear ni editar mapeos contables\./);
assert.match(periodPage, /"accounting:reopen_period"/);
assert.match(periodActions, /hasEffectivePermission\([\s\S]*"accounting:reopen_period"/);
assert.match(accountingSchema, /public\.has_permission\('accounting:settings'\)/);
assert.match(financialSchema, /public\.has_permission\('accounting:settings'\)/);
assert.match(reopeningSchema, /public\.has_permission\('accounting:reopen_period'\)/);
for (const permission of accountingPermissions) {
  assert.match(seed, new RegExp(permission.replace(":", "\\:")));
}
assert.match(migration, /where name = 'contadora'/);
assert.doesNotMatch(migration, /where name (?:like|ilike|in)\b/i);
for (const permission of ["accounting:reverse", "accounting:settings", "accounting:reopen_period"]) {
  assert.match(migration, new RegExp(permission.replace(":", "\\:")));
}
for (const table of ["products", "product_images", "inventory_movements", "journal_entries", "journal_entry_lines", "accounting_accounts", "accounting_mappings", "accounting_automation_settings"]) {
  assert.doesNotMatch(migration, new RegExp("(?:insert\\s+into|update|delete\\s+from)\\s+public\\." + table, "i"));
}

const container = "car-zone-accounting-access-" + process.pid;
assert.match(container, /^car-zone-accounting-access-\d+$/);
const accountantId = randomUUID();
const sellerId = randomUUID();

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60000,
    ...options,
  }).trim();
}

function psql(sql) {
  return docker(
    ["exec", "-i", container, "psql", "-q", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"],
    { input: sql },
  );
}

const initialAccounting = accountingPermissions.filter(
  (permission) => !["accounting:reverse", "accounting:settings", "accounting:reopen_period"].includes(permission),
);
const setupSql = [
  "do $$ begin create role authenticated; exception when duplicate_object then null; end $$;",
  "create schema auth;",
  "create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;",
  "create table public.roles (name text primary key, permissions jsonb not null default '[]'::jsonb);",
  "create table public.profiles (id uuid primary key, role text not null references public.roles(name));",
  "create table public.products (id integer primary key);",
  "create table public.product_images (id integer primary key);",
  "create table public.inventory_movements (id integer primary key);",
  "create table public.journal_entries (id integer primary key);",
  "create table public.journal_entry_lines (id integer primary key);",
  "create table public.accounting_accounts (id integer primary key);",
  "create table public.accounting_mappings (id integer generated always as identity primary key, label text not null);",
  "create table public.accounting_automation_settings (id integer primary key, enabled boolean not null);",
  "insert into public.roles values ('contadora', '" + JSON.stringify(["products:adjust_stock", ...initialAccounting]) + "'::jsonb), ('contadora_aux', '[\"accounting:read\"]'::jsonb), ('vendedor', '[\"accounting:read\"]'::jsonb);",
  "insert into public.profiles values ('" + accountantId + "', 'contadora'), ('" + sellerId + "', 'vendedor');",
  "insert into public.products values (1);",
  "insert into public.product_images values (1);",
  "insert into public.inventory_movements values (1);",
  "insert into public.journal_entries values (1);",
  "insert into public.journal_entry_lines values (1);",
  "insert into public.accounting_accounts values (1);",
  "insert into public.accounting_mappings(label) values ('existing');",
  "insert into public.accounting_automation_settings values (1, false);",
  "create function public.has_permission(permission_key text) returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from public.profiles p join public.roles r on r.name=p.role where p.id=auth.uid() and r.permissions ? permission_key) $$;",
  "alter table public.accounting_mappings enable row level security;",
  "create policy accounting_settings_write on public.accounting_mappings for insert with check (public.has_permission('accounting:settings'));",
  "grant usage on schema public, auth to authenticated;",
  "grant insert on public.accounting_mappings to authenticated;",
  "grant usage, select on sequence public.accounting_mappings_id_seq to authenticated;",
].join("\n");

function dataSnapshot() {
  return psql("select jsonb_build_object(" +
    "'products',(select count(*) from products)," +
    "'images',(select count(*) from product_images)," +
    "'movements',(select count(*) from inventory_movements)," +
    "'entries',(select count(*) from journal_entries)," +
    "'lines',(select count(*) from journal_entry_lines)," +
    "'accounts',(select count(*) from accounting_accounts)," +
    "'mappings',(select count(*) from accounting_mappings)," +
    "'automation',(select jsonb_agg(to_jsonb(s)) from accounting_automation_settings s)" +
    ")::text;");
}

function actorSql(userId, statement) {
  return [
    "begin;",
    "select set_config('request.jwt.claim.sub', '" + userId + "', true);",
    "set local role authenticated;",
    statement,
    "rollback;",
  ].join("\n");
}

let started = false;
try {
  docker(["run", "--rm", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=postgres", "postgres:17-alpine"]);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker(["exec", container, "pg_isready", "-U", "postgres"], { timeout: 5000 });
      ready = true;
      break;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
  }
  assert.equal(ready, true, "PostgreSQL container did not become ready");
  psql(setupSql);
  const beforeData = dataSnapshot();
  const similarBefore = psql("select permissions::text from roles where name='contadora_aux';");
  psql(migration);
  const firstXmin = psql("select xmin::text from roles where name='contadora';");
  psql(migration);
  const secondXmin = psql("select xmin::text from roles where name='contadora';");

  for (const permission of accountingPermissions) {
    assert.equal(psql("select (permissions ? '" + permission + "')::text from roles where name='contadora';"), "true");
  }
  for (const permission of ["accounting:reverse", "accounting:settings", "accounting:reopen_period"]) {
    assert.equal(psql("select count(*) from jsonb_array_elements_text((select permissions from roles where name='contadora')) value where value='" + permission + "';"), "1");
  }
  assert.equal(psql("select (permissions ? 'products:adjust_stock')::text from roles where name='contadora';"), "true");
  assert.equal(psql("select permissions::text from roles where name='contadora_aux';"), similarBefore);
  assert.equal(firstXmin, secondXmin, "second migration execution must not update the row physically");
  assert.equal(dataSnapshot(), beforeData, "migration must not modify business or accounting data");

  psql(actorSql(accountantId, "insert into public.accounting_mappings(label) values ('accountant allowed');"));
  assert.throws(
    () => psql(actorSql(sellerId, "insert into public.accounting_mappings(label) values ('seller denied');")),
    /row-level security|policy/i,
  );
} finally {
  if (started) {
    docker(["stop", container], { timeout: 30000 });
  }
}

console.log("Accountant accounting management checks passed.");
