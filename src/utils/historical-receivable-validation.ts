import type { HistoricalReceivablePreviewSummary, HistoricalReceivableRowFilter } from "@/types/accounts-receivable-import";
import type { ImportRow } from "@/types/import-foundation";

export const invalidOriginalAmountMessage = "El importe original debe ser mayor que L 0.00 antes de confirmar esta fila.";

export function hasInvalidHistoricalOriginalAmount(row: Pick<ImportRow, "normalized_data">) {
  const amount = Number(row.normalized_data.original_amount);
  return !Number.isFinite(amount) || amount <= 0;
}

export function withEffectiveHistoricalValidation(row: ImportRow): ImportRow {
  if (!hasInvalidHistoricalOriginalAmount(row)) return row;
  return {
    ...row,
    validation_status: "invalid",
    validation_messages: row.validation_messages.includes(invalidOriginalAmountMessage)
      ? row.validation_messages
      : [...row.validation_messages, invalidOriginalAmountMessage],
  };
}

export function importRowMatchesFilter(row: ImportRow, filter: HistoricalReceivableRowFilter) {
  if (filter === "all") return true;
  if (filter === "errors") return row.validation_status === "invalid" || row.apply_status === "failed";
  if (filter === "applied") return row.apply_status === "applied";
  if (filter === "cancelled") return row.apply_status === "skipped";
  if (filter === "rolled_back") return row.apply_status === "rolled_back";
  if (filter === "review") return !["applied", "skipped", "failed", "rolled_back"].includes(row.apply_status)
    && row.validation_status !== "invalid"
    && (row.validation_status === "warning" || row.assignment_status !== "confirmed");
  return !["applied", "skipped", "failed", "rolled_back"].includes(row.apply_status)
    && row.validation_status === "valid"
    && row.assignment_status === "confirmed";
}

export function importRowMatchesSearch(row: ImportRow, query: string) {
  const needle = query.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  if (!needle) return true;
  return JSON.stringify([row.row_number, row.normalized_data.customer_name, row.normalized_data.invoice_number,
    row.normalized_data.reference, row.validation_messages, row.apply_error])
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().includes(needle);
}

export function alignHistoricalPreview(preview: HistoricalReceivablePreviewSummary, rows: ImportRow[]) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const outcomes = preview.rows.map((outcome) => {
    const row = byId.get(outcome.row_id);
    return row && hasInvalidHistoricalOriginalAmount(row)
      ? { ...outcome, outcome: "review_required" as const, reason: invalidOriginalAmountMessage }
      : outcome;
  });
  const count = (value: string) => outcomes.filter((row) => row.outcome === value).length;
  return {
    ...preview,
    rows: outcomes,
    create_customers: count("create_customer"),
    reuse_customers: count("reuse_customer"),
    create_receivables: count("create_customer") + count("reuse_customer"),
    duplicates: count("duplicate"),
    ambiguous: count("ambiguous"),
    rejected: count("rejected"),
    review_required: count("review_required"),
    processable: count("create_customer") + count("reuse_customer"),
  } satisfies HistoricalReceivablePreviewSummary;
}
