import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") {
  throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required for the disposable PostgreSQL test.");
}

const migration = readFileSync(new URL("../supabase/migrations/202607200004_secure_customer_identity_management.sql", import.meta.url), "utf8");
const container = `car-zone-customer-identity-${process.pid}`;
assert.match(container, /^car-zone-customer-identity-\d+$/);

const roleIds = Object.fromEntries(["technical_owner", "business_owner", "admin", "contadora", "vendedor", "soporte", "bodega", "cliente"].map((role) => [role, randomUUID()]));
const actorIds = Object.fromEntries(Object.keys(roleIds).map((role) => [role, randomUUID()]));
const clientTargets = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const inactiveTarget = randomUUID();
const internalTarget = randomUUID();
const editCustomers = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const linkCustomers = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const snapshotOrder = randomUUID();
const snapshotInvoice = randomUUID();
const snapshotReceivable = randomUUID();
const snapshotCrm = randomUUID();

function docker(args, options = {}) {
  return execFileSync("docker", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 60000, ...options }).trim();
}
function psql(sql) {
  return docker(["exec", "-i", container, "psql", "-q", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"], { input: sql });
}
function actorSql(actorId, statement, commit = true) {
  return psql([
    "begin;",
    "set local role authenticated;",
    `set local "request.jwt.claim.sub" = '${actorId}';`,
    statement,
    commit ? "commit;" : "rollback;",
  ].join("\n"));
}
function updatedAt(customerId) {
  return psql(`select updated_at::text from public.customers where id='${customerId}';`);
}
function editCall(actorId, customerId, overrides = {}) {
  const values = {
    business: "Empresa Editada",
    contact: "Contacto Editado",
    email: "ventas.editadas@example.invalid",
    phone: "9999-1111",
    tax: "08011999123456",
    city: "Tegucigalpa",
    expected: updatedAt(customerId),
    ...overrides,
  };
  const q = (value) => value === null ? "null" : `'${String(value).replaceAll("'", "''")}'`;
  return actorSql(actorId, `select status from public.update_customer_identity_manual('${customerId}', ${q(values.business)}, ${q(values.contact)}, ${q(values.email)}, ${q(values.phone)}, ${q(values.tax)}, ${q(values.city)}, ${q(values.expected)}::timestamptz, '127.0.0.1', 'customer-identity-test');`);
}
function linkCall(actorId, customerId, targetId, reason = "Identidad verificada en prueba aislada.") {
  return actorSql(actorId, `select status from public.link_customer_portal_account_manual('${customerId}', '${targetId}', '${reason}', true);`);
}
function businessSnapshot() {
  return psql("select jsonb_build_object(" +
    "'customers',(select jsonb_agg(to_jsonb(c) order by c.id) from customers c)," +
    "'orders',(select jsonb_agg(to_jsonb(o) order by o.id) from orders o)," +
    "'invoices',(select jsonb_agg(to_jsonb(i) order by i.id) from invoices i)," +
    "'receivables',(select jsonb_agg(to_jsonb(a) order by a.id) from accounts_receivable a)," +
    "'crm',(select jsonb_agg(to_jsonb(n) order by n.id) from crm_notes n)" +
    ")::text;");
}

const roleValues = Object.entries(roleIds).map(([name, id]) => {
  const permissions = ["technical_owner", "business_owner", "admin", "contadora"].includes(name) ? ["customers:link_portal_account"] : [];
  return `('${id}','${name}','${JSON.stringify(permissions)}'::jsonb)`;
}).join(",\n");
const authIds = [...Object.values(actorIds), ...clientTargets, inactiveTarget, internalTarget];
const authValues = authIds.map((id, index) => `('${id}','account-${index}@example.invalid',now(),now())`).join(",\n");
const actorUserValues = Object.entries(actorIds).map(([role, id], index) => `('${id}','${role}-${index}@example.invalid','Actor ${role}',null,true,'${roleIds[role]}')`).join(",\n");
const targetUserValues = [
  ...clientTargets.map((id, index) => `('${id}','client-${index}@example.invalid','Portal Client ${index}','+5049999000${index}',true,'${roleIds.cliente}')`),
  `('${inactiveTarget}','inactive@example.invalid','Inactive Client',null,false,'${roleIds.cliente}')`,
  `('${internalTarget}','internal@example.invalid','Internal Admin',null,true,'${roleIds.admin}')`,
].join(",\n");
const customerValues = [
  ...editCustomers.map((id, index) => `('${id}',null,'Empresa ${index}','Contacto ${index}','customer-${index}@example.invalid','+5049999100${index}','0801199900000${index}','Ciudad ${index}',true,'active',now(),now())`),
  ...linkCustomers.map((id, index) => `('${id}',null,'Link Empresa ${index}','Link Contacto ${index}','link-${index}@example.invalid','+5049999200${index}','0801199800000${index}','San Pedro Sula',true,'active',now(),now())`),
].join(",\n");

const setupSql = `
create extension if not exists pgcrypto;
do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
do $$ begin create role anon; exception when duplicate_object then null; end $$;
create schema auth;
create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, created_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create table public.roles (id uuid primary key, name text unique not null, permissions jsonb not null default '[]'::jsonb);
create table public.users (id uuid primary key references auth.users(id), email text, full_name text, phone text, active boolean not null default true, role_id uuid references public.roles(id), created_at timestamptz not null default now());
create table public.customers (id uuid primary key, user_id uuid references public.users(id), business_name text, contact_name text not null, email text, phone text, tax_id text, city text, active boolean not null default true, status text not null default 'active', created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create unique index customers_user_id_unique_idx on public.customers(user_id) where user_id is not null;
create table public.audit_logs (id uuid primary key default gen_random_uuid(), user_id uuid references public.users(id), actor_role text, table_name text not null, record_id uuid, action text not null, old_data jsonb, new_data jsonb, ip_address inet, user_agent text, created_at timestamptz not null default now());
create table public.orders (id uuid primary key, customer_id uuid references public.customers(id), customer_name_snapshot text not null);
create table public.invoices (id uuid primary key, customer_id uuid references public.customers(id), customer_name_snapshot text not null, customer_rtn text);
create table public.accounts_receivable (id uuid primary key, customer_id uuid references public.customers(id), amount numeric not null);
create table public.crm_notes (id uuid primary key, customer_id uuid references public.customers(id), note text not null);
insert into public.roles values ${roleValues};
insert into auth.users values ${authValues};
insert into public.users (id,email,full_name,phone,active,role_id) values ${actorUserValues},${targetUserValues};
insert into public.customers values ${customerValues};
insert into public.orders values ('${snapshotOrder}','${linkCustomers[0]}','HISTORICO INMUTABLE');
insert into public.invoices values ('${snapshotInvoice}','${linkCustomers[0]}','FACTURA HISTORICA','RTN-HISTORICO');
insert into public.accounts_receivable values ('${snapshotReceivable}','${linkCustomers[0]}',1250);
insert into public.crm_notes values ('${snapshotCrm}','${linkCustomers[0]}','Actividad CRM histórica');
create function public.current_actor_role() returns text language sql stable security definer set search_path=public as $$ select r.name from public.users u join public.roles r on r.id=u.role_id where u.id=auth.uid() $$;
create function public.has_permission(permission_key text) returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from public.users u join public.roles r on r.id=u.role_id where u.id=auth.uid() and r.permissions ? permission_key) $$;
create function public.write_audit_log(target_table text,target_record_id uuid,action_name text,previous_data jsonb default null,next_data jsonb default null,actor_ip text default null,actor_user_agent text default null) returns uuid language plpgsql security definer set search_path=public as $$ declare log_id uuid; begin if auth.uid() is null then raise exception 'Authentication required'; end if; insert into audit_logs(user_id,actor_role,table_name,record_id,action,old_data,new_data,ip_address,user_agent) values(auth.uid(),current_actor_role(),target_table,target_record_id,action_name,previous_data,next_data,nullif(actor_ip,'')::inet,nullif(actor_user_agent,'')) returning id into log_id; return log_id; end $$;
grant usage on schema public, auth to authenticated;
`;

let started = false;
try {
  docker(["run", "--rm", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=postgres", "postgres:17-alpine"]);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { docker(["exec", container, "pg_isready", "-U", "postgres"], { timeout: 5000 }); ready = true; break; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
  assert.equal(ready, true, "PostgreSQL container did not become ready");
  let connected = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { psql("select 1;"); connected = true; break; }
    catch { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }
  }
  assert.equal(connected, true, "PostgreSQL did not accept a stable connection");
  psql(setupSql);
  const beforeMigration = businessSnapshot();
  psql(migration);
  psql(migration);
  assert.equal(businessSnapshot(), beforeMigration, "permission/function migration must not mutate business data");

  for (const role of ["technical_owner", "business_owner", "admin"]) {
    assert.equal(psql(`select count(*) from jsonb_array_elements_text((select permissions from roles where name='${role}')) p where p='customers:update_identity';`), "1");
  }
  for (const role of ["contadora", "vendedor", "soporte", "bodega", "cliente"]) {
    assert.equal(psql(`select (permissions ? 'customers:update_identity')::text from roles where name='${role}';`), "false");
  }
  assert.equal(psql("select (permissions ? 'customers:link_portal_account')::text from roles where name='contadora';"), "true");

  for (const [index, role] of ["technical_owner", "business_owner", "admin"].entries()) {
    assert.match(editCall(actorIds[role], editCustomers[index]), /updated$/m, `${role} must edit`);
  }
  assert.equal(psql(`select contact_name from customers where id='${editCustomers[0]}';`), "Contacto Editado");
  assert.equal(psql(`select (old_data->>'contact_name') || '|' || (new_data->>'contact_name') || '|' || actor_role from audit_logs where record_id='${editCustomers[0]}' and action='customer.identity.updated';`), "Contacto 0|Contacto Editado|technical_owner");
  assert.equal(psql(`select (old_data ? 'city')::text from audit_logs where record_id='${editCustomers[0]}' and action='customer.identity.updated';`), "true");

  const deniedRoles = ["contadora", "vendedor", "soporte", "bodega", "cliente"];
  for (const role of deniedRoles) {
    assert.match(editCall(actorIds[role], editCustomers[3]), /permission_denied$/m, `${role} must be denied`);
  }
  assert.equal(psql(`select count(*) from audit_logs where record_id='${editCustomers[3]}' and action='customer.identity.update_denied';`), String(deniedRoles.length));

  assert.match(editCall(actorIds.admin, editCustomers[3], { contact: "   " }), /validation_error$/m);
  assert.match(editCall(actorIds.admin, editCustomers[3], { email: "correo-invalido" }), /validation_error$/m);
  assert.match(editCall(actorIds.admin, editCustomers[3], { business: "", email: "", phone: "", tax: "", city: "" }), /updated$/m);
  assert.equal(psql(`select (business_name is null and email is null and phone is null and tax_id is null and city is null)::text from customers where id='${editCustomers[3]}';`), "true");

  const stale = updatedAt(editCustomers[4]);
  psql(`update customers set city='Cambio concurrente', updated_at=clock_timestamp() where id='${editCustomers[4]}';`);
  assert.match(editCall(actorIds.admin, editCustomers[4], { expected: stale }), /stale_record$/m);
  assert.equal(psql(`select city from customers where id='${editCustomers[4]}';`), "Cambio concurrente");

  psql(`create function fail_identity_audit() returns trigger language plpgsql as $$ begin if new.action='customer.identity.updated' and new.record_id='${editCustomers[4]}' then raise exception 'forced audit failure'; end if; return new; end $$; create trigger fail_identity_audit before insert on audit_logs for each row execute function fail_identity_audit();`);
  const beforeFailedAudit = psql(`select contact_name from customers where id='${editCustomers[4]}';`);
  assert.throws(() => editCall(actorIds.admin, editCustomers[4]), /forced audit failure/i);
  assert.equal(psql(`select contact_name from customers where id='${editCustomers[4]}';`), beforeFailedAudit, "audit failure must rollback update");
  psql("drop trigger fail_identity_audit on audit_logs; drop function fail_identity_audit();");

  for (const [index, role] of ["technical_owner", "business_owner", "admin", "contadora"].entries()) {
    assert.match(linkCall(actorIds[role], linkCustomers[index], clientTargets[index]), /linked$/m, `${role} must link`);
  }
  assert.match(linkCall(actorIds.contadora, linkCustomers[3], clientTargets[3]), /already_linked$/m);
  assert.equal(psql(`select count(*) from audit_logs where record_id='${linkCustomers[3]}' and action='customer_portal_link.linked_manual';`), "1");
  assert.equal(psql(`select user_id::text from customers where id='${linkCustomers[0]}';`), clientTargets[0]);
  assert.equal(psql(`select customer_name_snapshot || '|' || customer_rtn from invoices where id='${snapshotInvoice}';`), "FACTURA HISTORICA|RTN-HISTORICO");
  assert.equal(psql(`select count(*) from orders where customer_id='${linkCustomers[0]}';`), "1");
  assert.equal(psql(`select count(*) from accounts_receivable where customer_id='${linkCustomers[0]}';`), "1");
  assert.equal(psql(`select count(*) from crm_notes where customer_id='${linkCustomers[0]}';`), "1");
  assert.equal(psql(`select business_name from customers where id='${linkCustomers[0]}';`), "Link Empresa 0");

  const unlinkedCustomer = randomUUID();
  psql(`insert into customers(id,contact_name,active,status) values('${unlinkedCustomer}','Target validation',true,'active');`);
  assert.match(linkCall(actorIds.admin, unlinkedCustomer, internalTarget), /invalid_portal_role$/m);
  assert.match(linkCall(actorIds.admin, unlinkedCustomer, inactiveTarget), /invalid_portal_account$/m);
  for (const role of ["vendedor", "soporte", "bodega", "cliente"]) {
    assert.match(linkCall(actorIds[role], unlinkedCustomer, clientTargets[0]), /permission_denied$/m, `${role} must not link`);
  }

  assert.equal(psql(`select count(*) from customers where id in (${linkCustomers.map((id) => `'${id}'`).join(",")});`), "4", "linking must not duplicate customers");
} finally {
  if (started) docker(["stop", container], { timeout: 30000 });
}

console.log("Customer identity and portal linking PostgreSQL checks passed.");
