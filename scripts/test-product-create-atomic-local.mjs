import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") {
  throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required for the disposable PostgreSQL test.");
}

const container = `car-zone-product-create-${process.pid}`;
assert.match(container, /^car-zone-product-create-\d+$/);

function docker(args, options = {}) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
    ...options,
  }).trim();
}

function psql(sql) {
  return docker(
    ["exec", "-i", container, "psql", "-q", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"],
    { input: sql },
  );
}

const migration = readFileSync(
  new URL("../supabase/migrations/202608200001_payment_effective_date_product_creation_hardening_v1.sql", import.meta.url),
  "utf8",
);
const v3Start = migration.indexOf("create or replace function public.save_product_catalog_v3_locked");
const v3End = migration.indexOf("revoke all on function", v3Start);
assert.ok(v3Start >= 0 && v3End > v3Start, "V3 product RPC definition must exist");
const v3Function = migration.slice(v3Start, v3End);

const fixtureSql = `
create extension if not exists pgcrypto;
create table public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  slug text not null unique,
  name text not null,
  stock integer not null default 0
);
create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  quantity integer not null,
  stock_before integer not null,
  stock_after integer not null
);

create or replace function public.save_product_catalog_v2_locked(
  target_product_id uuid,
  product_data jsonb,
  images_data jsonb
)
returns table(product_id uuid, removed_asset_ids text[])
language plpgsql
as $$
declare saved_id uuid;
begin
  if product_data->>'sku' = 'RPC-FAIL' then
    raise exception using errcode = 'P0001', message = 'synthetic product RPC failure';
  end if;
  if target_product_id is null then
    insert into public.products(sku, slug, name)
    values (product_data->>'sku', product_data->>'slug', product_data->>'name')
    returning id into saved_id;
  else
    update public.products
    set sku = product_data->>'sku', slug = product_data->>'slug', name = product_data->>'name'
    where id = target_product_id
    returning id into saved_id;
  end if;
  product_id := saved_id;
  removed_asset_ids := array[]::text[];
  return next;
end;
$$;

create or replace function public.set_product_stock_locked(
  target_product_id uuid,
  new_stock integer,
  reason text
)
returns table(movement_id uuid, stock_before integer, stock_after integer, quantity integer)
language plpgsql
as $$
declare current_stock integer;
begin
  select stock into strict current_stock from public.products where id = target_product_id for update;
  if new_stock = 999 then
    raise exception using errcode = 'P0001', message = 'synthetic stock failure';
  end if;
  update public.products set stock = new_stock where id = target_product_id;
  insert into public.inventory_movements(product_id, quantity, stock_before, stock_after)
  values (target_product_id, new_stock - current_stock, current_stock, new_stock)
  returning id into movement_id;
  stock_before := current_stock;
  stock_after := new_stock;
  quantity := new_stock - current_stock;
  return next;
end;
$$;
`;

function payload(sku, slug = sku.toLowerCase()) {
  return `'${JSON.stringify({ sku, slug, name: sku }).replaceAll("'", "''")}'::jsonb`;
}

try {
  docker(["run", "--rm", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=postgres", "postgres:16-alpine"]);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      docker(["exec", container, "pg_isready", "-U", "postgres"]);
      break;
    } catch {
      if (attempt === 29) throw new Error("Disposable PostgreSQL did not become ready.");
      execFileSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 500"]);
    }
  }

  psql(fixtureSql + "\n" + v3Function);
  const created = psql(`select product_id || '|' || stock_after || '|' || stock_quantity || '|' || (stock_movement_id is not null) from public.save_product_catalog_v3_locked(null, ${payload("CREATE-OK")}, null, 5);`);
  assert.match(created, /^[0-9a-f-]+\|5\|5\|true$/);
  assert.equal(psql("select stock from public.products where sku = 'CREATE-OK';"), "5");
  assert.equal(psql("select count(*) from public.inventory_movements;"), "1");

  assert.throws(() => psql(`select * from public.save_product_catalog_v3_locked(null, ${payload("CREATE-OK", "different-slug")}, null, 1);`));
  assert.throws(() => psql(`select * from public.save_product_catalog_v3_locked(null, ${payload("DIFFERENT-SKU", "create-ok")}, null, 1);`));
  assert.equal(psql("select count(*) from public.products;"), "1", "duplicate SKU/slug must not create another product");

  assert.throws(() => psql(`select * from public.save_product_catalog_v3_locked(null, ${payload("RPC-FAIL")}, null, 3);`));
  assert.equal(psql("select count(*) from public.products where sku = 'RPC-FAIL';"), "0", "product RPC failure must not leave a product");

  assert.throws(() => psql(`select * from public.save_product_catalog_v3_locked(null, ${payload("STOCK-FAIL")}, null, 999);`));
  assert.equal(psql("select count(*) from public.products where sku = 'STOCK-FAIL';"), "0", "stock failure must roll back the product insert");
  assert.equal(psql("select count(*) from public.inventory_movements;"), "1", "failed creates must not add stock movements");

  console.log("PRODUCT_CREATE_ATOMIC_LOCAL_PASS");
} finally {
  try {
    assert.match(container, /^car-zone-product-create-\d+$/);
    docker(["rm", "-f", container]);
  } catch {
    // Docker --rm may have already removed the isolated test container.
  }
}
