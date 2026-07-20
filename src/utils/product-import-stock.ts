export const maxProductStock = 2147483647;
export const productImportBatchSize = 20;

export type ProductImportSummaryCounters = {
  requested: number;
  totalRows: number;
  sent: number;
  created: number;
  updated: number;
  skipped: number;
  previewSkipped: number;
  serverSkipped: number;
  failed: number;
  pending: number;
  stockProcessed: number;
  movementsCreated: number;
  stockUnchanged: number;
  orphanAssetsCleaned: number;
};

type ProductImportBatchSummary = Omit<ProductImportSummaryCounters, "totalRows" | "previewSkipped" | "pending"> &
  Partial<Pick<ProductImportSummaryCounters, "totalRows" | "previewSkipped" | "pending">>;

export function createProductImportSummary(totalRows: number, previewSkipped: number): ProductImportSummaryCounters {
  return {
    requested: totalRows,
    totalRows,
    sent: 0,
    created: 0,
    updated: 0,
    skipped: previewSkipped,
    previewSkipped,
    serverSkipped: 0,
    failed: 0,
    pending: Math.max(0, totalRows - previewSkipped),
    stockProcessed: 0,
    movementsCreated: 0,
    stockUnchanged: 0,
    orphanAssetsCleaned: 0,
  };
}

export function mergeProductImportBatchSummary(
  current: ProductImportSummaryCounters,
  batch: ProductImportBatchSummary,
): ProductImportSummaryCounters {
  const serverSkipped = current.serverSkipped + batch.serverSkipped;
  const sent = current.sent + batch.sent;
  return {
    requested: current.totalRows,
    totalRows: current.totalRows,
    sent,
    created: current.created + batch.created,
    updated: current.updated + batch.updated,
    skipped: current.previewSkipped + serverSkipped,
    previewSkipped: current.previewSkipped,
    serverSkipped,
    failed: current.failed + batch.failed,
    pending: Math.max(0, current.totalRows - current.previewSkipped - sent),
    stockProcessed: current.stockProcessed + batch.stockProcessed,
    movementsCreated: current.movementsCreated + batch.movementsCreated,
    stockUnchanged: current.stockUnchanged + batch.stockUnchanged,
    orphanAssetsCleaned: current.orphanAssetsCleaned + batch.orphanAssetsCleaned,
  };
}

export function splitProductImportBatches<T>(rows: T[], batchSize = productImportBatchSize) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("Invalid batch size.");
  const batches: T[][] = [];
  for (let index = 0; index < rows.length; index += batchSize) {
    batches.push(rows.slice(index, index + batchSize));
  }
  return batches;
}

export type ProductImportBatchContext = {
  batchNumber: number;
  totalBatches: number;
  processedBefore: number;
  totalRows: number;
};

export type ProductImportBatchRunResult<T, R> = {
  completed: Array<{ rows: T[]; result: R }>;
  pendingRows: T[];
  failedBatchNumber: number | null;
  error: unknown;
};

export async function runProductImportBatches<T, R>(
  rows: T[],
  processBatch: (batch: T[], context: ProductImportBatchContext) => Promise<R>,
  batchSize = productImportBatchSize,
): Promise<ProductImportBatchRunResult<T, R>> {
  const batches = splitProductImportBatches(rows, batchSize);
  const completed: Array<{ rows: T[]; result: R }> = [];
  let processedBefore = 0;
  for (const [index, batch] of batches.entries()) {
    try {
      const result = await processBatch(batch, {
        batchNumber: index + 1,
        totalBatches: batches.length,
        processedBefore,
        totalRows: rows.length,
      });
      completed.push({ rows: batch, result });
      processedBefore += batch.length;
    } catch (error) {
      return {
        completed,
        pendingRows: batches.slice(index).flat(),
        failedBatchNumber: index + 1,
        error,
      };
    }
  }
  return { completed, pendingRows: [], failedBatchNumber: null, error: null };
}

export function createProductImportSingleFlightGuard() {
  let active = false;
  return {
    tryStart() {
      if (active) return false;
      active = true;
      return true;
    },
    finish() {
      active = false;
    },
    isActive() {
      return active;
    },
  };
}

export type StockParseResult =
  | { ok: true; value: number; error: null }
  | { ok: false; value: null; error: string };

export function parseRequiredStockInteger(value: unknown): StockParseResult {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { ok: false, value: null, error: "El stock debe ser un número entero no negativo." };
    }
    if (!Number.isInteger(value)) {
      return { ok: false, value: null, error: "El stock debe ser un número entero." };
    }
    if (value < 0) {
      return { ok: false, value: null, error: "El stock no puede ser negativo." };
    }
    if (value > maxProductStock) {
      return { ok: false, value: null, error: "El stock supera el límite permitido." };
    }
    return { ok: true, value, error: null };
  }

  if (typeof value !== "string") {
    return { ok: false, value: null, error: "El stock es obligatorio y debe ser un número entero no negativo." };
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return { ok: false, value: null, error: "El stock es obligatorio para aplicar inventario." };
  }
  if (trimmed.startsWith("-")) {
    return { ok: false, value: null, error: "El stock no puede ser negativo." };
  }
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, value: null, error: "El stock debe ser un número entero no negativo." };
  }

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed > maxProductStock) {
    return { ok: false, value: null, error: "El stock supera el límite permitido." };
  }

  return { ok: true, value: parsed, error: null };
}

export function excelCellToText(value: unknown) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const cellObject = value as { text?: unknown; result?: unknown; richText?: Array<{ text?: unknown }> };
    if (cellObject.text !== undefined) return String(cellObject.text);
    if (cellObject.result !== undefined) return String(cellObject.result);
    if (Array.isArray(cellObject.richText)) return cellObject.richText.map((part) => String(part.text ?? "")).join("");
  }
  return String(value);
}

type ExcelRowLike = { values: unknown };

export type ExcelWorksheetLike = {
  getRow(rowNumber: number): ExcelRowLike;
  eachRow(callback: (row: ExcelRowLike, rowNumber: number) => void): void;
};

export function readProductImportWorksheet(worksheet: ExcelWorksheetLike | null | undefined) {
  if (!worksheet) return { headers: [] as string[], rows: [] as Array<Record<string, string>> };

  const headerValues = Array.isArray(worksheet.getRow(1).values)
    ? (worksheet.getRow(1).values as unknown[]).slice(1).map((value) => excelCellToText(value).trim())
    : [];
  const rows: Array<Record<string, string>> = [];

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1 || !Array.isArray(row.values)) return;
    const values = row.values as unknown[];
    const rowObject = Object.fromEntries(
      headerValues.map((header, index) => [header, excelCellToText(values[index + 1]).trim()]),
    );
    if (Object.values(rowObject).some((value) => value.trim())) rows.push(rowObject);
  });

  return { headers: headerValues, rows };
}

export function stockPreviewLabel(stock: number, canAdjustStock: boolean) {
  return canAdjustStock ? stock.toLocaleString("es-HN") : "Ignorado";
}
