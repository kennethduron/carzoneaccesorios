type AdminReportRow = Record<string, string | number>;

function csvEscape(value: string | number) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function buildAdminReportCsv(columns: string[], rows: AdminReportRow[]) {
  return [columns.map(csvEscape).join(","), ...rows.map((row) => columns.map((column) => csvEscape(row[column] ?? "")).join(","))].join("\n");
}

function htmlEscape(value: string | number) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function buildAdminReportExcelTable(title: string, columns: string[], rows: AdminReportRow[]) {
  const header = columns.map((column) => `<th>${htmlEscape(column)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${columns.map((column) => `<td>${htmlEscape(row[column] ?? "")}</td>`).join("")}</tr>`)
    .join("");

  return `
    <html>
      <head><meta charset="utf-8" /></head>
      <body>
        <h1>${htmlEscape(title)}</h1>
        <table border="1">
          <thead><tr>${header}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </body>
    </html>
  `;
}
