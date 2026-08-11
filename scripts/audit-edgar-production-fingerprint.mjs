import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(url && serviceKey, "Production Supabase credentials are required.");
const parsedUrl = new URL(url);
assert.equal(parsedUrl.protocol, "https:", "Fingerprint refuses non-HTTPS Supabase endpoints.");
assert.equal(parsedUrl.hostname, "mbowrapstbufzzfefipn.supabase.co", "Fingerprint refuses an unexpected project.");

const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function allRows(table, columns, orderColumn = "id") {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(columns)
      .order(orderColumn, { ascending: true }).range(from, from + 999);
    assert.ifError(error, `read ${table}`);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) return rows;
  }
}

function sum(rows, field) {
  return Number(rows.reduce((total, row) => total + Number(row[field] ?? 0), 0).toFixed(2));
}

function digest(rows) {
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

const [
  customers, orders, invoices, receivables, payments, creditAccounts, posDrafts,
  inventoryMovements, products, financialEvents, accountingOutbox, journals,
  journalLines, customerFlags, posFlags, automation,
] = await Promise.all([
  allRows("customers", "id,status,active,commercial_version,updated_at"),
  allRows("orders", "id,status,tracking_status,total,payment_method,updated_at"),
  allRows("invoices", "id,status,total,invoice_date,updated_at"),
  allRows("accounts_receivable", "id,status,original_amount,balance_due,due_date,updated_at"),
  allRows("payments", "id,status,payment_status,amount,updated_at"),
  allRows("customer_credit_accounts", "customer_id,status,is_credit_enabled,credit_limit,terms_days,updated_at", "customer_id"),
  allRows("pos_sale_drafts", "id,status,version,grand_total,updated_at"),
  allRows("inventory_movements", "id,movement_type,quantity,stock_before,stock_after,created_at"),
  allRows("products", "id,status,active,stock,reserved_stock,updated_at"),
  allRows("financial_events", "id,source_type,source_id,event_purpose,posting_version,status,journal_entry_id,updated_at"),
  allRows("accounting_outbox_v2", "id,source_type,source_id,event_purpose,posting_version,status,journal_entry_id,updated_at"),
  allRows("journal_entries", "id,status,entry_date,source_type,source_id,updated_at"),
  allRows("journal_entry_lines", "id,journal_entry_id,debit,credit"),
  allRows("customer_feature_flags", "key,enabled,version,updated_at", "key"),
  allRows("pos_feature_flags", "key,enabled,version,updated_at", "key"),
  allRows("accounting_automation_settings", "key,value,updated_at", "key"),
]);

const economicRows = { orders, invoices, receivables, payments, inventoryMovements, products, financialEvents, accountingOutbox, journals, journalLines };
const syntheticChecks = await Promise.all([
  supabase.from("orders").select("id", { count: "exact", head: true }).ilike("order_number", "%POS-EDGAR-%-LOCAL-ONLY%"),
  supabase.from("invoices").select("id", { count: "exact", head: true }).ilike("invoice_number", "%POS-EDGAR-%-LOCAL-ONLY%"),
  supabase.from("customers").select("id", { count: "exact", head: true }).ilike("contact_name", "%EDGAR-%-LOCAL-ONLY%"),
]);
for (const result of syntheticChecks) assert.ifError(result.error);

const fingerprint = {
  capturedAt: new Date().toISOString(),
  projectRef: parsedUrl.hostname.split(".")[0],
  counts: {
    customers: customers.length,
    orders: orders.length,
    invoices: invoices.length,
    receivables: receivables.length,
    payments: payments.length,
    creditAccounts: creditAccounts.length,
    posDrafts: posDrafts.length,
    inventoryMovements: inventoryMovements.length,
    financialEvents: financialEvents.length,
    accountingOutbox: accountingOutbox.length,
    journals: journals.length,
    journalLines: journalLines.length,
    products: products.length,
  },
  aggregates: {
    orderTotal: sum(orders, "total"),
    invoiceTotal: sum(invoices, "total"),
    receivableOriginal: sum(receivables, "original_amount"),
    receivableBalance: sum(receivables, "balance_due"),
    paymentAmount: sum(payments, "amount"),
    creditLimit: sum(creditAccounts, "credit_limit"),
    productStock: sum(products, "stock"),
    productReservedStock: sum(products, "reserved_stock"),
    journalDebit: sum(journalLines, "debit"),
    journalCredit: sum(journalLines, "credit"),
  },
  logicalEconomicHash: digest(economicRows),
  schemaAdjacentHash: digest({ customers, creditAccounts, posDrafts }),
  flags: {
    customer: Object.fromEntries(customerFlags.map((row) => [row.key, row.enabled])),
    pos: Object.fromEntries(posFlags.map((row) => [row.key, row.enabled])),
    automationMode: automation.find((row) => row.key === "automation_mode")?.value?.mode ?? null,
  },
  syntheticMarkers: {
    orders: syntheticChecks[0].count ?? 0,
    invoices: syntheticChecks[1].count ?? 0,
    customers: syntheticChecks[2].count ?? 0,
  },
};

console.log(JSON.stringify(fingerprint, null, 2));
