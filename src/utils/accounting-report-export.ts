import "server-only";

import ExcelJS from "exceljs";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { GeneralLedgerReportData, TrialBalanceReportData } from "@/types/accounting-reports";
import { formatHnDate, formatHnDateTime } from "@/utils/format";
import { formatCurrency } from "@/utils/pricing";

const companyName = "Car Zone Accesorios";

const accountTypeLabels: Record<string, string> = {
  asset: "Activo",
  liability: "Pasivo",
  equity: "Patrimonio",
  revenue: "Ingresos",
  cost: "Costos",
  expense: "Gastos",
};

type PdfTable = {
  title: string;
  subtitle: string;
  generatedAt: string;
  fileName: string;
  headers: string[];
  rows: string[][];
  totals: string[];
};

function responseFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function addPdfPageNumbers(doc: jsPDF) {
  const totalPages = doc.getNumberOfPages();
  for (let page = 1; page <= totalPages; page += 1) {
    doc.setPage(page);
    doc.setFontSize(8);
    doc.text(`Página ${page} de ${totalPages}`, doc.internal.pageSize.getWidth() - 34, doc.internal.pageSize.getHeight() - 8);
  }
}

export function buildPdfResponse(table: PdfTable) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm" });
  doc.setFontSize(16);
  doc.text(companyName, 14, 14);
  doc.setFontSize(13);
  doc.text(table.title, 14, 22);
  doc.setFontSize(9);
  doc.text(table.subtitle, 14, 29);
  doc.text(`Generado: ${formatHnDateTime(table.generatedAt)}`, 14, 35);

  autoTable(doc, {
    startY: 42,
    head: [table.headers],
    body: table.rows,
    foot: [table.totals],
    styles: { fontSize: 7, cellPadding: 2, overflow: "linebreak" },
    headStyles: { fillColor: [8, 8, 8], textColor: [255, 255, 255] },
    footStyles: { fillColor: [244, 244, 245], textColor: [8, 8, 8], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [250, 250, 250] },
  });

  addPdfPageNumbers(doc);
  return new Response(doc.output("arraybuffer"), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${responseFileName(table.fileName)}"`,
    },
  });
}

function styleWorksheet(worksheet: ExcelJS.Worksheet) {
  worksheet.views = [{ state: "frozen", ySplit: 4 }];
  worksheet.getRow(1).font = { bold: true, size: 14 };
  worksheet.getRow(4).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(4).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF080808" } };
  worksheet.getRow(4).alignment = { vertical: "middle" };
  worksheet.columns.forEach((column) => {
    let maxLength = 12;
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      maxLength = Math.max(maxLength, String(cell.value ?? "").length + 2);
    });
    column.width = Math.min(Math.max(maxLength, 12), 42);
  });
}

export async function buildExcelResponse(fileName: string, sheetName: string, title: string, subtitle: string, generatedAt: string, headers: string[], rows: Array<Array<string | number>>, totals: Array<string | number>) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = companyName;
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet(sheetName);
  worksheet.addRow([companyName]);
  worksheet.addRow([title]);
  worksheet.addRow([`${subtitle} · Generado: ${formatHnDateTime(generatedAt)}`]);
  worksheet.addRow(headers);
  rows.forEach((row) => worksheet.addRow(row));
  worksheet.addRow(totals);
  worksheet.lastRow!.font = { bold: true };
  worksheet.lastRow!.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF4F4F5" } };
  styleWorksheet(worksheet);
  const buffer = await workbook.xlsx.writeBuffer();

  return new Response(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${responseFileName(fileName)}"`,
    },
  });
}

export function ledgerPdfTable(data: GeneralLedgerReportData): PdfTable {
  const section = data.section;
  const accountLabel = section ? `${section.account.code} - ${section.account.name}` : "Sin cuenta";
  return {
    title: "Libro Mayor",
    subtitle: `Período: ${data.periodLabel} · Cuenta: ${accountLabel}`,
    generatedAt: data.generatedAt,
    fileName: "car-zone-libro-mayor.pdf",
    headers: ["Fecha", "Partida", "Referencia", "Descripción", "Débito", "Crédito", "Saldo"],
    rows: section?.movements.map((movement) => [
      formatHnDate(movement.date),
      movement.journalNumber,
      movement.reference,
      movement.description,
      formatCurrency(movement.debit),
      formatCurrency(movement.credit),
      formatCurrency(movement.runningBalance),
    ]) ?? [],
    totals: ["", "", "", "Totales", formatCurrency(section?.totalDebit ?? 0), formatCurrency(section?.totalCredit ?? 0), formatCurrency(section?.closingBalance ?? 0)],
  };
}

export function ledgerExcelRows(data: GeneralLedgerReportData) {
  const rows = data.section?.movements.map((movement) => [
    formatHnDate(movement.date),
    movement.journalNumber,
    movement.reference,
    movement.description,
    movement.debit,
    movement.credit,
    movement.runningBalance,
  ]) ?? [];
  return {
    headers: ["Fecha", "Partida", "Referencia", "Descripción", "Débito", "Crédito", "Saldo"],
    rows,
    totals: ["", "", "", "Totales", data.section?.totalDebit ?? 0, data.section?.totalCredit ?? 0, data.section?.closingBalance ?? 0],
  };
}

export function trialBalancePdfTable(data: TrialBalanceReportData): PdfTable {
  return {
    title: "Balance de Comprobación",
    subtitle: `Período: ${data.periodLabel} · Validación: ${data.balanced ? "Balance correcto" : "Descuadre contable"}`,
    generatedAt: data.generatedAt,
    fileName: "car-zone-balance-comprobacion.pdf",
    headers: ["Código", "Cuenta", "Tipo", "Débito", "Crédito", "Saldo final"],
    rows: data.rows.map((row) => [
      row.account.code,
      row.account.name,
      accountTypeLabels[row.account.type] ?? "Cuenta contable",
      formatCurrency(row.debit),
      formatCurrency(row.credit),
      formatCurrency(row.endingBalance),
    ]),
    totals: ["", "", "Totales", formatCurrency(data.totalDebit), formatCurrency(data.totalCredit), formatCurrency(data.totalEndingBalance)],
  };
}

export function trialBalanceExcelRows(data: TrialBalanceReportData) {
  return {
    headers: ["Código", "Cuenta", "Tipo", "Débito", "Crédito", "Saldo final"],
    rows: data.rows.map((row) => [row.account.code, row.account.name, accountTypeLabels[row.account.type] ?? "Cuenta contable", row.debit, row.credit, row.endingBalance]),
    totals: ["", "", "Totales", data.totalDebit, data.totalCredit, data.totalEndingBalance],
  };
}