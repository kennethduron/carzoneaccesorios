import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const container = `car-zone-product-limits-${process.pid}`;
const migration = readFileSync(new URL("../supabase/migrations/202608280001_product_image_catalog_limits.sql", import.meta.url), "utf8");

function docker(args, options = {}) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...options }).trim();
}

function psql(sql) {
  return docker(["exec", "-i", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-At"], { input: sql });
}

function expectSqlFailure(sql, expectedCode) {
  assert.throws(
    () => psql(sql),
    (error) => `${error.stderr ?? ""}${error.stdout ?? ""}`.includes(expectedCode),
    `expected ${expectedCode}`,
  );
}

function concurrentInsert(name) {
  return new Promise((resolve) => {
    const child = spawn("docker", [
      "exec", container, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", "-At", "-c",
      `insert into public.products(name) values ('${name}');`,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

const fixture = `
create extension if not exists pgcrypto;
do $$ begin
  create role anon;
exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated;
exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role;
exception when duplicate_object then null; end $$;

create table public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  tax_category text not null default 'standard',
  tracks_inventory boolean not null default true,
  stock integer not null default 0
);
create table public.product_images (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade
);

create or replace function public.save_product_catalog_locked(
  target_product_id uuid,
  product_data jsonb,
  images_data jsonb default null
)
returns table(product_id uuid, removed_asset_ids text[])
language plpgsql
as $$
declare saved_id uuid;
begin
  if target_product_id is null then
    insert into public.products(name) values (coalesce(product_data->>'name', 'RPC product')) returning id into saved_id;
  else
    saved_id := target_product_id;
  end if;
  product_id := saved_id;
  removed_asset_ids := array[]::text[];
  return next;
end;
$$;

insert into public.products(name)
select 'Fixture ' || value from generate_series(1, 2998) value;
`;

try {
  docker(["run", "--rm", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=postgres", "postgres:16-alpine"]);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      docker(["exec", container, "pg_isready", "-U", "postgres"]);
      break;
    } catch {
      if (attempt === 39) throw new Error("Disposable PostgreSQL did not become ready.");
      execFileSync("powershell", ["-NoProfile", "-Command", "Start-Sleep -Milliseconds 500"]);
    }
  }

  psql(fixture + "\n" + migration);
  assert.equal(psql("select count(*) from public.products;"), "2998");

  psql("insert into public.products(name) values ('Capacity 2999');");
  assert.equal(psql("select count(*) from public.products;"), "2999");
  psql("insert into public.products(name) values ('Capacity 3000');");
  assert.equal(psql("select count(*) from public.products;"), "3000");
  expectSqlFailure("insert into public.products(name) values ('Forbidden 3001');", "PRODUCT_CATALOG_LIMIT_REACHED");
  assert.equal(psql("select count(*) from public.products;"), "3000");

  psql("update public.products set name = 'Updated at cap', stock = 7 where name = 'Capacity 3000';");
  assert.equal(psql("select stock from public.products where name = 'Updated at cap';"), "7");

  const imageProductId = psql("select id from public.products order by id limit 1;");
  psql(`insert into public.product_images(product_id) select '${imageProductId}'::uuid from generate_series(1,4);`);
  assert.equal(psql(`select count(*) from public.product_images where product_id='${imageProductId}';`), "4");
  expectSqlFailure(`insert into public.product_images(product_id) values ('${imageProductId}');`, "PRODUCT_IMAGE_LIMIT_EXCEEDED");
  psql(`delete from public.product_images where id=(select id from public.product_images where product_id='${imageProductId}' limit 1);`);
  psql(`insert into public.product_images(product_id) values ('${imageProductId}');`);
  assert.equal(psql(`select count(*) from public.product_images where product_id='${imageProductId}';`), "4");

  expectSqlFailure(
    `select * from public.save_product_catalog_v2_locked('${imageProductId}', '{"tax_category":"standard","tracks_inventory":true}'::jsonb, '[{},{},{},{},{}]'::jsonb);`,
    "PRODUCT_IMAGE_LIMIT_EXCEEDED",
  );
  psql(`select product_id from public.save_product_catalog_v2_locked('${imageProductId}', '{"tax_category":"standard","tracks_inventory":true}'::jsonb, '[{},{},{},{}]'::jsonb);`);

  psql("delete from public.products where name = 'Capacity 2999';");
  assert.equal(psql("select count(*) from public.products;"), "2999");
  const concurrent = await Promise.all([concurrentInsert("Concurrent A"), concurrentInsert("Concurrent B")]);
  assert.equal(concurrent.filter((result) => result.code === 0).length, 1, "exactly one concurrent create may claim row 3000");
  assert.equal(concurrent.filter((result) => result.stderr.includes("PRODUCT_CATALOG_LIMIT_REACHED")).length, 1);
  assert.equal(psql("select count(*) from public.products;"), "3000");

  psql("delete from public.products where name in ('Concurrent A','Concurrent B');");
  assert.equal(psql("select count(*) from public.products;"), "2999");
  psql("insert into public.products(name) values ('Capacity restored');");
  assert.equal(psql("select count(*) from public.products;"), "3000");

  console.log("PRODUCT_FINAL_HARDENING_DB_PASS");
} finally {
  try {
    assert.match(container, /^car-zone-product-limits-\d+$/);
    docker(["rm", "-f", container]);
  } catch {
    // Docker --rm may already have removed the isolated container.
  }
}
