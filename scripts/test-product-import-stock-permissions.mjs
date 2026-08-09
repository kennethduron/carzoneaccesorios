import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ExcelJS from "exceljs";
import { allPermissions, rolePermissions } from "../src/lib/auth/permissions.ts";
import {
  maxProductStock,
  parseRequiredStockInteger,
  readProductImportWorksheet,
  stockPreviewLabel,
} from "../src/utils/product-import-stock.ts";

const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const roles = ["technical_owner", "business_owner", "admin", "contadora", "vendedor", "bodega", "soporte", "cliente"];
const permissionsFor = (role) => role === "technical_owner" ? allPermissions : rolePermissions[role];
const canAdjustStock = (role) => {
  const permissions = permissionsFor(role);
  return role === "technical_owner" ||
    permissions.includes("products:manage") ||
    permissions.includes("products:adjust_stock") ||
    permissions.includes("inventory:manage");
};

assert.deepEqual(Object.fromEntries(roles.map((role) => [role, canAdjustStock(role)])), {
  technical_owner: true,
  business_owner: true,
  admin: true,
  contadora: true,
  vendedor: false,
  bodega: true,
  soporte: false,
  cliente: false,
});
assert.equal(rolePermissions.contadora.includes("products:adjust_stock"), true);
for (const forbidden of [
  "inventory:manage",
  "products:manage",
  "products:delete",
  "users:manage",
  "roles:assign",
  "security:manage",
  "technical:tools",
  "system:backups",
]) {
  assert.equal(rolePermissions.contadora.includes(forbidden), false, "contadora must not receive " + forbidden);
}

const acceptedStocks = new Map([
  [0, 0],
  [25, 25],
  ["0", 0],
  [" 18 ", 18],
  [String(maxProductStock), maxProductStock],
]);
for (const [input, expected] of acceptedStocks) {
  assert.deepEqual(parseRequiredStockInteger(input), { ok: true, value: expected, error: null });
}
for (const input of ["", "   ", null, undefined, "texto", -1, "-1", 1.5, "1.5", Number.NaN, Number.POSITIVE_INFINITY, maxProductStock + 1]) {
  assert.equal(parseRequiredStockInteger(input).ok, false, "stock must be rejected: " + String(input));
}
assert.equal(stockPreviewLabel(25, true), "25");
assert.equal(stockPreviewLabel(25, false), "Ignorado");

const workbook = new ExcelJS.Workbook();
const worksheet = workbook.addWorksheet("Productos");
worksheet.addRow(["SKU", "Nombre del producto", "Categoría", "Precio al detalle", "Stock"]);
for (let index = 1; index <= 160; index += 1) {
  worksheet.addRow([
    "XLSX-" + String(index).padStart(3, "0"),
    "Producto " + index,
    "Exterior",
    100 + index,
    index,
  ]);
}
const xlsxBuffer = await workbook.xlsx.writeBuffer();
const loadedWorkbook = new ExcelJS.Workbook();
await loadedWorkbook.xlsx.load(xlsxBuffer);
const parsed = readProductImportWorksheet(loadedWorkbook.worksheets[0]);
assert.equal(parsed.rows.length, 160);
assert.equal(parsed.headers.includes("Stock"), true);
for (let index = 0; index < parsed.rows.length; index += 1) {
  const row = parsed.rows[index];
  const expected = index + 1;
  assert.equal(row.SKU, "XLSX-" + String(expected).padStart(3, "0"));
  assert.equal(parseRequiredStockInteger(row.Stock).value, expected);
}

const productActions = read("src/app/admin/productos/actions.ts");
const productManager = read("src/components/admin/product-manager.tsx");
const permissionMigration = read("supabase/migrations/202607200001_grant_contadora_product_stock_adjustment.sql");
const atomicMigration = read("supabase/migrations/202607200002_atomic_product_import_row.sql");
const catalogConsistencyMigration = read("supabase/migrations/202608080004_product_catalog_consistency_and_sku_guards.sql");
assert.match(productActions, /rpc\("import_product_batch_row_v3_atomic"/);
assert.doesNotMatch(productActions, /Importacion detenida/);
assert.match(productActions, /summary\.stockProcessed/);
assert.match(productActions, /consumed_asset_ids/);
assert.match(productActions, /SKU está repetido dentro de la misma importación/);
assert.match(productActions, /hasOwnProperty\.call\(product, "stock"\)/);
assert.match(productActions, /rowNumbers\?\.\[index\]/);
assert.match(productManager, /stockPreviewLabel\(row\.product\.stock, canAdjustStock\)/);
assert.match(productManager, /Resultado confirmado por el servidor/);
assert.match(productManager, /formato \.xls binario no es compatible/);
assert.doesNotMatch(productManager, /accept="[^"]*\.xls(?:,|")/);
assert.match(permissionMigration, /where name = 'contadora'/);
assert.match(permissionMigration, /products:adjust_stock/);
assert.match(atomicMigration, /save_product_catalog_locked/);
assert.match(atomicMigration, /set_product_stock_locked/);
assert.match(atomicMigration, /row_status := 'skipped'/);
assert.match(catalogConsistencyMigration, /from public\.import_product_row_v2_atomic/);
assert.match(catalogConsistencyMigration, /target_batch\.total_rows > 5000/);

console.log("PRODUCT_IMPORT_STOCK_PERMISSIONS_AND_XLSX_PASS");
