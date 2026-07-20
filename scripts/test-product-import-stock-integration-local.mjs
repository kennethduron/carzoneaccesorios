import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") {
  throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required for the disposable PostgreSQL test.");
}

const container = "car-zone-product-import-" + process.pid;
if (!/^car-zone-product-import-\d+$/.test(container)) {
  throw new Error("Unsafe disposable container name.");
}

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const catalogMigration = read("supabase/migrations/202607150001_granular_product_permissions.sql");
const automationMigration = read("supabase/migrations/202607180001_product_stock_automation_and_purchase_inventory.sql");
const permissionMigration = read("supabase/migrations/202607200001_grant_contadora_product_stock_adjustment.sql");
const atomicMigration = read("supabase/migrations/202607200002_atomic_product_import_row.sql");
const functionStart = catalogMigration.indexOf("create or replace function public.save_product_catalog_locked");
const functionEnd = catalogMigration.indexOf("comment on function public.save_product_catalog_locked");
assert.ok(functionStart >= 0 && functionEnd > functionStart);
const catalogAndStockFunctions = catalogMigration.slice(functionStart, functionEnd);
const automationStart = automationMigration.indexOf("create or replace function public.audit_automatic_product_stock_state");
const automationEnd = automationMigration.indexOf("create or replace function public.save_purchase_with_inventory");
assert.ok(automationStart >= 0 && automationEnd > automationStart);
const productAutomationFunctions = automationMigration.slice(automationStart, automationEnd);

const users = {
  accountant: randomUUID(),
  catalogOnly: randomUUID(),
};
const categoryId = randomUUID();
const confirmedAsset = "test/confirmed-" + randomUUID();
const orphanAsset = "test/orphan-" + randomUUID();

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
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

function sessionSql(statement, userId) {
  return [
    "begin;",
    "select set_config('request.jwt.claim.role', 'authenticated', true);",
    "select set_config('request.jwt.claim.sub', '" + userId + "', true);",
    statement,
    "commit;",
  ].join("\n");
}

function sqlJson(value) {
  return "'" + JSON.stringify(value).replaceAll("'", "''") + "'::jsonb";
}

function productPayload(sku, name = sku, category = categoryId) {
  return {
    category_id: category,
    sku,
    internal_code: null,
    slug: sku.toLowerCase(),
    name,
    brand: "TEST",
    vehicle_brand: null,
    vehicle_model: null,
    vehicle_year_start: null,
    vehicle_year_end: null,
    short_description: null,
    description: "",
    features: null,
    specifications: null,
    compatibility_notes: null,
    low_stock_threshold: 0,
    min_stock: 0,
    cost_price: 10,
    retail_price: 20,
    wholesale_price: 15,
    wholesale_min_quantity: 1,
    is_new: true,
    status: "active",
    active: true,
  };
}

function importSql(payload, images, stock, mode = "create_and_update") {
  const stockSql = stock === null ? "null::integer" : String(stock);
  return "select row_to_json(result)::text from public.import_product_row_atomic(" +
    sqlJson(payload) + ", " +
    (images === null ? "null::jsonb" : sqlJson(images)) + ", " +
    stockSql + ", '" + mode + "') result;";
}

function importRow(payload, images, stock, userId = users.accountant, mode = "create_and_update") {
  const output = psql(sessionSql(importSql(payload, images, stock, mode), userId));
  return JSON.parse(output.split(/\r?\n/).filter((line) => line.startsWith("{")).at(-1));
}

function expectDatabaseReject(label, callback, pattern) {
  try {
    callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, pattern, label);
    return;
  }
  throw new Error("Expected database rejection: " + label);
}

const setupSql = [
  "create extension if not exists pgcrypto;",
  "do $$ begin create role authenticated; exception when duplicate_object then null; end $$;",
  "do $$ begin create role service_role; exception when duplicate_object then null; end $$;",
  "create schema auth;",
  "create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;",
  "create function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;",
  "create type public.product_status as enum ('active','inactive','draft','archived');",
  "create table public.roles (name text primary key, permissions jsonb not null default '[]'::jsonb);",
  "create table public.profiles (id uuid primary key, role text not null references public.roles(name));",
  "create table public.categories (id uuid primary key, name text not null, slug text not null unique, active boolean not null default true);",
  "create table public.products (id uuid primary key default gen_random_uuid(), category_id uuid, sku text not null unique, internal_code text, slug text not null, name text not null, brand text not null, vehicle_brand text, vehicle_model text, vehicle_year_start integer, vehicle_year_end integer, short_description text, description text not null default '', features text, specifications text, compatibility_notes text, stock integer not null default 0, reserved_stock integer not null default 0, low_stock_threshold integer not null default 0, min_stock integer not null default 0, cost_price numeric not null default 0, retail_price numeric not null default 0, wholesale_price numeric not null default 0, wholesale_min_quantity integer not null default 1, is_new boolean not null default false, status public.product_status not null default 'active', active boolean not null default true, auto_disabled_by_stock boolean not null default false, updated_at timestamptz not null default now());",
  "create table public.product_images (id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products(id) on delete cascade, storage_bucket text not null, storage_path text not null, public_id text, public_url text not null, angle text, alt_text text, sort_order integer not null default 0, is_primary boolean not null default false);",
  "create table public.inventory_movements (id uuid primary key default gen_random_uuid(), product_id uuid not null references public.products(id), user_id uuid, movement_type text not null, quantity integer not null, stock_before integer not null, stock_after integer not null, reference_type text, reference_id uuid, notes text, created_at timestamptz not null default now());",
  "create table public.audit_logs (id uuid primary key default gen_random_uuid(), user_id uuid, actor_role text, table_name text, record_id uuid, action text, old_data jsonb, new_data jsonb, created_at timestamptz not null default now());",
  "create table public.storage_assets (public_id text primary key);",
  "create function public.has_permission(permission_key text) returns boolean language sql stable security definer set search_path=public as $$ select exists(select 1 from public.profiles p join public.roles r on r.name=p.role where p.id=auth.uid() and r.permissions ? permission_key) $$;",
  "create function public.current_actor_role() returns text language sql stable as $$ select coalesce((select role from public.profiles where id=auth.uid()), auth.role(), 'system') $$;",
  "insert into public.roles(name, permissions) values ('contadora', jsonb_build_array('products:create','products:update','products:import','products:images_manage')), ('catalog_only', jsonb_build_array('products:create','products:update','products:import','products:images_manage')), ('vendedor', '[]'::jsonb);",
  "insert into public.profiles(id, role) values ('" + users.accountant + "', 'contadora'), ('" + users.catalogOnly + "', 'catalog_only');",
  "insert into public.categories(id, name, slug, active) values ('" + categoryId + "', 'Exterior', 'exterior', true);",
].join("\n");

let started = false;
try {
  docker(["run", "--rm", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=postgres", "postgres:17-alpine"]);
  started = true;
  let ready = false;
  let readyStreak = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      docker(["exec", container, "pg_isready", "-U", "postgres"], { timeout: 5000 });
      readyStreak += 1;
      if (readyStreak >= 3) {
        ready = true;
        break;
      }
    } catch {
      readyStreak = 0;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  assert.equal(ready, true, "PostgreSQL container did not become ready");

  psql(setupSql);
  psql(permissionMigration);
  psql(permissionMigration);
  assert.equal(psql("select count(*) from jsonb_array_elements_text((select permissions from public.roles where name='contadora')) value where value='products:adjust_stock';"), "1");
  psql(catalogAndStockFunctions);
  psql(atomicMigration);
  psql(productAutomationFunctions);

  psql("insert into public.storage_assets(public_id) values ('" + confirmedAsset + "');");
  const created = importRow(
    productPayload("CASE-A"),
    [{ storage_path: confirmedAsset, public_id: confirmedAsset, public_url: "https://example.test/a.jpg", angle: "principal", sort_order: 0, is_primary: true }],
    25,
  );
  assert.equal(created.row_status, "created");
  assert.equal(created.stock_before, 0);
  assert.equal(created.stock_after, 25);
  assert.equal(created.quantity, 25);
  assert.ok(created.movement_id);
  assert.equal(psql("select stock from public.products where sku='CASE-A';"), "25");
  assert.equal(psql("select active::text || '|' || status || '|' || auto_disabled_by_stock::text from public.products where sku='CASE-A';"), "true|active|false");
  assert.equal(psql("select count(*) from public.product_images where product_id='" + created.product_id + "' and public_id='" + confirmedAsset + "';"), "1");

  const zeroStock = importRow(productPayload("CASE-ZERO"), null, 0);
  assert.equal(zeroStock.stock_applied, true);
  assert.equal(zeroStock.stock_unchanged, true);
  assert.equal(zeroStock.movement_id, null);
  assert.equal(psql("select stock || '|' || active::text || '|' || auto_disabled_by_stock::text from public.products where sku='CASE-ZERO';"), "0|false|true");

  psql("insert into public.products(category_id,sku,slug,name,brand,stock,retail_price,wholesale_price,cost_price) values ('" + categoryId + "','CASE-B','case-b','Case B','TEST',10,20,15,10);");
  const updated = importRow(productPayload("CASE-B"), null, 18);
  assert.equal(updated.row_status, "updated");
  assert.equal(updated.quantity, 8);
  assert.equal(psql("select stock || '|' || count(*) over() from public.products where sku='CASE-B';"), "18|1");

  const movementCountBefore = psql("select count(*) from public.inventory_movements where product_id='" + updated.product_id + "';");
  const unchanged = importRow(productPayload("CASE-B"), null, 18);
  assert.equal(unchanged.stock_unchanged, true);
  assert.equal(unchanged.movement_id, null);
  assert.equal(psql("select count(*) from public.inventory_movements where product_id='" + updated.product_id + "';"), movementCountBefore);

  const first = importRow(productPayload("CASE-D1"), null, 4);
  assert.equal(first.row_status, "created");
  psql("insert into public.storage_assets(public_id) values ('" + orphanAsset + "');");
  expectDatabaseReject(
    "invalid middle row",
    () => importRow(productPayload("CASE-D2", "Invalid", randomUUID()), [{ storage_path: orphanAsset, public_id: orphanAsset, public_url: "https://example.test/orphan.jpg" }], 7),
    /categoria oficial activa/i,
  );
  const third = importRow(productPayload("CASE-D3"), null, 9);
  assert.equal(third.row_status, "created");
  assert.equal(psql("select count(*) from public.products where sku in ('CASE-D1','CASE-D2','CASE-D3');"), "2");
  assert.equal(psql("select count(*) from public.inventory_movements where product_id in (select id from public.products where sku in ('CASE-D1','CASE-D3'));"), "2");

  psql("delete from public.storage_assets a where a.public_id in ('" + confirmedAsset + "','" + orphanAsset + "') and not exists (select 1 from public.product_images i where i.public_id=a.public_id or i.storage_path=a.public_id);");
  assert.equal(psql("select count(*) from public.storage_assets where public_id='" + confirmedAsset + "';"), "1");
  assert.equal(psql("select count(*) from public.storage_assets where public_id='" + orphanAsset + "';"), "0");

  psql("insert into public.products(category_id,sku,slug,name,brand,stock,reserved_stock,retail_price,wholesale_price,cost_price) values ('" + categoryId + "','RESERVED','reserved','Original','TEST',20,15,20,15,10);");
  expectDatabaseReject(
    "row rollback after stock failure",
    () => importRow(productPayload("RESERVED", "Must rollback"), null, 10),
    /unidades reservadas/i,
  );
  assert.equal(psql("select name || '|' || stock || '|' || reserved_stock from public.products where sku='RESERVED';"), "Original|20|15");

  psql("insert into public.products(category_id,sku,slug,name,brand,stock,reserved_stock,retail_price,wholesale_price,cost_price,active,status,auto_disabled_by_stock) values ('" + categoryId + "','MANUAL-OFF','manual-off','Manual off','TEST',10,0,20,15,10,false,'inactive',false);");
  const manualPayload = { ...productPayload("MANUAL-OFF"), active: false, status: "inactive" };
  const manualStock = importRow(manualPayload, null, 18);
  assert.equal(manualStock.stock_after, 18);
  assert.equal(psql("select active::text || '|' || status || '|' || auto_disabled_by_stock::text from public.products where sku='MANUAL-OFF';"), "false|inactive|false");

  expectDatabaseReject(
    "catalog-only actor cannot smuggle stock",
    () => importRow(productPayload("NO-STOCK-PERM"), null, 5, users.catalogOnly),
    /permiso para ajustar stock/i,
  );
  const catalogOnly = importRow(productPayload("NO-STOCK-PERM"), null, null, users.catalogOnly);
  assert.equal(catalogOnly.stock_applied, false);
  assert.equal(psql("select stock from public.products where sku='NO-STOCK-PERM';"), "0");

  const bulkStatements = [];
  for (let index = 1; index <= 160; index += 1) {
    const sku = "BULK-" + String(index).padStart(3, "0");
    bulkStatements.push(importSql(productPayload(sku), null, index));
  }
  const bulkStart = performance.now();
  const bulkBatches = [];
  for (let index = 0; index < bulkStatements.length; index += 20) {
    bulkBatches.push(bulkStatements.slice(index, index + 20));
  }
  assert.equal(bulkBatches.length, 8);
  for (const batch of bulkBatches) {
    psql([
      "select set_config('request.jwt.claim.role', 'authenticated', false);",
      "select set_config('request.jwt.claim.sub', '" + users.accountant + "', false);",
      "\\o /dev/null",
      ...batch,
      "\\o",
    ].join("\n"));
  }
  const bulkDurationMs = Math.round(performance.now() - bulkStart);
  assert.equal(psql("select count(*) || '|' || bool_and(stock=substring(sku from 6)::integer)::text from public.products where sku like 'BULK-%';"), "160|true");

  console.log(JSON.stringify({
    status: "PRODUCT_IMPORT_STOCK_INTEGRATION_PASS",
    bulkRows: 160,
    bulkBatches: bulkBatches.length,
    bulkDurationMs,
    confirmedImagePreserved: true,
    orphanAssetRemoved: true,
  }));
} finally {
  if (started) {
    try {
      docker(["rm", "-f", container], { timeout: 30000 });
    } catch (cleanupError) {
      console.error("Disposable PostgreSQL cleanup failed:", cleanupError instanceof Error ? cleanupError.message : cleanupError);
    }
  }
}
