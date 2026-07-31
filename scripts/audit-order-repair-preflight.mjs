import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const [orderNumber, trackingCode, envPath] = process.argv.slice(2);
assert.ok(orderNumber && trackingCode && envPath, "Expected order number, tracking code, and env file.");

const env = Object.fromEntries(
  (await readFile(envPath, "utf8"))
    .split(/\r?\n/)
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
    .map((line) => {
      const splitAt = line.indexOf("=");
      return [line.slice(0, splitAt), line.slice(splitAt + 1)];
    }),
);
assert.ok(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY, "Supabase credentials are missing.");

const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function get(query, label) {
  const { data, error } = await query;
  assert.ifError(error, label);
  return data ?? [];
}

const orders = await get(
  db.from("orders").select("*").eq("order_number", orderNumber).eq("tracking_code", trackingCode),
  "order",
);
assert.equal(orders.length, 1, `Expected one exact order; found ${orders.length}.`);
const order = orders[0];

const [items, payments, invoices, reservations, movements, outboxes, events, customers, users, cogs, fiscal] =
  await Promise.all([
    get(db.from("order_items").select("*").eq("order_id", order.id).order("sku"), "items"),
    get(db.from("payments").select("*").eq("order_id", order.id).order("created_at"), "payments"),
    get(db.from("invoices").select("*").eq("order_id", order.id), "invoices"),
    get(db.from("inventory_reservations").select("*").eq("order_id", order.id).order("product_id"), "reservations"),
    get(db.from("inventory_movements").select("*").eq("reference_id", order.id).order("created_at"), "movements"),
    get(
      db
        .from("accounting_outbox_v2")
        .select("*")
        .eq("source_type", "order")
        .eq("source_id", order.id)
        .order("created_at"),
      "outboxes",
    ),
    get(
      db
        .from("financial_events")
        .select("*")
        .eq("source_type", "order")
        .eq("source_id", order.id)
        .order("created_at"),
      "events",
    ),
    get(
      db
        .from("customers")
        .select("id,user_id,business_name,contact_name,email,phone,tax_id,address,city,active,status,is_wholesale,wholesale_status,wholesale_customer_type,commercial_version"),
      "customers",
    ),
    get(db.from("users").select("id,active,roles(name)"), "users"),
    get(
      db
        .from("journal_entries")
        .select("*,journal_entry_lines(*)")
        .in("entry_number", ["PC-20260730-CE7D37A7", "PC-20260730-FB0265D0"])
        .order("entry_number"),
      "COGS",
    ),
    get(db.from("fiscal_settings").select("*").eq("id", true), "fiscal settings"),
  ]);

const invoiceItems =
  invoices.length === 0
    ? []
    : await get(db.from("invoice_items").select("*").in("invoice_id", invoices.map(({ id }) => id)), "invoice items");
const saleEntries =
  events.every((event) => !event.journal_entry_id)
    ? []
    : await get(
        db
          .from("journal_entries")
          .select("*,journal_entry_lines(*)")
          .in("id", events.map((event) => event.journal_entry_id).filter(Boolean)),
        "sale entries",
      );

const snapshot = {
  order: {
    id: order.id,
    order_number: order.order_number,
    tracking_code: order.tracking_code,
    created_at: order.created_at,
    status: order.status,
    payment_method: order.payment_method,
    payment_timing: order.payment_timing,
    delivery_mode: order.delivery_mode,
    customer_id: order.customer_id,
    user_id: order.user_id,
    price_mode: order.price_mode,
    subtotal: order.subtotal,
    tax: order.tax,
    shipping_fee: order.shipping_fee,
    cash_on_delivery_fee: order.cash_on_delivery_fee,
    small_order_fee: order.small_order_fee,
    discount_total: order.discount_total,
    total: order.total,
    calculation_version: order.calculation_version,
    commercial_terms_version: order.commercial_terms_version,
    requested_invoice_date: order.requested_invoice_date,
    customer_name: order.customer_name,
    email: order.email,
    phone: order.phone,
    delivery_address: order.delivery_address,
    fiscal_customer_name: order.fiscal_customer_name,
    fiscal_customer_rtn: order.fiscal_customer_rtn,
    fiscal_customer_phone: order.fiscal_customer_phone,
    fiscal_customer_email: order.fiscal_customer_email,
    fiscal_customer_address: order.fiscal_customer_address,
  },
  items: items.map((item) => ({
    id: item.id,
    product_id: item.product_id,
    sku: item.sku,
    quantity: item.quantity,
    applied_price_mode: item.applied_price_mode,
    unit_price: item.unit_price,
    line_total: item.line_total,
    retail_price_snapshot: item.retail_price_snapshot,
    wholesale_price_snapshot: item.wholesale_price_snapshot,
    unit_cost_snapshot: item.unit_cost_snapshot,
    tax_rate_snapshot: item.tax_rate_snapshot,
  })),
  payments: payments.map((payment) => ({
    id: payment.id,
    customer_id: payment.customer_id,
    method: payment.method,
    payment_method: payment.payment_method,
    status: payment.status,
    payment_status: payment.payment_status,
    amount: payment.amount,
    paid_at: payment.paid_at,
  })),
  invoices,
  invoice_items: invoiceItems,
  reservations: reservations.map((row) => ({
    id: row.id,
    product_id: row.product_id,
    quantity: row.quantity,
    status: row.status,
  })),
  movements: movements.map((row) => ({
    id: row.id,
    product_id: row.product_id,
    movement_type: row.movement_type,
    quantity: row.quantity,
    stock_before: row.stock_before,
    stock_after: row.stock_after,
    reference_type: row.reference_type,
  })),
  outboxes: outboxes.map((row) => ({
    id: row.id,
    feature_key: row.feature_key,
    topic: row.topic,
    source_type: row.source_type,
    source_id: row.source_id,
    event_purpose: row.event_purpose,
    scenario: row.scenario,
    status: row.status,
    attempt_count: row.attempt_count,
    max_attempts: row.max_attempts,
    next_attempt_at: row.next_attempt_at,
    financial_event_id: row.financial_event_id,
    journal_entry_id: row.journal_entry_id,
    last_error_code: row.last_error_code,
    last_error_message: row.last_error_message,
  })),
  events: events.map((row) => ({
    id: row.id,
    event_purpose: row.event_purpose,
    status: row.status,
    journal_entry_id: row.journal_entry_id,
  })),
  sale_entries: saleEntries,
  cogs,
  current_customer: customers.find(({ id }) => id === order.customer_id) ?? null,
  canonical_customer_candidates: customers.filter(({ id }) => id.startsWith("3548cc3e")),
  duplicate_customer_candidates: customers.filter(({ id }) => id.startsWith("03d54a49")),
  portal_user_candidates: users.filter(({ id }) => id.startsWith("4997bb89")),
  fiscal: fiscal.map((row) => ({
    current_invoice_number: row.current_invoice_number,
    invoice_range_start: row.invoice_range_start,
    invoice_range_end: row.invoice_range_end,
    cai: row.cai,
    cai_authorization_date: row.cai_authorization_date,
    emission_deadline: row.emission_deadline,
  })),
};

console.log(
  JSON.stringify(
    {
      fingerprint: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
      snapshot,
    },
    null,
    2,
  ),
);
