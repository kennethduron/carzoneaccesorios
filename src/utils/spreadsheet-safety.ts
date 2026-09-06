const dangerousSpreadsheetText = /^[\u0000-\u0020]*[=+\-@]/;

/** Keeps text as text when a CSV/XLSX is opened by spreadsheet software. */
export function spreadsheetSafeText(value: unknown) {
  const text = String(value ?? "");
  return dangerousSpreadsheetText.test(text) ? `'${text}` : text;
}

export function csvText(value: unknown) {
  return `"${spreadsheetSafeText(value).replaceAll('"', '""')}"`;
}

export function csvNumber(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return String(value);
}

export function buildUtf8BomCsv(rows: Array<Array<string | number | null | undefined>>) {
  return `\uFEFF${rows
    .map((row) => row.map((value) => (typeof value === "number" ? csvNumber(value) : csvText(value))).join(","))
    .join("\r\n")}`;
}
