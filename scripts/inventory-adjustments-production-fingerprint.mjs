import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey || /localhost|127\.0\.0\.1/.test(url)) {
  throw new Error("A non-local Supabase project is required for this read-only fingerprint.");
}
const db = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function count(table, apply = (query) => query) {
  const result = await apply(db.from(table).select("*", { count: "exact", head: true }));
  if (result.error) throw result.error;
  return result.count ?? 0;
}

async function optionalCount(table) {
  const probe = await db.from(table).select("id").limit(1);
  if (probe.error) {
    if (["42P01", "PGRST205"].includes(probe.error.code)) return { exists: false, count: 0 };
    throw probe.error;
  }
  return { exists: true, count: await count(table) };
}

const productsResult = await db.from("products")
  .select("id,stock,reserved_stock,available_stock,retail_price,wholesale_price,cost_price")
  .order("id", { ascending: true })
  .limit(10000);
if (productsResult.error) throw productsResult.error;
const products = productsResult.data;
const sum = (key) => products.reduce((total, row) => total + Number(row[key] ?? 0), 0);

const automationResult = await db.from("accounting_automation_settings")
  .select("key,value,updated_at")
  .eq("key", "automation_mode")
  .maybeSingle();
if (automationResult.error) throw automationResult.error;

const fingerprint = {
  capturedAt: new Date().toISOString(),
  projectHost: new URL(url).host,
  products: {
    count: products.length,
    stockSum: sum("stock"),
    reservedSum: sum("reserved_stock"),
    availableSum: sum("available_stock"),
    retailPriceSum: sum("retail_price"),
    wholesalePriceSum: sum("wholesale_price"),
    costPriceSum: sum("cost_price"),
    stockBelowReserved: products.filter((row) => Number(row.stock) < Number(row.reserved_stock ?? 0)).length,
  },
  counts: {
    inventoryMovements: await count("inventory_movements"),
    activeReservations: await count("inventory_reservations", (query) => query.eq("status", "reserved")),
    allReservations: await count("inventory_reservations"),
    orders: await count("orders"),
    purchases: await count("purchases"),
    financialEvents: await count("financial_events"),
    accountingOutboxV2: await count("accounting_outbox_v2"),
    journalEntries: await count("journal_entries"),
  },
  adjustmentTables: {
    headers: await optionalCount("inventory_adjustments"),
    lines: await optionalCount("inventory_adjustment_lines"),
  },
  accountingAutomation: automationResult.data,
};

const stableBusinessState = {
  products,
  counts: fingerprint.counts,
  accountingAutomation: fingerprint.accountingAutomation,
};
fingerprint.stableBusinessHash = createHash("sha256")
  .update(JSON.stringify(stableBusinessState))
  .digest("hex");

console.log(JSON.stringify(fingerprint, null, 2));
