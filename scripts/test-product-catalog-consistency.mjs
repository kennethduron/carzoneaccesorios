import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [service, page, manager, actions, route, migration] = await Promise.all([
  read("src/services/supabase/admin-products.service.ts"),
  read("src/app/admin/productos/page.tsx"),
  read("src/components/admin/product-manager.tsx"),
  read("src/app/admin/productos/actions.ts"),
  read("src/app/api/admin/productos/exportar/route.ts"),
  read("supabase/migrations/202608080004_product_catalog_consistency_and_sku_guards.sql"),
]);

assert.match(service, /function applyProductCatalogFilters/);
assert.match(service, /getCatalogSummary\(contract, total, includeCost\)/);
assert.match(service, /inventoryCost: includeCost/);
assert.match(service, /\.order\("updated_at", \{ ascending: false \}\)\s*\.order\("id", \{ ascending: false \}\)/);
assert.match(service, /getAdminProductCatalogExport/);
assert.match(service, /rows\.length !== total/);
assert.doesNotMatch(manager, /products\.filter\(/);
assert.match(manager, /const visibleProducts = products/);
assert.match(manager, /md:grid-cols-2 xl:hidden/);
assert.match(manager, /hidden xl:block/);
assert.match(manager, /role="dialog"/);
assert.match(manager, /aria-modal="true"/);
assert.match(manager, /handleDialogKeyDown/);
assert.match(manager, /Exportar resultados/);
assert.doesNotMatch(manager, /xlsx\.xls/);
assert.match(page, /includeCost: capabilities\.viewCost/);
assert.doesNotMatch(page, /loadedProducts\.map/);
assert.match(route, /requireProductCapability\("exportProducts"\)/);
assert.match(route, /getAdminProductCatalogExport/);
assert.match(actions, /preflightProductImportFileAction/);
assert.match(actions, /create_product_import_preflight/);
assert.match(actions, /import_product_batch_row_v3_atomic/);
assert.match(migration, /products_sku_upper_btrim_uidx/);
assert.match(migration, /upper\(btrim\(sku\)\)/);
assert.doesNotMatch(migration, /update\s+public\.products\s+set/i);

const limits = await import("../src/utils/product-import-limits.ts");
assert.equal(limits.validateProductImportLimits({ rows: 5_000 }).ok, true);
assert.equal(limits.validateProductImportLimits({ rows: 5_001 }).ok, false);
assert.equal(limits.validateProductImportLimits({ bytes: 10 * 1024 * 1024 }).ok, true);
assert.equal(limits.validateProductImportLimits({ bytes: 10 * 1024 * 1024 + 1 }).ok, false);

const { buildProductCatalogExcelResponse } = await import("../src/utils/product-catalog-export.ts");
function product(index, overrides = {}) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    category_id: null,
    category_name: "Iluminación",
    sku: `PRODUCT-CATALOG-IMPLEMENTATION-LOCAL-ONLY-${index}`,
    internal_code: null,
    slug: `producto-${index}`,
    name: `Producto ${index}`,
    brand: "Marca",
    vehicle_brand: null,
    vehicle_model: null,
    vehicle_year_start: null,
    vehicle_year_end: null,
    short_description: null,
    description: "",
    features: null,
    specifications: null,
    compatibility_notes: null,
    stock: 10,
    min_stock: 2,
    cost_price: 50,
    retail_price: 100,
    wholesale_price: 80,
    wholesale_min_quantity: 1,
    tax_category: "standard",
    tracks_inventory: true,
    product_sales_version: 1,
    is_new: false,
    status: "active",
    active: true,
    reserved_stock: 0,
    available_stock: 10,
    auto_disabled_by_stock: false,
    created_at: "2026-08-08T00:00:00.000Z",
    updated_at: "2026-08-08T00:00:00.000Z",
    images: [],
    ...overrides,
  };
}

const fixture = [
  product(1, { sku: "=SUM(A1:A2)", name: "+CMD", brand: "@TEST", internal_code: "-1+1" }),
  product(2),
];
const withoutCost = await buildProductCatalogExcelResponse(fixture, false);
assert.match(withoutCost.headers.get("content-type") ?? "", /spreadsheetml\.sheet/);
assert.match(withoutCost.headers.get("content-disposition") ?? "", /car-zone-productos-\d{4}-\d{2}-\d{2}\.xlsx/);
const parsed = new ExcelJS.Workbook();
await parsed.xlsx.load(await withoutCost.arrayBuffer());
const sheet = parsed.getWorksheet("Productos");
assert.ok(sheet);
assert.equal(sheet.getRow(4).values.includes("Costo"), false);
assert.equal(sheet.rowCount, fixture.length + 4);
assert.equal(sheet.getCell("A5").value, "'=SUM(A1:A2)");
assert.equal(sheet.getCell("C5").value, "'+CMD");
assert.equal(sheet.getCell("E5").value, "'@TEST");

const withCost = await buildProductCatalogExcelResponse(fixture, true);
const parsedWithCost = new ExcelJS.Workbook();
await parsedWithCost.xlsx.load(await withCost.arrayBuffer());
assert.equal(parsedWithCost.getWorksheet("Productos").getRow(4).values.includes("Costo"), true);

const productionVolume = Array.from({ length: 261 }, (_, index) => product(index + 1));
const productionWorkbook = await buildProductCatalogExcelResponse(productionVolume, true);
const parsedProduction = new ExcelJS.Workbook();
await parsedProduction.xlsx.load(await productionWorkbook.arrayBuffer());
assert.equal(parsedProduction.getWorksheet("Productos").rowCount, 265);

const largeVolume = Array.from({ length: 5_000 }, (_, index) => product(index + 1));
const largeWorkbook = await buildProductCatalogExcelResponse(largeVolume, false);
const parsedLarge = new ExcelJS.Workbook();
await parsedLarge.xlsx.load(await largeWorkbook.arrayBuffer());
assert.equal(parsedLarge.getWorksheet("Productos").rowCount, 5_004);

console.log("Product catalog consistency checks passed.", {
  rows261: 261,
  rows5000: 5_000,
  xlsxReal: true,
  formulaInjectionProtected: true,
  costColumnPermissionAware: true,
});
