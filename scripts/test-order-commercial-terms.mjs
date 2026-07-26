import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { rolePermissions } from "../src/lib/auth/permissions.ts";
import {
  dateOnlyInHonduras,
  formatSqlDateHn,
  invoiceCommercialDate,
  isSqlDate,
  todayInHonduras,
} from "../src/utils/honduras-date.ts";

const permissions = ["sales:set_invoice_date", "sales:override_price", "sales:override_delivery"];
for (const role of ["technical_owner", "business_owner", "admin"]) {
  for (const permission of permissions) assert.equal(rolePermissions[role].includes(permission), true);
}
for (const role of ["vendedor", "bodega", "contadora", "soporte", "cliente"]) {
  for (const permission of permissions) assert.equal(rolePermissions[role].includes(permission), false);
}

assert.equal(isSqlDate("2026-07-25"), true);
assert.equal(isSqlDate("2026-02-29"), false);
assert.equal(isSqlDate("2024-02-29"), true);
assert.equal(isSqlDate("07/25/2026"), false);
assert.equal(formatSqlDateHn("2026-07-05"), "05/07/2026");
assert.equal(todayInHonduras(new Date("2026-07-26T05:59:59Z")), "2026-07-25");
assert.equal(todayInHonduras(new Date("2026-07-26T06:00:00Z")), "2026-07-26");
assert.equal(dateOnlyInHonduras("2026-07-26T05:59:59Z"), "2026-07-25");
assert.equal(invoiceCommercialDate("2026-07-18", "2026-07-25T20:00:00Z", null), "2026-07-18");
assert.equal(invoiceCommercialDate(null, "2026-07-26T05:59:59Z", null), "2026-07-25");

const migration = await readFile(new URL("../supabase/migrations/202607250001_order_commercial_terms.sql", import.meta.url), "utf8");
assert.match(migration, /create or replace function public\.adjust_sale_terms_v1/);
assert.match(migration, /public\.calculate_sale_financials_v1\(/);
assert.match(migration, /public\.is_date_in_closed_accounting_period\(p_requested_invoice_date\)/);
assert.match(migration, /unit_cost_snapshot is null or override_row\.unit_cost_snapshot <= 0/);
assert.match(migration, /revoke update on table public\.order_items from authenticated/);
assert.match(migration, /revoke insert, update on table public\.invoices from authenticated/);
assert.match(migration, /create policy "Invoice staff can read order items"/);
assert.match(migration, /new\.invoice_date is distinct from old\.invoice_date/);
assert.doesNotMatch(migration, /automation_mode\s*=/);
assert.doesNotMatch(migration, /receivable_payment_received|receivable_paid/);

const document = await readFile(new URL("../src/utils/official-invoice-document.ts", import.meta.url), "utf8");
assert.match(document, /invoice\.invoiceDate \?\? invoice\.issuedAt \?\? invoice\.createdAt/);
assert.doesNotMatch(document, /issuedDate: formatOfficialDate\(invoice\.caiAuthorizationDate/);
assert.match(document, /Fecha de autorización del CAI/);
assert.match(document, /Fecha límite de emisión/);

const reports = await readFile(new URL("../src/services/supabase/admin-reports.service.ts", import.meta.url), "utf8");
assert.match(reports, /invoice_date\.gte/);
assert.match(reports, /invoice_date\.lte/);
assert.match(reports, /invoice_date\.is\.null,issued_at\.is\.null,created_at/);

const receivableMigration = await readFile(new URL("../supabase/migrations/202607240001_receivable_payment_accounting_outbox.sql", import.meta.url), "utf8");
assert.match(receivableMigration, /receivable_payment/);
const historicalRepair = await readFile(new URL("./accounting/scoped-receivable-payment-repair.mjs", import.meta.url), "utf8");
assert.match(historicalRepair, /collectScopedReceivablePaymentPreview/);
const historicalRepairTest = await readFile(new URL("./test-scoped-receivable-payment-repair.mjs", import.meta.url), "utf8");
assert.match(historicalRepairTest, /11340\.00/);

console.log("Order commercial terms structure, roles and Honduras-date checks passed.");
