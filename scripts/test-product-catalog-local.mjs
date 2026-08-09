import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";

const PREFIX = "PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY";
const status = JSON.parse(execFileSync("npx.cmd", ["supabase", "status"], { encoding: "utf8", shell: true }));
process.env.NEXT_PUBLIC_SUPABASE_URL = status.API_URL;
process.env.SUPABASE_SERVICE_ROLE_KEY = status.SERVICE_ROLE_KEY;
const supabase = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const { getAdminProductCatalogExport, getAdminProductCatalogPage } = await import("../src/services/supabase/admin-products.service.ts");

async function removeFixtures() {
  assert.equal(PREFIX, "PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY");
  const { error } = await supabase.from("products").delete().like("sku", `${PREFIX}%`);
  if (error) throw error;
}

function fixture(index, categoryIds) {
  const categoryIndex = index <= 100 ? 0 : index <= 180 ? 1 : index <= 261 ? 2 : (index - 1) % 3;
  const active = index % 5 !== 0;
  return {
    id: `a1000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    category_id: categoryIds[categoryIndex],
    sku: `${PREFIX}-SKU-${String(index).padStart(6, "0")}`,
    slug: `${PREFIX.toLowerCase()}-${index}`,
    name: `${PREFIX} Producto ${index}`,
    brand: `Marca ${index % 7}`,
    description: index === 250 ? "BUSQUEDA-FUERA-PAGINA-UNO" : "Fixture local controlado",
    stock: index % 3 === 0 ? 1 : 10,
    low_stock_threshold: 2,
    min_stock: 2,
    cost_price: 10 + (index % 7),
    retail_price: 100,
    wholesale_price: 80,
    wholesale_min_quantity: 1,
    tax_category: "standard",
    tracks_inventory: true,
    status: active ? "active" : "inactive",
    active,
    updated_at: "2026-08-08T12:00:00.000Z",
  };
}

async function insertFixtures(from, to, categoryIds) {
  const rows = Array.from({ length: to - from + 1 }, (_, offset) => fixture(from + offset, categoryIds));
  for (let index = 0; index < rows.length; index += 500) {
    const { error } = await supabase.from("products").insert(rows.slice(index, index + 500));
    if (error) throw error;
  }
}

function expectedSummary(rows) {
  return {
    activeProducts: rows.filter((row) => row.active).length,
    lowStockProducts: rows.filter((row) => row.stock <= row.min_stock).length,
    inventoryCost: Number(rows.reduce((sum, row) => sum + row.cost_price * row.stock, 0).toFixed(2)),
  };
}

const timings = {};
try {
  await removeFixtures();
  const { data: categories, error: categoriesError } = await supabase
    .from("categories")
    .select("id, slug")
    .in("slug", ["exterior", "interior", "iluminacion"])
    .order("slug");
  if (categoriesError) throw categoriesError;
  assert.equal(categories.length, 3);
  const categoryIds = categories.map((category) => category.id);

  await insertFixtures(1, 261, categoryIds);
  const first261 = Array.from({ length: 261 }, (_, index) => fixture(index + 1, categoryIds));
  const summary261 = expectedSummary(first261);
  const summaries = [];
  for (const page of [1, 2, 3, 6]) {
    const result = await getAdminProductCatalogPage({ page, pageSize: 50 }, { includeCost: true });
    assert.equal(result.total, 261);
    assert.equal(result.products.length, page === 6 ? 11 : 50);
    assert.deepEqual(result.summary, summary261);
    summaries.push(result.summary);
  }
  assert.deepEqual(summaries[0], summaries[3]);

  const categoryAFirst = await getAdminProductCatalogPage({ categoryId: categoryIds[0], page: 1, pageSize: 50 }, { includeCost: true });
  const categoryASecond = await getAdminProductCatalogPage({ categoryId: categoryIds[0], page: 2, pageSize: 50 }, { includeCost: true });
  assert.equal(categoryAFirst.total, 100);
  assert.equal(categoryASecond.total, 100);
  assert.equal(categoryAFirst.products.length, 50);
  assert.equal(categoryASecond.products.length, 50);
  assert.deepEqual(categoryAFirst.summary, categoryASecond.summary);

  const searched = await getAdminProductCatalogPage({ query: "BUSQUEDA-FUERA-PAGINA-UNO", page: 1 }, { includeCost: true });
  assert.equal(searched.total, 1);
  assert.equal(searched.products[0].sku, `${PREFIX}-SKU-000250`);

  const withoutCost = await getAdminProductCatalogPage({ page: 1 }, { includeCost: false });
  assert.equal(withoutCost.summary.inventoryCost, null);
  assert.ok(withoutCost.products.every((product) => !("cost_price" in product)));
  assert.equal(withoutCost.products[0].id, fixture(261, categoryIds).id, "id DESC breaks updated_at ties deterministically");

  await insertFixtures(262, 5_000, categoryIds);
  let started = performance.now();
  const first5000 = await getAdminProductCatalogPage({ page: 1, pageSize: 50 }, { includeCost: true });
  timings.page1 = Math.round(performance.now() - started);
  assert.equal(first5000.total, 5_000);
  assert.equal(first5000.products.length, 50);

  started = performance.now();
  const deep5000 = await getAdminProductCatalogPage({ page: 100, pageSize: 50 }, { includeCost: true });
  timings.page100 = Math.round(performance.now() - started);
  assert.equal(deep5000.products.length, 50);
  assert.deepEqual(deep5000.summary, first5000.summary);

  started = performance.now();
  const search5000 = await getAdminProductCatalogPage({ query: `${PREFIX}-SKU-004900`, page: 1 }, { includeCost: true });
  timings.search = Math.round(performance.now() - started);
  assert.equal(search5000.total, 1);

  started = performance.now();
  const filtered5000 = await getAdminProductCatalogPage({ status: "inactive", categoryId: categoryIds[1], page: 1 }, { includeCost: true });
  timings.filter = Math.round(performance.now() - started);
  assert.ok(filtered5000.total > 0);

  started = performance.now();
  const exported = await getAdminProductCatalogExport({}, { includeCost: false });
  timings.export = Math.round(performance.now() - started);
  assert.equal(exported.total, 5_000);
  assert.equal(exported.products.length, 5_000);
  assert.ok(exported.products.every((product) => !("cost_price" in product)));

  console.log("Local product catalog datasets passed.", { dataset261: true, dataset5000: true, timings });
} finally {
  await removeFixtures();
  const { count, error } = await supabase.from("products").select("id", { count: "exact", head: true }).like("sku", `${PREFIX}%`);
  if (error) throw error;
  assert.equal(count, 0, "local product catalog fixtures must be removed");
}
