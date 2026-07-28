import "server-only";

import ExcelJS from "exceljs";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import type { BalanceSheetReportData, FinancialStatementSection, GeneralLedgerReportData, IncomeStatementReportData, TrialBalanceReportData } from "@/types/accounting-reports";
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
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber < 5) return;
    row.eachCell((cell) => {
      if (typeof cell.value === "number") {
        cell.numFmt = '"L" #,##0.00;[Red]-"L" #,##0.00';
      }
    });
  });
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

function sectionPdfRows(section: FinancialStatementSection, extraRows: Array<{ label: string; amount: number }> = []) {
  const rows = section.rows.map((row) => [section.title, row.account.code, row.account.name, formatCurrency(row.amount)]);
  if (section.rows.length === 0 && extraRows.length === 0) {
    rows.push([section.title, "", "Sin movimientos contabilizados", formatCurrency(0)]);
  }
  for (const row of extraRows) {
    rows.push([section.title, "", row.label, formatCurrency(row.amount)]);
  }
  rows.push([section.title, "", `Subtotal ${section.title}`, formatCurrency(section.total)]);
  return rows;
}

function sectionExcelRows(section: FinancialStatementSection, extraRows: Array<{ label: string; amount: number }> = []) {
  const rows: Array<Array<string | number>> = section.rows.map((row) => [section.title, row.account.code, row.account.name, row.amount]);
  if (section.rows.length === 0 && extraRows.length === 0) {
    rows.push([section.title, "", "Sin movimientos contabilizados", 0]);
  }
  for (const row of extraRows) {
    rows.push([section.title, "", row.label, row.amount]);
  }
  rows.push([section.title, "", `Subtotal ${section.title}`, section.total]);
  return rows;
}

export function balanceSheetPdfTable(data: BalanceSheetReportData): PdfTable {
  const validation = data.balanced ? "Balance correcto" : "Descuadre contable";
  return {
    title: "Balance General",
    subtitle: `Período: ${data.periodLabel} · Validación: ${validation}`,
    generatedAt: data.generatedAt,
    fileName: "car-zone-balance-general.pdf",
    headers: ["Sección", "Código", "Cuenta", "Saldo"],
    rows: [
      ...sectionPdfRows(data.assets),
      ...sectionPdfRows(data.liabilities),
      ...sectionPdfRows(data.equity, [{ label: "Resultado del período", amount: data.periodResult }]),
      ["Validación", "", validation, formatCurrency(data.difference)],
    ],
    totals: ["", "", "Pasivos + patrimonio", formatCurrency(data.totalLiabilitiesAndEquity)],
  };
}

export function balanceSheetExcelRows(data: BalanceSheetReportData) {
  const validation = data.balanced ? "Balance correcto" : "Descuadre contable";
  return {
    headers: ["Sección", "Código", "Cuenta", "Saldo"],
    rows: [
      ...sectionExcelRows(data.assets),
      ...sectionExcelRows(data.liabilities),
      ...sectionExcelRows(data.equity, [{ label: "Resultado del período", amount: data.periodResult }]),
      ["Validación", "", validation, data.difference],
    ],
    totals: ["", "", "Pasivos + patrimonio", data.totalLiabilitiesAndEquity],
  };
}

export function incomeStatementPdfTable(data: IncomeStatementReportData): PdfTable {
  return {
    title: "Estado de Resultados",
    subtitle: `Período: ${data.periodLabel} · ${data.resultLabel}: ${formatCurrency(data.netIncome)}`,
    generatedAt: data.generatedAt,
    fileName: "car-zone-estado-resultados.pdf",
    headers: ["Sección", "Código", "Cuenta", "Importe"],
    rows: [
      ...sectionPdfRows(data.revenues),
      ...sectionPdfRows(data.costs),
      ["Resultado", "", "Utilidad bruta", formatCurrency(data.grossProfit)],
      ...sectionPdfRows(data.expenses),
      ["Resultado", "", data.resultLabel, formatCurrency(data.netIncome)],
    ],
    totals: ["", "", data.resultLabel, formatCurrency(data.netIncome)],
  };
}

export function incomeStatementExcelRows(data: IncomeStatementReportData) {
  return {
    headers: ["Sección", "Código", "Cuenta", "Importe"],
    rows: [
      ...sectionExcelRows(data.revenues),
      ...sectionExcelRows(data.costs),
      ["Resultado", "", "Utilidad bruta", data.grossProfit],
      ...sectionExcelRows(data.expenses),
      ["Resultado", "", data.resultLabel, data.netIncome],
    ],
    totals: ["", "", data.resultLabel, data.netIncome],
  };
}
