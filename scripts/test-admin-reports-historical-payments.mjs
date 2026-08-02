import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildReceivablePaymentReportRow,
  historicalReceivableOrderLabel,
  receivablePaymentOrderReference,
  reportRowMatchesSearch,
} from "../src/components/admin/report-receivable-payment.ts";

const formatters = {
  currency: (value) => `L ${value.toFixed(2)}`,
  date: (value) => value?.slice(0, 10) ?? "-",
  paymentMethod: (value) => value === "cash" ? "Efectivo" : "Transferencia",
  status: (value) => value === "partial" ? "Pago parcial" : "Abierto",
};

const modernPayment = {
  customer_name: "Cliente moderno",
  order_id: "12345678-1234-4234-8234-123456789abc",
  order_number: "CZ-260801-0001",
  original_amount: 1000,
  total_paid: 400,
  balance_due: 600,
  receivable_status: "partial",
  due_date: "2026-08-31T00:00:00Z",
  payment_method: "cash",
  reference: "REC-100",
  received_at: "2026-08-01T12:00:00Z",
  amount: 400,
};

const historicalPayment = {
  ...modernPayment,
  customer_name: "Cliente histórico",
  order_id: null,
  order_number: null,
  reference: "CXC-HIST-001",
};

assert.equal(receivablePaymentOrderReference(modernPayment), "CZ-260801-0001");
assert.equal(
  receivablePaymentOrderReference({ ...modernPayment, order_number: null }),
  "12345678",
  "a modern payment without order_number keeps its real UUID reference",
);
assert.equal(receivablePaymentOrderReference(historicalPayment), historicalReceivableOrderLabel);

const modernRow = buildReceivablePaymentReportRow(modernPayment, formatters);
const historicalRow = buildReceivablePaymentReportRow(historicalPayment, formatters);

assert.equal(modernRow.Pedido, "CZ-260801-0001");
assert.equal(historicalRow.Pedido, "Cuenta histórica");
assert.equal(historicalRow.Referencia, "CXC-HIST-001");
assert.equal(historicalRow["Total original"], "L 1000.00");
assert.equal(historicalRow["Total abonado"], "L 400.00");
assert.equal(historicalRow["Saldo pendiente"], "L 600.00");
assert.equal(historicalRow["Monto de abono"], "L 400.00");
assert.equal(reportRowMatchesSearch(historicalRow, "cliente histórico"), true);
assert.equal(reportRowMatchesSearch(historicalRow, "cuenta HISTÓRICA"), true);
assert.equal(reportRowMatchesSearch(historicalRow, "CXC-HIST-001"), true);
assert.equal(reportRowMatchesSearch(historicalRow, "2026-08-01"), true);
assert.equal(reportRowMatchesSearch(historicalRow, "L 400.00"), true);
assert.equal(reportRowMatchesSearch(historicalRow, "efectivo"), true);
assert.equal(reportRowMatchesSearch(historicalRow, "no existe"), false);
assert.equal(reportRowMatchesSearch(historicalRow, ""), true);

const [dashboard, service, reportTypes] = await Promise.all([
  readFile(new URL("../src/components/admin/reports-dashboard.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/services/supabase/admin-reports.service.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/types/reports.ts", import.meta.url), "utf8"),
]);

const reportsPdf = await readFile(new URL("../src/utils/admin-reports-pdf.ts", import.meta.url), "utf8");
assert.match(
  reportTypes,
  /export type ReportReceivablePayment = \{[\s\S]*?order_id:\s*string\s*\|\s*null;[\s\S]*?\n\};/,
);
assert.match(service, /order_id:\s*row\.order_id/);
assert.match(service, /reportQueries\.receivablePaymentsQuery[\s\S]*?\.order\("received_at", \{ ascending: false \}\)/);
assert.match(dashboard, /buildReceivablePaymentReportRow\(payment/);
assert.doesNotMatch(dashboard, /payment\.order_id\.slice/);
assert.match(dashboard, /buildAdminReportCsv\(currentReport\.columns, visibleReportRows\)/);
assert.match(dashboard, /buildAdminReportExcelTable\(currentReport\.label, currentReport\.columns, visibleReportRows\)/);
assert.match(dashboard, /rows:\s*visibleReportRows\.map/);
assert.match(dashboard, /generateAdminReportPdf\(\{/);
assert.match(reportsPdf, /body:\s*input\.rows/);
assert.match(dashboard, /<PaginationControls/);
assert.match(dashboard, /name="paymentMethod"/);
assert.match(dashboard, /name="startDate"/);
assert.match(dashboard, /name="endDate"/);
assert.doesNotMatch(dashboard, /href=[^\n]*order_id/);
assert.match(dashboard, /placeholder="Cliente, pedido, Cuenta histórica, referencia, fecha, monto o método"/);

console.log("Admin reports historical receivable payment contracts: OK");
