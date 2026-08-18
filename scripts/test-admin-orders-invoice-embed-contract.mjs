import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const affectedFiles = {
  "admin orders": ["src/services/supabase/admin-orders.service.ts", 1],
  "admin reports": ["src/services/supabase/admin-reports.service.ts", 1],
  "admin CRM": ["src/services/supabase/admin-crm.service.ts", 3],
  "admin order actions": ["src/app/admin/pedidos/actions.ts", 3],
  "accounting dispatcher": ["src/services/accounting/accounting-event-dispatcher.ts", 1],
  "customer account": ["src/services/supabase/customer-account.service.ts", 1],
};

const sources = new Map(
  await Promise.all(
    Object.entries(affectedFiles).map(async ([label, [path]]) => [label, await read(path)]),
  ),
);

const qualifiedEmbed = "invoices!invoices_order_id_fkey(";

for (const [label, [, expectedCount]] of Object.entries(affectedFiles)) {
  const source = sources.get(label);
  const actualCount = source.split(qualifiedEmbed).length - 1;
  assert.equal(actualCount, expectedCount, `${label}: expected ${expectedCount} explicit sale-invoice embeds`);

  const ordersQueries = [...source.matchAll(/\.from\("orders"\)([\s\S]*?);/g)].map((match) => match[1]);
  assert.ok(ordersQueries.length > 0, `${label}: expected at least one orders-root query`);
  for (const query of ordersQueries) {
    assert.equal(
      /\binvoices\s*\(/.test(query),
      false,
      `${label}: orders-root query still has an ambiguous invoices embed`,
    );
  }
}

const adminOrders = sources.get("admin orders");
assert.ok(adminOrders.includes("invoices!invoices_order_id_fkey(id, invoice_number, invoice_date, issued_at, status, cancelled_at, cancellation_reason, customer_name, customer_rtn, customer_phone, customer_email, customer_address)"));

const adminReports = sources.get("admin reports");
assert.ok(adminReports.includes("invoices!invoices_order_id_fkey(id, invoice_number, invoice_date, issued_at, status, cancelled_at)"));
assert.equal(adminReports.split("orders!invoices_order_id_fkey(").length - 1, 2);

const migration = await read("supabase/migrations/202608170001_full_invoice_commercial_reversal.sql");
assert.ok(migration.includes("commercial_reversal_invoice_id uuid"));
assert.ok(migration.includes("references public.invoices(id) on delete restrict"));
assert.ok(migration.includes("commercial_reversal_invoice_id = invoice_row.id"));

const invoiceRootFiles = [
  ...Object.values(affectedFiles).map(([path]) => path),
  "src/services/supabase/admin-invoices.service.ts",
  "src/services/accounting/adapters/invoice-financial-events.ts",
];
for (const path of new Set(invoiceRootFiles)) {
  const source = await read(path);
  const invoiceQueries = [...source.matchAll(/\.from\("invoices"\)([\s\S]*?);/g)].map((match) => match[1]);
  for (const query of invoiceQueries) {
    assert.equal(/\borders\s*\(/.test(query), false, `${path}: ambiguous invoice-root orders embed`);
    if (/\borders(?:!\w+)?\s*\(/.test(query)) {
      assert.ok(query.includes("orders!invoices_order_id_fkey("), `${path}: wrong invoice-root order relationship`);
    }
  }
}

console.log("Orders/invoices PostgREST relationship contracts: PASS", {
  affectedFiles: Object.keys(affectedFiles).length,
  qualifiedOrdersRootEmbeds: 10,
  saleInvoiceForeignKey: "invoices_order_id_fkey",
  commercialReversalRelationshipPreserved: true,
  invoiceRootContractsPreserved: true,
});
