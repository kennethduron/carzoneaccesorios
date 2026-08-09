import "server-only";

import ExcelJS from "exceljs";
import type { ProductAdminRow } from "@/types/products";

const companyName = "Car Zone Accesorios";

function spreadsheetSafeText(value: unknown) {
  const text = String(value ?? "");
  return /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
}

function exportDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

export function productCatalogExportHeaders(includeCost: boolean) {
  return [
    "SKU",
    "Código OEM / proveedor",
    "Nombre",
    "Categoría",
    "Marca",
    ...(includeCost ? ["Costo"] : []),
    "Precio al detalle",
    "Precio mayorista",
    "Existencia",
    "Stock mínimo",
    "Estado",
    "Tipo",
  ];
}

export function productCatalogExportValues(product: ProductAdminRow, includeCost: boolean) {
  return [
    spreadsheetSafeText(product.sku),
    spreadsheetSafeText(product.internal_code),
    spreadsheetSafeText(product.name),
    spreadsheetSafeText(product.category_name),
    spreadsheetSafeText(product.brand),
    ...(includeCost ? [product.cost_price ?? 0] : []),
    product.retail_price,
    product.wholesale_price,
    product.stock,
    product.min_stock,
    product.active ? "Activo" : "Inactivo",
    product.is_new ? "Nuevo" : "Regular",
  ];
}

export async function buildProductCatalogExcelResponse(products: ProductAdminRow[], includeCost: boolean) {
  const headers = productCatalogExportHeaders(includeCost);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = companyName;
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet("Productos");
  worksheet.addRow([companyName]);
  worksheet.addRow(["Productos que coinciden con los filtros aplicados"]);
  worksheet.addRow([`Total de productos: ${products.length.toLocaleString("es-HN")}`]);
  worksheet.addRow(headers);
  products.forEach((product) => worksheet.addRow(productCatalogExportValues(product, includeCost)));

  worksheet.views = [{ state: "frozen", ySplit: 4 }];
  worksheet.autoFilter = {
    from: { row: 4, column: 1 },
    to: { row: 4, column: headers.length },
  };
  worksheet.getRow(1).font = { bold: true, size: 14 };
  worksheet.getRow(4).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF080808" } };
  worksheet.columns.forEach((column) => {
    let maxLength = 12;
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      maxLength = Math.max(maxLength, String(cell.value ?? "").length + 2);
    });
    column.width = Math.min(Math.max(maxLength, 12), 42);
  });

  for (let rowNumber = 5; rowNumber <= products.length + 4; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const costOffset = includeCost ? 1 : 0;
    if (includeCost) row.getCell(6).numFmt = '"L" #,##0.00';
    row.getCell(6 + costOffset).numFmt = '"L" #,##0.00';
    row.getCell(7 + costOffset).numFmt = '"L" #,##0.00';
    row.getCell(8 + costOffset).numFmt = "0";
    row.getCell(9 + costOffset).numFmt = "0";
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(buffer, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="car-zone-productos-${exportDate()}.xlsx"`,
    },
  });
}

function csvCell(value: unknown) {
  return `"${spreadsheetSafeText(value).replaceAll('"', '""')}"`;
}

export function buildProductCatalogCsvResponse(products: ProductAdminRow[], includeCost: boolean) {
  const rows = [productCatalogExportHeaders(includeCost).map(csvCell).join(",")];
  products.forEach((product) => rows.push(productCatalogExportValues(product, includeCost).map(csvCell).join(",")));
  return new Response(`\uFEFF${rows.join("\r\n")}`, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="car-zone-productos-${exportDate()}.csv"`,
    },
  });
}
