import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildAdminReportsUrl,
  calculateReportsTotalPages,
  clampReportsPage,
  hasCanonicalReportsPagination,
  normalizeReportsPageSize,
  parsePositivePage,
  planReportsPagination,
  planReportsSourceRange,
  readReportsSourcePage,
} from "../src/utils/admin-reports-pagination.ts";
import {
  buildAdminReportCsv,
  buildAdminReportExcelTable,
} from "../src/utils/admin-report-tabular-export.ts";
import {
  buildReceivablePaymentReportRow,
  historicalReceivableOrderLabel,
} from "../src/components/admin/report-receivable-payment.ts";

assert.equal(parsePositivePage(undefined), 1);
assert.equal(parsePositivePage(""), 1);
assert.equal(parsePositivePage("abc"), 1);
assert.equal(parsePositivePage("0"), 1);
assert.equal(parsePositivePage("-1"), 1);
assert.equal(parsePositivePage("3.5"), 1);
assert.equal(parsePositivePage("2"), 2);
assert.equal(parsePositivePage(["999", "1"]), 999);

assert.equal(normalizeReportsPageSize(undefined), 50);
assert.equal(normalizeReportsPageSize("0"), 50);
assert.equal(normalizeReportsPageSize("-10"), 50);
assert.equal(normalizeReportsPageSize("abc"), 50);
assert.equal(normalizeReportsPageSize("25"), 25);
assert.equal(normalizeReportsPageSize("1000"), 100);

assert.equal(calculateReportsTotalPages(0, 10), 1);
assert.equal(calculateReportsTotalPages(10, 10), 1);
assert.equal(calculateReportsTotalPages(20, 10), 2);
assert.equal(calculateReportsTotalPages(21, 10), 3);
assert.equal(clampReportsPage(999, 3), 3);
assert.equal(clampReportsPage(0, 0), 1);

assert.deepEqual(planReportsPagination(1, 10, 13), {
  page: 1,
  pageSize: 10,
  total: 13,
  totalPages: 2,
  from: 0,
  to: 9,
});
assert.deepEqual(planReportsPagination(2, 10, 13), {
  page: 2,
  pageSize: 10,
  total: 13,
  totalPages: 2,
  from: 10,
  to: 12,
});
assert.equal(planReportsPagination(2, 10, 3).page, 1);
assert.equal(planReportsPagination(999, 10, 13).page, 2);
assert.equal(planReportsPagination(4, 10, 0).page, 1);
assert.equal(planReportsPagination(4, 10, 0).to, -1);

const thirteenRows = Array.from({ length: 13 }, (_, index) => index + 1);
const pageOne = planReportsPagination(1, 10, 13);
const pageTwo = planReportsPagination(2, 10, 13);
const pageOneRead = await readReportsSourcePage(13, pageOne, async (from, to) => ({
  data: thirteenRows.slice(from, to + 1),
  error: null,
}));
const pageTwoRead = await readReportsSourcePage(13, pageTwo, async (from, to) => ({
  data: thirteenRows.slice(from, to + 1),
  error: null,
}));
assert.deepEqual(pageOneRead.rows, thirteenRows.slice(0, 10));
assert.deepEqual(pageTwoRead.rows, thirteenRows.slice(10, 13));

let smallSourceCalled = false;
const globalPageTwo = planReportsPagination(2, 50, 236);
const smallSourceRead = await readReportsSourcePage(5, globalPageTwo, async () => {
  smallSourceCalled = true;
  return { data: [], error: null };
});
assert.equal(smallSourceCalled, false, "the previous code sent range 50-99 to this five-row source");
assert.deepEqual(smallSourceRead.rows, []);
assert.equal(planReportsSourceRange(5, globalPageTwo), null);

const sixtyOneRows = Array.from({ length: 61 }, (_, index) => index + 1);
let queriedRange;
const partialSourceRead = await readReportsSourcePage(61, globalPageTwo, async (from, to) => {
  queriedRange = [from, to];
  return { data: sixtyOneRows.slice(from, to + 1), error: null };
});
assert.deepEqual(queriedRange, [0, 60]);
assert.deepEqual(partialSourceRead.rows, sixtyOneRows.slice(50));

const zeroRead = await readReportsSourcePage(0, planReportsPagination(999, 50, 0), async () => {
  assert.fail("zero results must not issue a range request");
});
assert.deepEqual(zeroRead.rows, []);

const invalidatedRead = await readReportsSourcePage(51, globalPageTwo, async () => ({
  data: null,
  error: { code: "PGRST103", message: "Requested range not satisfiable" },
}));
assert.equal(invalidatedRead.rangeInvalidated, true);
assert.equal(invalidatedRead.error, null);

const concurrentRows = Array.from({ length: 50 }, (_, index) => index + 1);
const concurrentRead = await readReportsSourcePage(51, globalPageTwo, async (from, to) => ({
  data: concurrentRows.slice(from, to + 1),
  error: null,
}));
assert.deepEqual(concurrentRead.rows, [], "deleting the former last row leaves a safe empty page for recounting");

const preservedUrl = buildAdminReportsUrl(
  {
    page: "999",
    startDate: "2026-07-01",
    endDate: "2026-07-31",
    customer: "Auto Centro",
    paymentMethod: "bank_transfer",
    invoiceStatus: "all",
  },
  2,
  50,
);
assert.equal(
  preservedUrl,
  "/admin/reportes?startDate=2026-07-01&endDate=2026-07-31&customer=Auto+Centro&paymentMethod=bank_transfer&page=2",
);
assert.equal(buildAdminReportsUrl({ page: "0" }, 1, 50), "/admin/reportes");
assert.equal(buildAdminReportsUrl({ page: "abc", product: "Filtro" }, 1, 100), "/admin/reportes?product=Filtro&pageSize=100");
assert.equal(hasCanonicalReportsPagination({}, 1, 50), true);
assert.equal(hasCanonicalReportsPagination({ page: "1" }, 1, 50), false);
assert.equal(hasCanonicalReportsPagination({ page: "2" }, 2, 50), true);
assert.equal(hasCanonicalReportsPagination({ page: "999" }, 2, 50), false);
assert.equal(hasCanonicalReportsPagination({ pageSize: "50" }, 1, 50), false);

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
  customer_name: "Cliente historico",
  order_id: null,
  order_number: null,
  reference: "CXC-HIST-001",
};
const modernRow = buildReceivablePaymentReportRow(modernPayment, formatters);
const historicalRow = buildReceivablePaymentReportRow(historicalPayment, formatters);
const columns = Object.keys(modernRow);
const rows = [modernRow, historicalRow];
const csv = buildAdminReportCsv(columns, rows);
const excel = buildAdminReportExcelTable("Abonos CxC", columns, rows);
assert.equal(modernRow.Pedido, "CZ-260801-0001");
assert.equal(historicalRow.Pedido, historicalReceivableOrderLabel);
assert.match(csv, /CZ-260801-0001/);
assert.match(csv, /Cuenta hist/);
assert.equal(csv.split("\n").length, 3);
assert.match(excel, /<h1>Abonos CxC<\/h1>/);
assert.match(excel, /CZ-260801-0001/);
assert.match(excel, /Cuenta hist/);
assert.equal((excel.match(/<tbody>[\s\S]*<tr>/g) ?? []).length, 1);
assert.equal((excel.match(/<tr>/g) ?? []).length, 3, "one header plus two data rows without duplicates");

const [service, pageComponent, dashboard, paginationControls] = await Promise.all([
  readFile(new URL("../src/services/supabase/admin-reports.service.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/app/admin/reportes/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/reports-dashboard.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pagination-controls.tsx", import.meta.url), "utf8"),
]);

assert.match(service, /const countQueries = buildQueries\(\);/);
assert.match(service, /countQueries\.ordersQuery\.limit\(0\)/);
assert.match(service, /readReportsSourcePage<OrderQueryRow>/);
assert.match(service, /rangeInvalidated \|\| pageBecameEmpty/);
assert.match(service, /attempt === 0/);
assert.match(service, /getAdminReportsAttempt\(\{ \.\.\.input, page: 1 \}, 2\)/);
assert.match(pageComponent, /hasCanonicalReportsPagination\(params, reports\.page, reports\.pageSize\)/);
assert.match(pageComponent, /redirect\(buildAdminReportsUrl\(params, reports\.page, reports\.pageSize\)\)/);
assert.doesNotMatch(dashboard, /name="page"/);
assert.match(dashboard, /name="startDate"/);
assert.match(dashboard, /name="endDate"/);
assert.match(dashboard, /name="paymentMethod"/);
assert.match(dashboard, /href="\/admin\/reportes"/);
assert.match(dashboard, /No hay datos para este reporte\./);
assert.match(paginationControls, /aria-disabled=\{page <= 1\}/);
assert.match(paginationControls, /aria-disabled=\{page >= totalPages\}/);
assert.match(paginationControls, /buildHref\(page - 1\)/);
assert.match(paginationControls, /buildHref\(page \+ 1\)/);

console.log("Admin reports safe pagination and export fixtures: OK");
