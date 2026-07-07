import "server-only";

import ExcelJS from "exceljs";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { chartAccountTypeLabels, chartNormalBalanceLabels } from "@/services/supabase/accounting-catalog.service";
import type { ChartOfAccountsExportData, ChartOfAccountsExportRow } from "@/types/accounting-catalog";
import { formatHnDateTime } from "@/utils/format";

const companyName = "Car Zone Accesorios";
const headers = ["Código", "Nombre de la cuenta", "Tipo", "Naturaleza", "Cuenta padre", "Activa", "Descripción"];

function responseFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function rowValues(row: ChartOfAccountsExportRow) {
  return [
    row.code,
    row.name,
    chartAccountTypeLabels[row.type],
    chartNormalBalanceLabels[row.normal_balance],
    row.parent_code,
    row.is_active ? "Sí" : "No",
    row.description,
  ];
}

function styleCatalogWorksheet(worksheet: ExcelJS.Worksheet, headerRow = 4) {
  worksheet.views = [{ state: "frozen", ySplit: headerRow }];
  worksheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: headerRow, column: headers.length },
  };
  worksheet.getRow(1).font = { bold: true, size: 14 };
  worksheet.getRow(headerRow).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(headerRow).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF080808" } };
  worksheet.getRow(headerRow).alignment = { vertical: "middle" };
  worksheet.columns.forEach((column) => {
    let maxLength = 12;
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      maxLength = Math.max(maxLength, String(cell.value ?? "").length + 2);
    });
    column.width = Math.min(Math.max(maxLength, 12), 42);
  });
}

export async function buildChartOfAccountsTemplateResponse() {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = companyName;
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("Plantilla");
  worksheet.addRow(headers);
  worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF080808" } };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: headers.length },
  };
  worksheet.columns = [
    { width: 16 },
    { width: 34 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
    { width: 14 },
    { width: 42 },
  ];

  for (let row = 2; row <= 501; row += 1) {
    worksheet.getCell(`C${row}`).dataValidation = {
      type: "list",
      allowBlank: false,
      formulae: ['"Activo,Pasivo,Patrimonio,Ingreso,Costo,Gasto"'],
    };
    worksheet.getCell(`D${row}`).dataValidation = {
      type: "list",
      allowBlank: false,
      formulae: ['"Débito,Crédito"'],
    };
    worksheet.getCell(`F${row}`).dataValidation = {
      type: "list",
      allowBlank: false,
      formulae: ['"Sí,No"'],
    };
  }

  const valuesSheet = workbook.addWorksheet("Valores permitidos");
  valuesSheet.addRows([
    ["Tipo", "Naturaleza", "Activa"],
    ["Activo", "Débito", "Sí"],
    ["Pasivo", "Crédito", "No"],
    ["Patrimonio", "", ""],
    ["Ingreso", "", ""],
    ["Costo", "", ""],
    ["Gasto", "", ""],
  ]);
  valuesSheet.columns = [{ width: 20 }, { width: 18 }, { width: 14 }];
  valuesSheet.getRow(1).font = { bold: true };

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${responseFileName("car-zone-plantilla-catalogo-cuentas.xlsx")}"`,
    },
  });
}

export async function buildChartOfAccountsExcelResponse(data: ChartOfAccountsExportData) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = companyName;
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("Catálogo");
  worksheet.addRow([companyName]);
  worksheet.addRow(["Catálogo de cuentas"]);
  worksheet.addRow([`Generado: ${formatHnDateTime(data.generatedAt)}`]);
  worksheet.addRow(headers);
  data.rows.forEach((row) => worksheet.addRow(rowValues(row)));
  styleCatalogWorksheet(worksheet);

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${responseFileName("car-zone-catalogo-cuentas.xlsx")}"`,
    },
  });
}

function addPdfPageNumbers(doc: jsPDF) {
  const totalPages = doc.getNumberOfPages();
  for (let page = 1; page <= totalPages; page += 1) {
    doc.setPage(page);
    doc.setFontSize(8);
    doc.text(`Página ${page} de ${totalPages}`, doc.internal.pageSize.getWidth() - 34, doc.internal.pageSize.getHeight() - 8);
  }
}

export function buildChartOfAccountsPdfResponse(data: ChartOfAccountsExportData) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm" });
  doc.setFontSize(16);
  doc.text(companyName, 14, 14);
  doc.setFontSize(13);
  doc.text("Catálogo de cuentas", 14, 22);
  doc.setFontSize(9);
  doc.text(`Generado: ${formatHnDateTime(data.generatedAt)}`, 14, 29);

  autoTable(doc, {
    startY: 36,
    head: [headers],
    body: data.rows.map(rowValues),
    styles: { fontSize: 7, cellPadding: 2, overflow: "linebreak" },
    headStyles: { fillColor: [8, 8, 8], textColor: [255, 255, 255] },
    alternateRowStyles: { fillColor: [250, 250, 250] },
  });

  addPdfPageNumbers(doc);
  return new Response(doc.output("arraybuffer"), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${responseFileName("car-zone-catalogo-cuentas.pdf")}"`,
    },
  });
}

function csvCell(value: string) {
  const escaped = value.replaceAll('"', '""');
  return `"${escaped}"`;
}

export function buildChartOfAccountsCsvResponse(data: ChartOfAccountsExportData) {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of data.rows) {
    lines.push(rowValues(row).map((value) => csvCell(String(value ?? ""))).join(","));
  }

  return new Response(`\uFEFF${lines.join("\r\n")}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${responseFileName("car-zone-catalogo-cuentas.csv")}"`,
    },
  });
}
