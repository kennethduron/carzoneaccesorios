"use server";

import { createHash } from "node:crypto";
import { writeAuditLog } from "@/lib/audit";
import { getProductCapabilities, requireProductCapability } from "@/lib/auth/product-access";
import { revalidateProductAvailability } from "@/lib/product-availability-cache";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import {
  friendlyProductError,
  imagePayload,
  productPayload,
  removeCloudinaryImages,
  saveProductCanonical,
  type ProductSaveResult,
} from "@/services/product-save.service";
import type { ProductFormInput } from "@/types/products";
import {
  MAX_PRODUCT_IMPORT_ROWS,
  MAX_PRODUCT_XLSX_BYTES,
  validateProductImportLimits,
} from "@/utils/product-import-limits";
import {
  parseRequiredStockInteger,
  productImportBatchSize,
  readProductImportWorksheet,
  type ProductImportSummaryCounters,
} from "@/utils/product-import-stock";

type ProductMutationResult = {
  ok: boolean;
  message: string;
};

export type ProductSaveActionResult = ProductSaveResult;

export type ProductImportMode = "create_and_update" | "create_only" | "update_only";

export type ProductImportRowResult = {
  rowNumber: number;
  sku: string;
  status: "created" | "updated" | "skipped" | "failed";
  stockProcessed: boolean;
  stockApplied: boolean;
  stockUnchanged: boolean;
  movementId: string | null;
  stockBefore: number | null;
  stockAfter: number | null;
  quantity: number | null;
  consumedAssetIds: string[];
  error: string | null;
};

export type ProductImportSummary = ProductImportSummaryCounters;

export type ProductImportResult = ProductMutationResult & {
  summary: ProductImportSummary;
  rows: ProductImportRowResult[];
  pendingRows: Array<{ rowNumber: number; sku: string }>;
  failedBatchNumber: number | null;
  totalBatches: number;
};

export type ProductImportSkuStatusResult = ProductMutationResult & {
  existingSkus?: string[];
};

export type ProductImportPreflightResult = ProductMutationResult & {
  batchId?: string;
  totalRows?: number;
};

type ProductHistoryCounts = {
  orderItems: number;
  invoiceItems: number;
  inventoryMovements: number;
};

type ProductImportRowRpcResult = {
  product_id: string | null;
  row_status: "created" | "updated" | "skipped";
  stock_applied: boolean;
  stock_unchanged: boolean;
  movement_id: string | null;
  stock_before: number | null;
  stock_after: number | null;
  quantity: number | null;
  removed_asset_ids: string[] | null;
  consumed_asset_ids: string[] | null;
};

type StagedProductImportRow = {
  row_number: number;
  normalized_data: { sku?: unknown } | null;
  apply_status: string;
};

function cleanText(value: string | null | undefined) {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeImportHeader(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function importRowSku(row: Record<string, unknown>) {
  const entry = Object.entries(row).find(([header]) => normalizeImportHeader(header) === "sku");
  return String(entry?.[1] ?? "").trim().toUpperCase();
}

function stockIntegerForAdjustment(value: unknown) {
  const parsed = parseRequiredStockInteger(value);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.value;
}

function revalidateProductCatalog(slug?: string | null) {
  revalidateProductAvailability({
    adminPaths: ["/admin/productos", "/admin/inventario", "/admin/reportes"],
    productSlugs: [slug],
  });
}

export async function deleteUploadedProductImageAction(publicId: string): Promise<ProductMutationResult> {
  await requireProductCapability("manageImages");

  const cleanPublicId = cleanText(publicId);
  if (!cleanPublicId) {
    return { ok: true, message: "Imagen omitida." };
  }

  await removeCloudinaryImages([cleanPublicId], { reason: "unsaved_product_image_removed" });
  return { ok: true, message: "Imagen eliminada correctamente." };
}

export async function saveProductAction(input: ProductFormInput): Promise<ProductSaveActionResult> {
  return saveProductCanonical(input);
}
export async function setProductActiveAction(id: string, active: boolean): Promise<ProductMutationResult> {
  await requireProductCapability("update");

  const supabase = await getSupabaseServerClient();
  const { data: product, error } = await supabase
    .from("products")
    .update({
      active,
      status: active ? "active" : "inactive",
    })
    .eq("id", id)
    .select("id, slug, stock, reserved_stock, available_stock, active, status, auto_disabled_by_stock")
    .single<{
      id: string;
      slug: string;
      stock: number;
      reserved_stock: number;
      available_stock: number;
      active: boolean;
      status: string;
      auto_disabled_by_stock: boolean;
    }>();

  if (error) {
    return { ok: false, message: friendlyProductError(error.message) };
  }

  await writeAuditLog({
    tableName: "products",
    recordId: id,
    action: active ? "product.manually_activated" : "product.manually_deactivated",
    newData: {
      requested_active: active,
      active: product.active,
      status: product.status,
      stock: product.stock,
      reserved_stock: product.reserved_stock,
      available_stock: product.available_stock,
      auto_disabled_by_stock: product.auto_disabled_by_stock,
      origin: "product_admin",
    },
  });

  revalidateProductCatalog(product.slug);
  if (active && !product.active && product.auto_disabled_by_stock) {
    return {
      ok: true,
      message: "El producto no tiene inventario disponible y permanecera inactivo hasta que vuelva a tener existencias.",
    };
  }

  return { ok: true, message: active ? "Producto activado correctamente." : "Producto desactivado correctamente." };
}

function isTestProduct(product: { sku: string | null; name: string | null; slug: string | null; internal_code: string | null }) {
  return [product.sku, product.name, product.slug, product.internal_code].some((value) => /\btest\b|^test-|test-|prueba/i.test(value ?? ""));
}

async function getProductHistoryCounts(productId: string): Promise<ProductHistoryCounts> {
  const supabase = await getSupabaseServerClient();
  const [orderItems, invoiceItems, inventoryMovements] = await Promise.all([
    supabase.from("order_items").select("id", { count: "exact", head: true }).eq("product_id", productId),
    supabase.from("invoice_items").select("id", { count: "exact", head: true }).eq("product_id", productId),
    supabase.from("inventory_movements").select("id", { count: "exact", head: true }).eq("product_id", productId),
  ]);

  const error = orderItems.error ?? invoiceItems.error ?? inventoryMovements.error;
  if (error) {
    throw new Error(error.message);
  }

  return {
    orderItems: orderItems.count ?? 0,
    invoiceItems: invoiceItems.count ?? 0,
    inventoryMovements: inventoryMovements.count ?? 0,
  };
}

function hasProductHistory(history: ProductHistoryCounts) {
  return history.orderItems > 0 || history.invoiceItems > 0 || history.inventoryMovements > 0;
}

export async function deleteProductAction(id: string, confirmation?: string): Promise<ProductMutationResult> {
  await requireProductCapability("deleteProducts");

  const supabase = await getSupabaseServerClient();
  const { data: product, error: productError } = await supabase
    .from("products")
    .select("id, sku, internal_code, name, slug")
    .eq("id", id)
    .maybeSingle<{ id: string; sku: string | null; internal_code: string | null; name: string | null; slug: string | null }>();

  if (productError) {
    return { ok: false, message: friendlyProductError(productError.message) };
  }

  if (!product) {
    return { ok: false, message: "No encontramos el producto que intentas eliminar." };
  }

  const history = await getProductHistoryCounts(id);
  const testProduct = isTestProduct(product);
  const hasFiscalOrSalesHistory = history.orderItems > 0 || history.invoiceItems > 0;

  if (hasProductHistory(history) && (!testProduct || confirmation !== "ELIMINAR TEST" || hasFiscalOrSalesHistory)) {
    await writeAuditLog({
      tableName: "products",
      recordId: id,
      action: "product.delete_blocked_history",
      newData: { history, test_product: testProduct },
    });

    return {
      ok: false,
      message:
        "Este producto no puede eliminarse porque tiene historial relacionado. Puedes desactivarlo para que no aparezca en la tienda.",
    };
  }

  if (testProduct && confirmation === "ELIMINAR TEST" && !hasFiscalOrSalesHistory) {
    await supabase.from("inventory_movements").delete().eq("product_id", id);
  }

  const { data: images } = await supabase
    .from("product_images")
    .select("public_id, storage_path")
    .eq("product_id", id)
    .returns<Array<{ public_id: string | null; storage_path: string | null }>>();

  const { error } = await supabase.from("products").delete().eq("id", id);

  if (error) {
    const message =
      error.message.includes("foreign key constraint") || error.message.includes("inventory_movements_product_id_fkey")
        ? "Este producto no puede eliminarse porque tiene historial relacionado. Puedes desactivarlo para que no aparezca en la tienda."
        : friendlyProductError(error.message);

    await writeAuditLog({
      tableName: "products",
      recordId: id,
      action: "product.delete_failed",
      newData: { history, error: error.message },
    });

    return { ok: false, message };
  }

  await removeCloudinaryImages(
    (images ?? []).map((image) => image.public_id ?? image.storage_path).filter((publicId): publicId is string => Boolean(publicId)),
    { product_id: id, reason: "product_deleted" },
  );

  await writeAuditLog({
    tableName: "products",
    recordId: id,
    action: testProduct ? "product.test_deleted" : "product.deleted",
    oldData: { ...product, history },
  });

  revalidateProductCatalog();
  return { ok: true, message: "Producto eliminado correctamente." };
}

export async function preflightProductImportFileAction(formData: FormData): Promise<ProductImportPreflightResult> {
  const profile = await requireProductCapability("importProducts");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: "Selecciona un archivo Excel .xlsx con productos." };
  }
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    return { ok: false, message: "Selecciona un archivo Excel .xlsx. El formato .xls binario no es compatible." };
  }

  const byteLimit = validateProductImportLimits({ bytes: file.size });
  if (!byteLimit.ok) {
    return { ok: false, message: byteLimit.message };
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.byteLength > MAX_PRODUCT_XLSX_BYTES) {
      return { ok: false, message: validateProductImportLimits({ bytes: buffer.byteLength }).message ?? "El archivo es demasiado grande." };
    }

    const ExcelJS = await import("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(arrayBuffer);
    const worksheet = workbook.worksheets[0] ?? null;
    const { rows } = readProductImportWorksheet(worksheet);
    if (rows.length === 0) {
      return { ok: false, message: "El Excel está vacío o no tiene filas de productos." };
    }
    const rowLimit = validateProductImportLimits({ rows: rows.length });
    if (!rowLimit.ok) {
      return { ok: false, message: rowLimit.message };
    }

    const stagedRows = rows.map((row, index) => ({
      row_number: index + 2,
      sku: importRowSku(row),
    }));
    const supabase = await getSupabaseServerClient();
    const { data, error } = await supabase.rpc("create_product_import_preflight", {
      file_name: file.name,
      file_bytes: buffer.byteLength,
      file_sha256: createHash("sha256").update(buffer).digest("hex"),
      row_payload: stagedRows,
    });
    if (error) {
      return { ok: false, message: friendlyProductError(error.message) };
    }

    const batchId = String(data ?? "");
    await writeAuditLog({
      tableName: "import_batches",
      recordId: batchId,
      action: "products.import_preflight_validated",
      newData: {
        batch_id: batchId,
        imported_by: profile.id,
        file_name: file.name,
        file_bytes: buffer.byteLength,
        total_rows: rows.length,
      },
    });
    return {
      ok: true,
      message: `Archivo validado en servidor: ${rows.length.toLocaleString("es-HN")} productos.`,
      batchId,
      totalRows: rows.length,
    };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? `No se pudo validar el Excel en servidor: ${error.message}` : "No se pudo validar el Excel en servidor.",
    };
  }
}

export async function getProductImportSkuStatusAction(skus: string[]): Promise<ProductImportSkuStatusResult> {
  await requireProductCapability("importProducts");
  const supabase = await getSupabaseServerClient();

  const normalizedSkus = Array.from(new Set(skus.map((sku) => sku.trim().toUpperCase()).filter(Boolean))).slice(0, 5000);
  if (normalizedSkus.length === 0) {
    return { ok: true, message: "Sin SKU para validar.", existingSkus: [] };
  }

  const { data, error } = await supabase.from("products").select("sku").in("sku", normalizedSkus);

  if (error) {
    return { ok: false, message: friendlyProductError(error.message), existingSkus: [] };
  }

  return {
    ok: true,
    message: "SKU validados correctamente.",
    existingSkus: (data ?? []).map((row) => String(row.sku ?? "").toUpperCase()).filter(Boolean),
  };
}

export async function importProductsAction(
  products: ProductFormInput[],
  options: {
    batchId?: string;
    mode?: ProductImportMode;
    fileName?: string;
    imageSummary?: {
      uploaded: number;
      missing: number;
      errors: number;
    };
    rowNumbers?: number[];
  } = {},
): Promise<ProductImportResult> {
  const profile = await requireProductCapability("importProducts");
  const capabilities = getProductCapabilities(profile);
  const supabase = await getSupabaseServerClient();
  const mode = options.mode ?? "create_and_update";
  const requestedRows = Array.isArray(products) ? products.length : 0;
  const rows: ProductImportRowResult[] = [];
  const summary: ProductImportSummary = {
    requested: requestedRows,
    totalRows: requestedRows,
    sent: requestedRows,
    created: 0,
    updated: 0,
    skipped: 0,
    previewSkipped: 0,
    serverSkipped: 0,
    failed: 0,
    pending: 0,
    stockProcessed: 0,
    movementsCreated: 0,
    stockUnchanged: 0,
    orphanAssetsCleaned: 0,
  };

  if (!Array.isArray(products) || products.length === 0) {
    return {
      ok: false,
      message: "El archivo no contiene productos para importar.",
      summary,
      rows,
      pendingRows: [],
      failedBatchNumber: null,
      totalBatches: 1,
    };
  }

  const batchId = cleanText(options.batchId);
  if (!batchId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(batchId)) {
    return {
      ok: false,
      message: "La importación no tiene un preflight server-side válido. Vuelve a validar el archivo.",
      summary,
      rows,
      pendingRows: products.map((product, index) => ({ rowNumber: options.rowNumbers?.[index] ?? index + 2, sku: String(product?.sku ?? "") })),
      failedBatchNumber: 1,
      totalBatches: 1,
    };
  }
  if (products.length > productImportBatchSize) {
    return {
      ok: false,
      message: `Cada lote puede contener como máximo ${productImportBatchSize} productos.`,
      summary,
      rows,
      pendingRows: products.map((product, index) => ({ rowNumber: options.rowNumbers?.[index] ?? index + 2, sku: String(product?.sku ?? "") })),
      failedBatchNumber: 1,
      totalBatches: 1,
    };
  }

  const { data: batch, error: batchError } = await supabase
    .from("import_batches")
    .select("id, module, status, created_by, total_rows, metadata")
    .eq("id", batchId)
    .eq("module", "products")
    .eq("created_by", profile.id)
    .maybeSingle();
  if (batchError || !batch || Number(batch.total_rows) < 1 || Number(batch.total_rows) > MAX_PRODUCT_IMPORT_ROWS) {
    return {
      ok: false,
      message: "El lote de importación no existe, expiró o supera el límite permitido. Vuelve a validar el archivo.",
      summary,
      rows,
      pendingRows: products.map((product, index) => ({ rowNumber: options.rowNumbers?.[index] ?? index + 2, sku: String(product?.sku ?? "") })),
      failedBatchNumber: 1,
      totalBatches: 1,
    };
  }

  const requestedRowNumbers = products.map((_, index) => Number(options.rowNumbers?.[index] ?? index + 2));
  if (
    requestedRowNumbers.some((rowNumber) => !Number.isInteger(rowNumber) || rowNumber < 2 || rowNumber > Number(batch.total_rows) + 1) ||
    new Set(requestedRowNumbers).size !== requestedRowNumbers.length
  ) {
    return {
      ok: false,
      message: "Las filas solicitadas no coinciden con el archivo validado en servidor.",
      summary,
      rows,
      pendingRows: products.map((product, index) => ({ rowNumber: requestedRowNumbers[index], sku: String(product?.sku ?? "") })),
      failedBatchNumber: 1,
      totalBatches: 1,
    };
  }

  const { data: stagedRows, error: stagedRowsError } = await supabase
    .from("import_rows")
    .select("row_number, normalized_data, apply_status")
    .eq("batch_id", batchId)
    .in("row_number", requestedRowNumbers)
    .returns<StagedProductImportRow[]>();
  const stagedByRow = new Map((stagedRows ?? []).map((row) => [row.row_number, row]));
  const stagedRowsMatch = !stagedRowsError && products.every((product, index) => {
    const staged = stagedByRow.get(requestedRowNumbers[index]);
    return String(staged?.normalized_data?.sku ?? "").trim().toUpperCase() === String(product?.sku ?? "").trim().toUpperCase();
  });
  if (!stagedRowsMatch) {
    return {
      ok: false,
      message: "El contenido del lote no coincide con las filas del XLSX validado en servidor.",
      summary,
      rows,
      pendingRows: products.map((product, index) => ({ rowNumber: requestedRowNumbers[index], sku: String(product?.sku ?? "") })),
      failedBatchNumber: 1,
      totalBatches: 1,
    };
  }

  const uploadedAssetIds = Array.from(
    new Set(
      products.flatMap((product) =>
        (Array.isArray(product?.images) ? product.images : [])
          .map((image) => cleanText(image.public_id) ?? cleanText(image.storage_path))
          .filter((assetId): assetId is string => Boolean(assetId)),
      ),
    ),
  );
  const consumedAssetIds = new Set<string>();
  const replacedAssetIds = new Set<string>();
  const skuCounts = products.reduce((counts, product) => {
    const sku = typeof product?.sku === "string" ? product.sku.trim().toUpperCase() : "";
    counts.set(sku, (counts.get(sku) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());

  async function writeBulkImportAudit(status: "completed" | "completed_with_errors") {
    await writeAuditLog({
      tableName: "products",
      action: "products.bulk_import",
      newData: {
        user_id: profile.id,
        imported_by: profile.id,
        user_role: profile.role,
        batch_id: batchId,
        status,
        mode,
        file_name: cleanText(options.fileName),
        requested: products.length,
        saved: summary.created + summary.updated,
        created: summary.created,
        updated: summary.updated,
        skipped: summary.skipped,
        failed: summary.failed,
        products_created: summary.created,
        products_updated: summary.updated,
        products_skipped: summary.skipped,
        products_failed: summary.failed,
        stock_processed: summary.stockProcessed,
        stock_movements_created: summary.movementsCreated,
        stock_unchanged: summary.stockUnchanged,
        orphan_assets_cleaned: summary.orphanAssetsCleaned,
        errors_count: summary.failed + (options.imageSummary?.errors ?? 0),
        images_uploaded: options.imageSummary?.uploaded ?? 0,
        images_missing: options.imageSummary?.missing ?? 0,
        image_summary: options.imageSummary ?? null,
        stock_columns_ignored: !capabilities.adjustStock,
        stock_adjustment_authorized: capabilities.adjustStock,
        rows,
        skus: products
          .map((product) => typeof product?.sku === "string" ? product.sku.trim().toUpperCase() : "")
          .filter(Boolean),
      },
    });
  }

  for (const [index, product] of products.entries()) {
    const providedRowNumber = options.rowNumbers?.[index];
    const rowNumber = Number.isInteger(providedRowNumber) && Number(providedRowNumber) >= 2
      ? Number(providedRowNumber)
      : index + 2;
    const sku = typeof product?.sku === "string" ? product.sku.trim().toUpperCase() : "";
    try {
      if (!sku) {
        throw new Error("El SKU es obligatorio.");
      }
      if ((skuCounts.get(sku) ?? 0) > 1) {
        throw new Error("El SKU está repetido dentro de la misma importación.");
      }
      let targetStock: number | null = null;
      if (capabilities.adjustStock) {
        if (!Object.prototype.hasOwnProperty.call(product, "stock")) {
          throw new Error("La propiedad Stock es obligatoria para usuarios autorizados.");
        }
        targetStock = stockIntegerForAdjustment(product.stock);
      }

      const payloadWithStock = productPayload(product);
      const { stock: catalogStock, ...catalogData } = payloadWithStock;
      void catalogStock;
      const images = capabilities.manageImages && product.images.length > 0 ? imagePayload(product.images) : null;
      const { data, error } = await supabase.rpc("import_product_batch_row_v3_atomic", {
        target_batch_id: batchId,
        target_row_number: rowNumber,
        product_data: catalogData,
        images_data: images,
        target_stock: targetStock,
        import_mode: mode,
      });

      if (error) {
        throw new Error(error.message);
      }

      const rpcResult = (Array.isArray(data) ? data[0] : data) as ProductImportRowRpcResult | null;
      if (!rpcResult) {
        throw new Error("La base de datos no devolvió el resultado de la fila.");
      }

      for (const assetId of rpcResult.consumed_asset_ids ?? []) {
        consumedAssetIds.add(assetId);
      }
      for (const assetId of rpcResult.removed_asset_ids ?? []) {
        replacedAssetIds.add(assetId);
      }

      if (rpcResult.row_status === "created") {
        summary.created += 1;
      } else if (rpcResult.row_status === "updated") {
        summary.updated += 1;
      } else {
        summary.skipped += 1;
        summary.serverSkipped += 1;
      }
      if (rpcResult.stock_applied) {
        summary.stockProcessed += 1;
      }
      if (rpcResult.movement_id) {
        summary.movementsCreated += 1;
      }
      if (rpcResult.stock_unchanged) {
        summary.stockUnchanged += 1;
      }

      rows.push({
        rowNumber,
        sku,
        status: rpcResult.row_status,
        stockProcessed: rpcResult.stock_applied,
        stockApplied: rpcResult.stock_applied,
        stockUnchanged: rpcResult.stock_unchanged,
        movementId: rpcResult.movement_id,
        stockBefore: rpcResult.stock_before,
        stockAfter: rpcResult.stock_after,
        quantity: rpcResult.quantity,
        consumedAssetIds: rpcResult.consumed_asset_ids ?? [],
        error: null,
      });
    } catch (error) {
      const message = friendlyProductError(error instanceof Error ? error.message : "No se pudo importar la fila.");
      await supabase
        .from("import_rows")
        .update({ apply_status: "failed", apply_error: message, audit_metadata: { batch_id: batchId, sku } })
        .eq("batch_id", batchId)
        .eq("row_number", rowNumber);
      summary.failed += 1;
      rows.push({
        rowNumber,
        sku,
        status: "failed",
        stockProcessed: false,
        stockApplied: false,
        stockUnchanged: false,
        movementId: null,
        stockBefore: null,
        stockAfter: null,
        quantity: null,
        consumedAssetIds: [],
        error: message,
      });
    }
  }

  await removeCloudinaryImages(Array.from(replacedAssetIds), {
    reason: "product_import_replaced_assets",
    user_id: profile.id,
  });
  const orphanAssetIds = uploadedAssetIds.filter((assetId) => !consumedAssetIds.has(assetId));
  const cleanedOrphanAssets = await removeCloudinaryImages(orphanAssetIds, {
    reason: "product_import_orphan_assets",
    user_id: profile.id,
    failed_rows: summary.failed,
  });
  summary.orphanAssetsCleaned = cleanedOrphanAssets.length;

  await writeBulkImportAudit(summary.failed > 0 ? "completed_with_errors" : "completed");
  await supabase.rpc("recount_import_batch", { target_batch_id: batchId });

  if (summary.created + summary.updated > 0) {
    revalidateProductCatalog();
  }
  const stockNotice = capabilities.adjustStock
    ? summary.stockProcessed +
      " valores de stock procesados, " +
      summary.movementsCreated +
      " movimientos y " +
      summary.stockUnchanged +
      " sin cambio."
    : "El stock del archivo fue ignorado porque el usuario no tiene permiso para ajustarlo.";
  return {
    ok: summary.failed === 0,
    message:
      "Importación por filas completada: " +
      summary.created +
      " creados, " +
      summary.updated +
      " actualizados, " +
      summary.skipped +
      " omitidos y " +
      summary.failed +
      " con error. " +
      stockNotice,
    summary,
    rows,
    pendingRows: [],
    failedBatchNumber: null,
    totalBatches: 1,
  };
}
