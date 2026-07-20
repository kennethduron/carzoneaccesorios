import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import {
  createProductImportSingleFlightGuard,
  createProductImportSummary,
  mergeProductImportBatchSummary,
  productImportBatchSize,
  readProductImportWorksheet,
  runProductImportBatches,
  splitProductImportBatches,
} from "../src/utils/product-import-stock.ts";

function batchSummary(requested, overrides = {}) {
  return {
    requested,
    totalRows: requested,
    sent: requested,
    created: requested,
    updated: 0,
    skipped: 0,
    previewSkipped: 0,
    serverSkipped: 0,
    failed: 0,
    pending: 0,
    stockProcessed: requested,
    movementsCreated: requested,
    stockUnchanged: 0,
    orphanAssetsCleaned: 0,
    ...overrides,
  };
}

// Caso 1: 10 filas, tres omitidas por preview y siete enviadas.
let omittedSummary = createProductImportSummary(10, 3);
omittedSummary = mergeProductImportBatchSummary(omittedSummary, batchSummary(7));
assert.equal(omittedSummary.totalRows, 10);
assert.equal(omittedSummary.sent, 7);
assert.equal(omittedSummary.previewSkipped, 3);
assert.equal(omittedSummary.serverSkipped, 0);
assert.equal(omittedSummary.skipped, 3);
assert.equal(omittedSummary.pending, 0);

// Caso 2: XLSX real de 160 filas, exactamente ocho lotes de 20.
const workbook = new ExcelJS.Workbook();
const worksheet = workbook.addWorksheet("Productos");
worksheet.addRow(["SKU", "Nombre del producto", "Categoría", "Precio al detalle", "Stock"]);
for (let index = 1; index <= 160; index += 1) {
  worksheet.addRow([
    "BATCH-" + String(index).padStart(3, "0"),
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
assert.equal(productImportBatchSize, 20);
assert.equal(splitProductImportBatches(parsed.rows).length, 8);

const storedStock = new Map();
let bulkSummary = createProductImportSummary(160, 0);
const bulkRun = await runProductImportBatches(parsed.rows, async (batch, context) => {
  assert.equal(batch.length, 20);
  assert.equal(context.totalBatches, 8);
  for (const row of batch) {
    assert.equal(storedStock.has(row.SKU), false, "SKU duplicated: " + row.SKU);
    storedStock.set(row.SKU, Number(row.Stock));
  }
  const result = batchSummary(batch.length);
  bulkSummary = mergeProductImportBatchSummary(bulkSummary, result);
  return result;
});
assert.equal(bulkRun.failedBatchNumber, null);
assert.equal(bulkRun.completed.length, 8);
assert.equal(bulkRun.pendingRows.length, 0);
assert.equal(storedStock.size, 160);
assert.equal(bulkSummary.sent, 160);
assert.equal(bulkSummary.created, 160);
assert.equal(bulkSummary.skipped, 0);
assert.equal(bulkSummary.pending, 0);
for (let index = 1; index <= 160; index += 1) {
  assert.equal(storedStock.get("BATCH-" + String(index).padStart(3, "0")), index);
}

// Caso 3: el lote dos falla, el tercero no se envía y 40 filas quedan pendientes.
const sixtyRows = Array.from({ length: 60 }, (_, index) => ({
  rowNumber: index + 2,
  sku: "FAIL-" + String(index + 1).padStart(3, "0"),
  stock: index + 1,
}));
const calledBatches = [];
const confirmedAssets = new Set();
const orphanAssets = new Set();
let failedSummary = createProductImportSummary(60, 0);
const failedRun = await runProductImportBatches(sixtyRows, async (batch, context) => {
  calledBatches.push(context.batchNumber);
  if (context.batchNumber === 1) {
    for (const row of batch) confirmedAssets.add("image/" + row.sku);
    const result = batchSummary(batch.length);
    failedSummary = mergeProductImportBatchSummary(failedSummary, result);
    return result;
  }
  for (const row of batch) orphanAssets.add("image/" + row.sku);
  orphanAssets.clear();
  throw new Error("Simulated network timeout");
});
assert.deepEqual(calledBatches, [1, 2]);
assert.equal(failedRun.completed.length, 1);
assert.equal(failedRun.failedBatchNumber, 2);
assert.equal(failedRun.pendingRows.length, 40);
failedSummary = { ...failedSummary, pending: failedRun.pendingRows.length };
assert.equal(failedSummary.sent, 20);
assert.equal(failedSummary.created, 20);
assert.equal(failedSummary.failed, 0);
assert.equal(failedSummary.pending, 40);
assert.equal(confirmedAssets.size, 20);
assert.equal(orphanAssets.size, 0);
assert.equal(failedRun.pendingRows[0].sku, "FAIL-021");
assert.equal(failedRun.pendingRows.at(-1).sku, "FAIL-060");

// Caso 4: simula respuesta perdida después de confirmar el lote dos.
const absoluteStock = new Map();
let movementCount = 0;
function applyAbsoluteStock(rows) {
  for (const row of rows) {
    const before = absoluteStock.get(row.sku) ?? 0;
    if (before !== row.stock) movementCount += 1;
    absoluteStock.set(row.sku, row.stock);
  }
}
applyAbsoluteStock(sixtyRows.slice(0, 20));
applyAbsoluteStock(sixtyRows.slice(20, 40));
const movementsAfterUnknownCommit = movementCount;
const retriedSkus = [];
const retryRun = await runProductImportBatches(failedRun.pendingRows, async (batch) => {
  retriedSkus.push(...batch.map((row) => row.sku));
  applyAbsoluteStock(batch);
  return batchSummary(batch.length);
});
assert.equal(retryRun.failedBatchNumber, null);
assert.equal(retriedSkus.includes("FAIL-001"), false);
assert.equal(retriedSkus[0], "FAIL-021");
assert.equal(movementsAfterUnknownCommit, 40);
assert.equal(movementCount, 60, "absolute stock must not duplicate movements for rows 21-40");
assert.equal(absoluteStock.size, 60);

// Caso 5: dos activaciones inmediatas solo permiten iniciar una ejecución.
const guard = createProductImportSingleFlightGuard();
let starts = 0;
async function attemptImport() {
  if (!guard.tryStart()) return;
  starts += 1;
  await Promise.resolve();
  guard.finish();
}
const firstAttempt = attemptImport();
const secondAttempt = attemptImport();
await Promise.all([firstAttempt, secondAttempt]);
assert.equal(starts, 1);
assert.equal(guard.isActive(), false);

console.log(JSON.stringify({
  status: "PRODUCT_IMPORT_BATCHING_PASS",
  omitted: omittedSummary.skipped,
  sent: omittedSummary.sent,
  xlsxRows: parsed.rows.length,
  batches: bulkRun.completed.length,
  pendingAfterBatchFailure: failedRun.pendingRows.length,
  duplicateMovements: 0,
  doubleClickStarts: starts,
}));
