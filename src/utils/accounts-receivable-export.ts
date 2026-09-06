import "server-only";

import ExcelJS from "exceljs";
import type { AdminAccountsReceivableRow, ReceivablesSummary } from "@/types/credit";
import { buildUtf8BomCsv, spreadsheetSafeText } from "@/utils/spreadsheet-safety";

const statusLabel: Record<string, string> = { open: "Pendiente", partial: "Pago parcial", paid: "Pagado", overdue: "Vencido", cancelled: "Cancelado" };
const methodLabel: Record<string, string> = { bank_transfer: "Transferencia bancaria", card: "Tarjeta", cash: "Efectivo" };
const moneyFormat = '"L" #,##0.00;[Red]-"L" #,##0.00';

function tegucigalpaDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

function daysUntil(date: string, today: string) {
  return Math.round((new Date(`${date}T12:00:00-06:00`).getTime() - new Date(`${today}T12:00:00-06:00`).getTime()) / 86_400_000);
}

function activePayments(row: AdminAccountsReceivableRow) { return row.payments.filter((payment) => !payment.voided_at); }
function latestPayment(row: AdminAccountsReceivableRow) { return [...activePayments(row)].sort((left, right) => right.received_at.localeCompare(left.received_at))[0] ?? null; }

export function buildReceivablesCsv(rows: AdminAccountsReceivableRow[]) {
  const data: Array<Array<string | number | null>> = [[
    "Cliente", "Correo", "Teléfono", "Pedido", "Factura", "Estado factura", "Monto original",
    "Total abonado", "Saldo pendiente", "Creación", "Vencimiento", "Estado CxC", "Fecha de abono",
    "Monto de abono", "Método", "Referencia",
  ]];
  for (const row of rows) {
    const payments = activePayments(row);
    for (const payment of payments.length > 0 ? payments : [null]) {
      data.push([
        row.customer_name, row.customer_email, row.customer_phone, row.order_number, row.invoice_number,
        row.invoice_status, row.original_amount, row.total_paid, row.balance_due, row.created_at, row.due_date,
        statusLabel[row.status] ?? row.status, payment?.received_at ?? null, payment?.amount ?? null,
        payment ? methodLabel[payment.payment_method] ?? payment.payment_method : null, payment?.reference ?? null,
      ]);
    }
  }
  return buildUtf8BomCsv(data);
}

function styleWorksheet(sheet: ExcelJS.Worksheet, headerRow: number) {
  const header = sheet.getRow(headerRow);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE30613" } };
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 28;
  sheet.views = [{ state: "frozen", ySplit: headerRow }];
  sheet.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: sheet.columnCount } };
  sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9,
    printTitlesRow: `${headerRow}:${headerRow}`, margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } };
  sheet.headerFooter.oddFooter = "&LCar Zone Accesorios&C&P de &N";
  sheet.eachRow((row, index) => { if (index > headerRow) row.alignment = { vertical: "top", wrapText: true }; });
}

function text(value: unknown) { return spreadsheetSafeText(value); }

function exportedScopeSummary(rows: AdminAccountsReceivableRow[]) {
  const today = tegucigalpaDate();
  const month = today.slice(0, 7);
  const sevenDays = tegucigalpaDate(new Date(Date.now() + 7 * 86_400_000));
  const pending = rows.filter((row) => row.status !== "paid" && row.status !== "cancelled" && row.balance_due > 0);
  const overdue = pending.filter((row) => row.status === "overdue" || row.due_date < today);
  const payments = rows.flatMap(activePayments);
  return {
    accounts: rows.length,
    totalPending: pending.reduce((sum, row) => sum + row.balance_due, 0),
    overdueBalance: overdue.reduce((sum, row) => sum + row.balance_due, 0),
    customersWithDebt: new Set(pending.map((row) => row.customer_id)).size,
    overdue: overdue.length,
    dueInSevenDays: pending.filter((row) => row.due_date >= today && row.due_date <= sevenDays).length,
    collectedToday: payments.filter((payment) => tegucigalpaDate(new Date(payment.received_at)) === today).reduce((sum, payment) => sum + payment.amount, 0),
    collectedThisMonth: payments.filter((payment) => tegucigalpaDate(new Date(payment.received_at)).startsWith(month)).reduce((sum, payment) => sum + payment.amount, 0),
  };
}

export async function buildReceivablesWorkbook(rows: AdminAccountsReceivableRow[], globalSummary: ReceivablesSummary,
  filters: { status: string; query: string; sort: string; direction: string }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Car Zone Accesorios";
  workbook.created = new Date();
  const scope = exportedScopeSummary(rows);
  const generatedAt = new Date();

  const summary = workbook.addWorksheet("Resumen");
  summary.columns = [{ width: 36 }, { width: 68 }];
  summary.addRow(["Car Zone Accesorios"]);
  summary.addRow(["Reporte de cuentas por cobrar"]);
  summary.addRow(["Generado", generatedAt]);
  summary.addRow(["Alcance", "Todas las cuentas que coinciden con los filtros y la búsqueda"]);
  summary.addRow(["Indicador", "Valor"]);
  [
    ["Cuentas exportadas", scope.accounts], ["Cartera pendiente del alcance", scope.totalPending],
    ["Cartera vencida del alcance", scope.overdueBalance], ["Cobrado hoy en el alcance", scope.collectedToday],
    ["Cobrado este mes en el alcance", scope.collectedThisMonth], ["Clientes con deuda en el alcance", scope.customersWithDebt],
    ["Cuentas vencidas en el alcance", scope.overdue], ["Vencen en 7 días en el alcance", scope.dueInSevenDays],
    ["Cartera total global", globalSummary.totalPending], ["Cartera vencida global", globalSummary.overdueBalance],
  ].forEach((record) => summary.addRow(record));
  summary.mergeCells("A1:B1"); summary.mergeCells("A2:B2");
  summary.getCell("A1").font = { bold: true, size: 18, color: { argb: "FFE30613" } };
  summary.getCell("A2").font = { bold: true, size: 13 };
  summary.getCell("B3").numFmt = "dd mmm yyyy hh:mm";
  [7, 8, 9, 10, 14, 15].forEach((index) => { summary.getCell(index, 2).numFmt = moneyFormat; });
  styleWorksheet(summary, 5);

  const accounts = workbook.addWorksheet("Cuentas");
  accounts.columns = [
    { header: "Cliente", key: "customer", width: 32 }, { header: "Correo", key: "email", width: 30 },
    { header: "Teléfono", key: "phone", width: 18 }, { header: "Pedido", key: "order", width: 28 },
    { header: "Factura", key: "invoice", width: 26 }, { header: "Estado factura", key: "invoiceStatus", width: 18 },
    { header: "Total original", key: "original", width: 18 }, { header: "Total abonado", key: "paid", width: 18 },
    { header: "Saldo pendiente", key: "balance", width: 18 }, { header: "Creación", key: "created", width: 20 },
    { header: "Vencimiento", key: "due", width: 16 }, { header: "Días", key: "days", width: 10 },
    { header: "Estado CxC", key: "status", width: 18 }, { header: "Último abono", key: "lastPayment", width: 20 },
    { header: "Método último abono", key: "lastMethod", width: 24 }, { header: "Referencia último abono", key: "lastReference", width: 28 },
  ];
  const today = tegucigalpaDate();
  rows.forEach((row) => {
    const last = latestPayment(row);
    accounts.addRow({ customer: text(row.customer_name), email: text(row.customer_email), phone: text(row.customer_phone),
      order: text(row.order_number), invoice: text(row.invoice_number), invoiceStatus: text(row.invoice_status),
      original: row.original_amount, paid: row.total_paid, balance: row.balance_due, created: new Date(row.created_at),
      due: row.due_date ? new Date(`${row.due_date}T12:00:00-06:00`) : null, days: daysUntil(row.due_date, today),
      status: statusLabel[row.status] ?? row.status, lastPayment: last ? new Date(last.received_at) : null,
      lastMethod: last ? methodLabel[last.payment_method] ?? last.payment_method : "", lastReference: text(last?.reference) });
  });
  [7, 8, 9].forEach((column) => { accounts.getColumn(column).numFmt = moneyFormat; });
  [10, 14].forEach((column) => { accounts.getColumn(column).numFmt = "dd mmm yyyy hh:mm"; });
  accounts.getColumn(11).numFmt = "dd mmm yyyy";
  [3, 4, 5, 16].forEach((column) => { accounts.getColumn(column).numFmt = "@"; });
  styleWorksheet(accounts, 1);

  const payments = workbook.addWorksheet("Abonos");
  payments.columns = [
    { header: "Cliente", key: "customer", width: 32 }, { header: "Pedido", key: "order", width: 28 },
    { header: "Factura", key: "invoice", width: 26 }, { header: "Fecha de abono", key: "date", width: 22 },
    { header: "Monto", key: "amount", width: 18 }, { header: "Método", key: "method", width: 24 },
    { header: "Referencia", key: "reference", width: 28 }, { header: "Estado", key: "status", width: 15 },
    { header: "Autor", key: "author", width: 30 }, { header: "Saldo anterior", key: "before", width: 18 },
    { header: "Saldo posterior", key: "after", width: 18 },
  ];
  rows.forEach((row) => row.payments.forEach((payment) => payments.addRow({ customer: text(row.customer_name),
    order: text(row.order_number), invoice: text(row.invoice_number), date: new Date(payment.received_at), amount: payment.amount,
    method: methodLabel[payment.payment_method] ?? payment.payment_method, reference: text(payment.reference),
    status: payment.voided_at ? "Anulado" : "Activo", author: text(payment.recorded_by_name ?? payment.recorded_by_email ?? "No registrado"),
    before: payment.balance_before, after: payment.balance_after })));
  payments.getColumn(4).numFmt = "dd mmm yyyy hh:mm";
  [5, 10, 11].forEach((column) => { payments.getColumn(column).numFmt = moneyFormat; });
  [2, 3, 7].forEach((column) => { payments.getColumn(column).numFmt = "@"; });
  styleWorksheet(payments, 1);

  const context = workbook.addWorksheet("Filtros");
  context.columns = [{ width: 28 }, { width: 70 }];
  context.addRow(["Filtro", "Valor"]); context.addRow(["Estado", text(filters.status)]);
  context.addRow(["Búsqueda", text(filters.query || "Sin búsqueda")]); context.addRow(["Orden", text(`${filters.sort} ${filters.direction}`)]);
  context.addRow(["Registros CxC", rows.length]); context.addRow(["Generado", generatedAt]);
  context.getCell(6, 2).numFmt = "dd mmm yyyy hh:mm";
  styleWorksheet(context, 1);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
