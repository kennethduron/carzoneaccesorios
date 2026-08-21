import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") {
  throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required for the disposable PostgreSQL test.");
}

const execFileAsync = promisify(execFile);
const container = `car-zone-product-code-edit-${process.pid}`;
assert.match(container, /^car-zone-product-code-edit-\d+$/);

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

async function psqlAsync(sql) {
  const result = await execFileAsync(
    "docker",
    ["exec", container, "psql", "-q", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
  );
  return result.stdout.trim();
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
  sku text not null,
  slug text not null unique,
  name text not null,
  stock integer not null default 0,
  min_stock integer not null default 0,
  vehicle_brand text,
  vehicle_model text,
  compatibility_notes text
);
create unique index products_sku_upper_btrim_uidx on public.products (upper(btrim(sku)));
create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id),
  quantity integer not null,
  stock_before integer not null,
  stock_after integer not null
);
create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id),
  sku text not null,
  product_name text not null
);
create table public.invoice_items (
  id uuid primary key default gen_random_uuid(),
  product_id uuid references public.products(id),
  sku text not null,
  product_name text not null
);
create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  public_url text not null
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
  if nullif(btrim(product_data->>'sku'), '') is null then
    raise exception using errcode = '22023', message = 'SKU obligatorio.';
  end if;
  if target_product_id is null then
    insert into public.products(sku, slug, name, stock, min_stock, vehicle_brand, vehicle_model, compatibility_notes)
    values (upper(btrim(product_data->>'sku')), product_data->>'slug', product_data->>'name', 0, 1,
      product_data->>'vehicle_brand', product_data->>'vehicle_model', product_data->>'compatibility_notes')
    returning id into saved_id;
  else
    perform 1 from public.products where id = target_product_id for update;
    if not found then raise exception 'Producto no encontrado.'; end if;
    update public.products
    set sku = upper(btrim(product_data->>'sku')),
        slug = product_data->>'slug',
        name = product_data->>'name',
        vehicle_brand = product_data->>'vehicle_brand',
        vehicle_model = product_data->>'vehicle_model',
        compatibility_notes = product_data->>'compatibility_notes'
    where id = target_product_id;
    saved_id := target_product_id;
  end if;
  product_id := saved_id;
  removed_asset_ids := array[]::text[];
  return next;
end;
$$;

create or replace function public.set_product_stock_locked(
  target_product_id uuid,
  target_stock integer,
  movement_notes text
)
returns table(movement_id uuid, stock_before integer, stock_after integer, quantity integer)
language plpgsql
as $$
declare current_stock integer;
begin
  select stock into strict current_stock from public.products where id = target_product_id for update;
  stock_before := current_stock;
  stock_after := target_stock;
  quantity := target_stock - current_stock;
  if quantity = 0 then
    movement_id := null;
    return next;
    return;
  end if;
  update public.products set stock = target_stock where id = target_product_id;
  insert into public.inventory_movements(product_id, quantity, stock_before, stock_after)
  values (target_product_id, quantity, current_stock, target_stock)
  returning id into movement_id;
  return next;
end;
$$;
`;

function payload(sku, slug, name = "Existing product") {
  const value = {
    sku,
    slug,
    name,
    vehicle_brand: "Toyota",
    vehicle_model: "Hilux",
    compatibility_notes: "Preserve compatibility",
  };
  return `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
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
  const productId = "11111111-1111-4111-8111-111111111111";
  const otherId = "22222222-2222-4222-8222-222222222222";
  psql(`
    insert into public.products(id,sku,slug,name,stock,min_stock,vehicle_brand,vehicle_model,compatibility_notes)
    values
      ('${productId}','OLD-SKU','stable-slug','Existing product',7,1,'Toyota','Hilux','Preserve compatibility'),
      ('${otherId}','TAKEN-SKU','other-slug','Other product',3,1,null,null,null);
    insert into public.order_items(product_id,sku,product_name) values ('${productId}','OLD-SKU','Historical order name');
    insert into public.invoice_items(product_id,sku,product_name) values ('${productId}','OLD-SKU','Historical invoice name');
    insert into public.product_images(product_id,public_url) values ('${productId}','https://example.invalid/product.webp');
  `);

  const sameSku = psql(`select product_id || '|' || stock_after || '|' || stock_quantity || '|' || coalesce(stock_movement_id::text,'none') from public.save_product_catalog_v3_locked('${productId}', ${payload("OLD-SKU", "stable-slug")}, null, 7);`);
  assert.equal(sameSku, `${productId}|7|0|none`, "keeping the same SKU must be a no-op for identity and inventory");

  const changed = psql(`select product_id || '|' || stock_after || '|' || stock_quantity || '|' || coalesce(stock_movement_id::text,'none') from public.save_product_catalog_v3_locked('${productId}', ${payload("NEW-SKU", "stable-slug")}, null, 7);`);
  assert.equal(changed, `${productId}|7|0|none`, "SKU rename must preserve product identity and inventory");
  assert.equal(psql(`select id from public.products where sku='NEW-SKU';`), productId);
  assert.equal(psql("select count(*) from public.products;"), "2", "SKU rename must not create a product row");
  assert.equal(psql(`select stock || '|' || min_stock from public.products where id='${productId}';`), "7|1");
  assert.equal(psql(`select count(*) from public.inventory_movements where product_id='${productId}';`), "0");
  assert.equal(psql(`select sku || '|' || product_name from public.order_items where product_id='${productId}';`), "OLD-SKU|Historical order name");
  assert.equal(psql(`select sku || '|' || product_name from public.invoice_items where product_id='${productId}';`), "OLD-SKU|Historical invoice name");
  assert.equal(psql(`select count(*) from public.product_images where product_id='${productId}';`), "1");
  assert.equal(psql(`select vehicle_brand || '|' || vehicle_model || '|' || compatibility_notes from public.products where id='${productId}';`), "Toyota|Hilux|Preserve compatibility");
  assert.equal(psql(`select slug from public.products where id='${productId}';`), "stable-slug", "slug must remain independent from SKU");

  assert.throws(() => psql(`select * from public.save_product_catalog_v3_locked('${productId}', ${payload("", "stable-slug")}, null, 7);`));
  assert.throws(() => psql(`select * from public.save_product_catalog_v3_locked('${productId}', ${payload("TAKEN-SKU", "stable-slug")}, null, 7);`));
  assert.throws(() => psql(`select * from public.save_product_catalog_v3_locked('${productId}', ${payload("  taken-sku  ", "stable-slug")}, null, 7);`));
  assert.equal(psql(`select sku from public.products where id='${productId}';`), "NEW-SKU", "failed duplicates must preserve the accepted SKU");

  const raceA = "33333333-3333-4333-8333-333333333333";
  const raceB = "44444444-4444-4444-8444-444444444444";
  psql(`insert into public.products(id,sku,slug,name,stock,min_stock) values ('${raceA}','RACE-A','race-a','Race A',0,1),('${raceB}','RACE-B','race-b','Race B',0,1);`);
  const raceResults = await Promise.allSettled([
    psqlAsync(`select product_id from public.save_product_catalog_v3_locked('${raceA}', ${payload("RACE-WINNER", "race-a", "Race A")}, null, 0);`),
    psqlAsync(`select product_id from public.save_product_catalog_v3_locked('${raceB}', ${payload("RACE-WINNER", "race-b", "Race B")}, null, 0);`),
  ]);
  assert.equal(raceResults.filter((result) => result.status === "fulfilled").length, 1, "concurrent normalized SKU rename must have one winner");
  assert.equal(raceResults.filter((result) => result.status === "rejected").length, 1, "concurrent normalized SKU rename must reject one contender");
  assert.equal(psql("select count(*) from public.products where sku='RACE-WINNER';"), "1");
  assert.equal(psql("select count(*) from public.products;"), "4", "concurrent rename must not clone products");
  assert.equal(psql("select count(*) from public.inventory_movements;"), "0", "SKU edits must not create inventory movements");

  console.log("PRODUCT_CODE_EDIT_LOCAL_MATRIX_PASS");
} finally {
  try {
    assert.match(container, /^car-zone-product-code-edit-\d+$/);
    docker(["rm", "-f", container]);
  } catch {
    // Docker --rm may have already removed the isolated test container.
  }
}
