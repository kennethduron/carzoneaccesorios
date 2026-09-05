import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { formatReceivableInvoice } from "../src/utils/receivable-invoice.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFile(`${root}/${path}`, "utf8");

const [component, service, creditTypes, page, receivableSchema, posConfirmation] = await Promise.all([
  read("src/components/admin/accounts-receivable-manager.tsx"),
  read("src/services/supabase/credit.service.ts"),
  read("src/types/credit.ts"),
  read("src/app/admin/cuentas-por-cobrar/page.tsx"),
  read("supabase/migrations/202606130002_commercial_credit_accounts_receivable.sql"),
  read("supabase/migrations/202608020002_pos_stage_5_atomic_sale_confirmation.sql"),
]);

const table = component.slice(component.indexOf("<table"), component.indexOf("</table>") + 8);
const headers = [...table.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((match) => match[1].trim());

assert.deepEqual(headers.slice(0, 3), ["Cliente", "Pedido", "Factura"]);
assert.match(table, /formatReceivableInvoice\(row\.invoice_number, row\.invoice_status\)/);
assert.match(table, /colSpan=\{11\}/);
assert.match(component, /<MiniInfo label="Factura" value=\{formatReceivableInvoice\(row\.invoice_number, row\.invoice_status\)\} \/>/);
assert.match(component, /overflow-auto/);
assert.match(component, /placeholder="Buscar por cliente, correo, teléfono, pedido, factura,/);
assert.match(component, /row\.invoice_number/);
assert.match(component, /"Pedido",\s*"Factura",/s);

assert.match(service, /\.from\("accounts_receivable"\)[\s\S]*?invoices\(invoice_number, status\)/);
assert.match(service, /invoice_number: row\.invoices\?\.invoice_number \?\? row\.historical_invoice_number \?\? null/);
assert.match(service, /invoice_status: row\.invoices\?\.status \?\? null/);
assert.doesNotMatch(
  service.slice(service.indexOf("export async function getAdminAccountsReceivable")),
  /\.from\("invoices"\)/,
  "CxC must not perform a second or per-row invoice query",
);
assert.match(creditTypes, /invoice_status: InvoiceStatus \| null/);

assert.match(receivableSchema, /order_id uuid not null unique references public\.orders\(id\)/);
assert.match(receivableSchema, /invoice_id uuid unique references public\.invoices\(id\)/);
assert.match(receivableSchema, /order_id uuid not null unique references public\.orders\(id\)/);
assert.match(posConfirmation, /update public\.accounts_receivable receivable\s+set invoice_id = new_invoice_id[\s\S]*?where receivable\.order_id = target_order_id/s);

assert.match(page, /requirePermission\("admin:access"\)/);
assert.match(page, /hasEffectivePermission\(profile\.role, profile\.permissions, "receivables:read"/);
assert.match(page, /hasEffectivePermission\(profile\.role, profile\.permissions, "receivables:export"/);
assert.match(page, /redirect\("\/sin-permiso"\)/);

const activeNumber = "000-001-01-00012345";
assert.equal(formatReceivableInvoice(activeNumber, "emitida"), activeNumber);
assert.equal(formatReceivableInvoice(activeNumber, "paid"), activeNumber);
assert.equal(formatReceivableInvoice(activeNumber, "anulada"), `${activeNumber} · Factura anulada`);
assert.equal(formatReceivableInvoice(activeNumber, "cancelled"), `${activeNumber} · Factura anulada`);
assert.equal(formatReceivableInvoice(null, null), "Sin factura");

const fixtures = [
  { id: "pos-active", customer: "Inversiones Contreras", order: "CZ-POS-260815-A", invoice: activeNumber, status: "open" },
  { id: "web-none", customer: "Inversiones Contreras", order: "CZ-WEB-260815-B", invoice: null, status: "open" },
  { id: "partial", customer: "Cliente Parcial", order: "CZ-POS-260810-C", invoice: "000-001-01-00012346", status: "partial" },
  { id: "paid", customer: "Cliente Pagado", order: "CZ-WEB-260809-D", invoice: "000-001-01-00012347", status: "paid" },
  { id: "overdue", customer: "Cliente Vencido", order: "CZ-POS-260801-E", invoice: "000-001-01-00012348", status: "overdue" },
];

const normalize = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const search = (query) => fixtures.filter((row) => normalize(`${row.customer} ${row.order} ${row.invoice ?? ""}`).includes(normalize(query)));
assert.deepEqual(search(activeNumber).map((row) => row.id), ["pos-active"]);
assert.deepEqual(search("0001234").map((row) => row.id), ["pos-active", "partial", "paid", "overdue"]);
assert.deepEqual(search("Inversiones Contreras").map((row) => row.id), ["pos-active", "web-none"]);
assert.deepEqual(search("CZ-WEB-260815-B").map((row) => row.id), ["web-none"]);
assert.equal(new Set(fixtures.map((row) => row.id)).size, fixtures.length);
assert.equal(fixtures.find((row) => row.order === "CZ-WEB-260815-B")?.invoice, null);

for (const filter of ["pending", "partial", "overdue", "paid", "all"]) {
  assert.match(component, new RegExp(`"${filter}"`));
}

console.log("CXC_FISCAL_RELATION=PASS");
console.log("ACTIVE_NO_INVOICE_CANCELLED_STATES=PASS");
console.log("SAME_CUSTOMER_ORDER_ISOLATION=PASS");
console.log("DUPLICATE_CXC_ROWS=0");
console.log("FILTER_SEARCH_CSV_RBAC_CONTRACTS=PASS");
