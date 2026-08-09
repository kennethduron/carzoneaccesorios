export const MAX_PRODUCT_IMPORT_ROWS = 5_000;
export const MAX_PRODUCT_XLSX_BYTES = 10 * 1024 * 1024;

// The compressed limit preserves the existing product-import contract.
export const MAX_PRODUCT_ZIP_BYTES = 250 * 1024 * 1024;
export const MAX_PRODUCT_ZIP_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
export const MAX_PRODUCT_ZIP_ENTRIES = 10_000;

export const productImportRowLimitMessage =
  "El archivo contiene más de 5,000 productos. Divida la importación en archivos más pequeños.";

export const productImportSizeLimitMessage =
  "El archivo Excel supera el límite de 10 MiB. Divida la importación en archivos más pequeños.";

export function validateProductImportLimits(input: { rows?: number; bytes?: number }) {
  if (typeof input.bytes === "number" && input.bytes > MAX_PRODUCT_XLSX_BYTES) {
    return { ok: false as const, message: productImportSizeLimitMessage };
  }

  if (typeof input.rows === "number" && input.rows > MAX_PRODUCT_IMPORT_ROWS) {
    return { ok: false as const, message: productImportRowLimitMessage };
  }

  return { ok: true as const };
}
