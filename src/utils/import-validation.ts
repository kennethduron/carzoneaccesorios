import type { ImportPreviewRow, ImportValidationMessage, ImportValidationResult } from "@/types/import-foundation";

export const sharedImportMaxRows = 1000;

export function cleanImportText(value: unknown) {
  return String(value ?? "").trim();
}

export function normalizeImportLabel(value: unknown) {
  return cleanImportText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function validateImportRowLimit(rowCount: number, maxRows = sharedImportMaxRows) {
  if (rowCount <= maxRows) return null;
  return `El archivo excede el limite de ${maxRows.toLocaleString("es-HN")} filas por importacion.`;
}

export function validateRequiredImportFields(rowNumber: number, row: Record<string, unknown>, requiredFields: Array<{ key: string; label: string }>) {
  const messages: ImportValidationMessage[] = [];

  for (const field of requiredFields) {
    if (!cleanImportText(row[field.key])) {
      messages.push({
        rowNumber,
        field: field.key,
        message: `Fila ${rowNumber}: "${field.label}" es obligatorio.`,
      });
    }
  }

  return messages;
}

export function validateDuplicateImportRows<T extends Record<string, unknown>>(
  rows: Array<{ rowNumber: number; data: T }>,
  keys: string[],
  label: string,
) {
  const messages: ImportValidationMessage[] = [];
  const seen = new Map<string, number>();

  for (const row of rows) {
    const fingerprint = keys.map((key) => normalizeImportLabel(row.data[key])).join("|");
    if (!fingerprint.replace(/\|/g, "")) continue;

    const firstRow = seen.get(fingerprint);
    if (firstRow) {
      messages.push({
        rowNumber: row.rowNumber,
        message: `Fila ${row.rowNumber}: ${label} duplicado; ya aparece en la fila ${firstRow}.`,
      });
    } else {
      seen.set(fingerprint, row.rowNumber);
    }
  }

  return messages;
}

export function buildImportValidationResult(rows: ImportPreviewRow[], globalErrors: string[] = []): ImportValidationResult {
  const rowErrors = rows.flatMap((row) => row.validationMessages);
  const errors = [...globalErrors, ...rowErrors];

  return {
    ok: errors.length === 0,
    rows,
    errors,
  };
}

export function buildImportPreviewRow(input: {
  rowNumber: number;
  originalData: Record<string, unknown>;
  normalizedData?: Record<string, unknown>;
  validationMessages?: string[];
  assignmentType?: ImportPreviewRow["assignmentType"];
  assignmentStatus?: ImportPreviewRow["assignmentStatus"];
  suggestedCustomerId?: string | null;
  suggestedSupplierId?: string | null;
  assignedCustomerId?: string | null;
  assignedSupplierId?: string | null;
}): ImportPreviewRow {
  const validationMessages = input.validationMessages ?? [];

  return {
    rowNumber: input.rowNumber,
    originalData: input.originalData,
    normalizedData: input.normalizedData ?? {},
    validationStatus: validationMessages.length > 0 ? "invalid" : "valid",
    validationMessages,
    assignmentType: input.assignmentType ?? "none",
    assignmentStatus: input.assignmentStatus ?? "not_required",
    applyStatus: "pending",
    suggestedCustomerId: input.suggestedCustomerId ?? null,
    suggestedSupplierId: input.suggestedSupplierId ?? null,
    assignedCustomerId: input.assignedCustomerId ?? null,
    assignedSupplierId: input.assignedSupplierId ?? null,
  };
}
