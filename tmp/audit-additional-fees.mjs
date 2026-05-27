import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

function loadEnv() {
  const raw = readFileSync(".env.local", "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    process.env[match[1]] ??= match[2].replace(/^"|"$/g, "");
  }
}

function money(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function feesTotal(value) {
  if (!Array.isArray(value)) return 0;
  return money(value.reduce((sum, fee) => sum + money(fee?.amount ?? fee?.total), 0));
}

function expected(row) {
  return money(
    money(row.subtotal) +
      money(row.tax) +
      money(row.shipping_fee ?? row.shipping_total) +
      money(row.cash_on_delivery_fee) +
      money(row.small_order_fee) +
      feesTotal(row.additional_fees) -
      money(row.discount_total),
  );
}

loadEnv();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

const orderFields =
  "id, order_number, payment_method, subtotal, tax, shipping_fee, shipping_total, cash_on_delivery_fee, small_order_fee, discount_total, additional_fees, total, status, created_at";
const invoiceFields =
  "id, invoice_number, order_id, subtotal, tax, shipping_fee, cash_on_delivery_fee, small_order_fee, discount_total, additional_fees, total, status, created_at";

const [{ data: orders, error: ordersError }, { data: invoices, error: invoicesError }] = await Promise.all([
  supabase.from("orders").select(orderFields).order("created_at", { ascending: false }).limit(500),
  supabase.from("invoices").select(invoiceFields).order("created_at", { ascending: false }).limit(500),
]);

if (ordersError) throw new Error(`orders: ${ordersError.message}`);
if (invoicesError) throw new Error(`invoices: ${invoicesError.message}`);

const orderMismatches = (orders ?? [])
  .map((order) => ({ ...order, expected_total: expected(order), difference: money(money(order.total) - expected(order)) }))
  .filter((order) => Math.abs(order.difference) >= 0.01);

const invoiceMismatches = (invoices ?? [])
  .map((invoice) => ({ ...invoice, expected_total: expected(invoice), difference: money(money(invoice.total) - expected(invoice)) }))
  .filter((invoice) => Math.abs(invoice.difference) >= 0.01);

const ordersById = new Map((orders ?? []).map((order) => [order.id, order]));
const invoiceFeeMismatches = (invoices ?? [])
  .map((invoice) => {
    const order = ordersById.get(invoice.order_id);
    if (!order) return null;
    const difference =
      money(invoice.shipping_fee) !== money(order.shipping_fee ?? order.shipping_total) ||
      money(invoice.cash_on_delivery_fee) !== money(order.cash_on_delivery_fee) ||
      money(invoice.small_order_fee) !== money(order.small_order_fee) ||
      money(invoice.discount_total) !== money(order.discount_total) ||
      feesTotal(invoice.additional_fees) !== feesTotal(order.additional_fees);
    return difference ? { invoice_number: invoice.invoice_number, order_number: order.order_number } : null;
  })
  .filter(Boolean);

const summary = {
  checked_orders: orders?.length ?? 0,
  checked_invoices: invoices?.length ?? 0,
  orders_with_shipping: (orders ?? []).filter((order) => money(order.shipping_fee ?? order.shipping_total) > 0).length,
  orders_without_shipping: (orders ?? []).filter((order) => money(order.shipping_fee ?? order.shipping_total) === 0).length,
  cash_on_delivery_orders: (orders ?? []).filter((order) => order.payment_method === "cash").length,
  bank_transfer_orders: (orders ?? []).filter((order) => order.payment_method === "bank_transfer").length,
  order_total_mismatches: orderMismatches.length,
  invoice_total_mismatches: invoiceMismatches.length,
  invoice_fee_snapshot_mismatches: invoiceFeeMismatches.length,
  sample_order_mismatches: orderMismatches.slice(0, 5).map((order) => ({
    order_number: order.order_number,
    total: order.total,
    expected_total: order.expected_total,
    difference: order.difference,
  })),
  sample_invoice_fee_mismatches: invoiceFeeMismatches.slice(0, 5),
};

console.log(JSON.stringify(summary, null, 2));
