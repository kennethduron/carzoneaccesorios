import "server-only";

import ExcelJS from "exceljs";
import type { ImportTemplateDefinition } from "@/types/import-foundation";

export function importCellText(cell: ExcelJS.Cell) {
  const value = cell.value;
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((item) => item.text).join("").trim();
    }
    if ("text" in value && typeof value.text === "string") return value.text.trim();
    if ("result" in value) return String(value.result ?? "").trim();
  }

  return String(value ?? "").trim();
}

export function styleImportWorksheet(worksheet: ExcelJS.Worksheet, headerRow = 4) {
  const header = worksheet.getRow(headerRow);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF080808" } };
  header.alignment = { vertical: "middle", wrapText: true };

  worksheet.columns.forEach((column) => {
    let maxLength = 12;
    column.eachCell?.({ includeEmpty: false }, (cell) => {
      maxLength = Math.max(maxLength, String(cell.value ?? "").length + 2);
    });
    column.width = Math.min(Math.max(maxLength, 12), 42);
  });

  worksheet.views = [{ state: "frozen", ySplit: headerRow }];
  worksheet.autoFilter = {
    from: { row: headerRow, column: 1 },
    to: { row: headerRow, column: worksheet.columnCount },
  };
}

export async function buildImportTemplateWorkbook(definition: ImportTemplateDefinition) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Car Zone ERP";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet(definition.sheetName);
  worksheet.mergeCells(1, 1, 1, Math.max(definition.columns.length, 1));
  worksheet.getCell(1, 1).value = definition.title;
  worksheet.getCell(1, 1).font = { bold: true, size: 16 };
  worksheet.getCell(2, 1).value = definition.description;
  worksheet.getCell(2, 1).alignment = { wrapText: true };
  worksheet.getRow(4).values = ["", ...definition.columns.map((column) => column.label)];

  for (const [index, column] of definition.columns.entries()) {
    const excelColumn = index + 1;
    worksheet.getColumn(excelColumn).width = column.width ?? 20;

    if (column.dropdownOptions && column.dropdownOptions.length > 0) {
      const quotedOptions = column.dropdownOptions.join(",");
      for (let row = 5; row <= 1004; row += 1) {
        worksheet.getCell(row, excelColumn).dataValidation = {
          type: "list",
          allowBlank: !column.required,
          formulae: [`"${quotedOptions}"`],
          showErrorMessage: true,
          errorTitle: "Valor no valido",
          error: "Selecciona un valor de la lista.",
        };
      }
    }

    if (column.readOnly) {
      worksheet.getColumn(excelColumn).font = { color: { argb: "FF555555" } };
    }
  }

  for (const example of definition.examples ?? []) {
    worksheet.addRow(definition.columns.map((column) => example[column.key] ?? ""));
  }

  styleImportWorksheet(worksheet);

  const instructions = workbook.addWorksheet("Instrucciones");
  instructions.columns = [{ width: 110 }];
  instructions.getCell("A1").value = definition.title;
  instructions.getCell("A1").font = { bold: true, size: 15 };
  instructions.getCell("A3").value = "Reglas generales";
  instructions.getCell("A3").font = { bold: true };
  (definition.instructions ?? []).forEach((instruction, index) => {
    instructions.getCell(index + 4, 1).value = instruction;
    instructions.getCell(index + 4, 1).alignment = { wrapText: true };
  });

  const validationSheet = workbook.addWorksheet("Validaciones");
  validationSheet.columns = [{ header: "Columna", width: 28 }, { header: "Tipo", width: 18 }, { header: "Valores", width: 60 }];
  definition.columns.forEach((column) => {
    validationSheet.addRow([
      column.label,
      column.required ? "Obligatoria" : column.readOnly ? "Solo lectura" : "Opcional",
      column.dropdownOptions?.join(", ") ?? "",
    ]);
  });

  return workbook;
}

export async function buildImportTemplateResponse(definition: ImportTemplateDefinition, fileName: string) {
  const workbook = await buildImportTemplateWorkbook(definition);
  const buffer = await workbook.xlsx.writeBuffer();

  return new Response(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
    },
  });
}
