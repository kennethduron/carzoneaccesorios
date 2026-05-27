import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const envText = readFileSync(".env.local", "utf8");
for (const line of envText.split(/\r?\n/)) {
  const match = line.match(/^([^#=]+)=(.*)$/);
  if (match) {
    process.env[match[1].trim()] = match[2].trim();
  }
}

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(supabaseUrl, "Missing NEXT_PUBLIC_SUPABASE_URL");
assert.ok(serviceRoleKey, "Missing SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(supabaseUrl, serviceRoleKey);

const { data: orders, error: ordersError } = await supabase
  .from("orders")
  .select(
    `
    id,
    order_number,
    customer_name,
    payment_method,
    price_mode,
    status,
    order_items(product_name, sku, quantity, unit_price, line_total),
    invoices(invoice_number, status)
    `,
  )
  .order("created_at", { ascending: false })
  .limit(20);

assert.ifError(ordersError);

const { count: retailOrders, error: retailError } = await supabase
  .from("orders")
  .select("id", { count: "exact", head: true })
  .eq("price_mode", "retail");
assert.ifError(retailError);

const { count: wholesaleOrders, error: wholesaleError } = await supabase
  .from("orders")
  .select("id", { count: "exact", head: true })
  .eq("price_mode", "wholesale");
assert.ifError(wholesaleError);

const { count: issuedInvoices, error: issuedError } = await supabase
  .from("invoices")
  .select("id", { count: "exact", head: true })
  .in("status", ["emitida", "issued", "paid"]);
assert.ifError(issuedError);

const { count: cancelledInvoices, error: cancelledInvoiceError } = await supabase
  .from("invoices")
  .select("id", { count: "exact", head: true })
  .in("status", ["anulada", "cancelled"]);
assert.ifError(cancelledInvoiceError);

const { count: cancelledOrders, error: cancelledOrderError } = await supabase
  .from("orders")
  .select("id", { count: "exact", head: true })
  .in("status", ["cancelado", "cancelled"]);
assert.ifError(cancelledOrderError);

const soldItems = (orders ?? []).flatMap((order) =>
  (order.order_items ?? []).map((item) => ({
    order,
    item,
  })),
);

if (soldItems.length > 0) {
  const sample = soldItems[0];
  assert.ok(sample.order.order_number, "Sold item is missing order number.");
  assert.ok(sample.order.payment_method, "Sold item is missing payment method.");
  assert.ok(sample.item.product_name, "Sold item is missing product name.");
  assert.ok(sample.item.sku, "Sold item is missing SKU.");
  assert.notEqual(sample.item.product_name, sample.item.sku, "Product name must not be only SKU.");
}

const { data: invoices, error: invoicesError } = await supabase
  .from("invoices")
  .select(
    `
    invoice_number,
    order_id,
    status,
    orders(order_number, payment_method),
    invoice_items(product_name, sku, quantity, unit_price, line_total)
    `,
  )
  .order("created_at", { ascending: false })
  .limit(20);

assert.ifError(invoicesError);

const { data: detailedInvoices, error: detailedInvoicesError } = await supabase
  .from("invoices")
  .select(
    `
    id,
    invoice_number,
    order_id,
    customer_name,
    customer_email,
    customer_phone,
    customer_rtn,
    status,
    price_mode,
    subtotal,
    tax,
    total,
    issued_at,
    created_at,
    invoice_items(product_name, sku, quantity, unit_price, line_total, retail_price_snapshot, wholesale_price_snapshot),
    orders(order_number, payment_method, customers(business_name))
    `,
  )
  .order("created_at", { ascending: false })
  .limit(20);

assert.ifError(detailedInvoicesError);

const { data: products, error: productsError } = await supabase
  .from("products")
  .select("id, sku, internal_code, name, brand, stock, reserved_stock, available_stock, min_stock, retail_price, wholesale_price, cost_price, status")
  .order("name", { ascending: true })
  .limit(20);

assert.ifError(productsError);

const invoiceItems = (invoices ?? []).flatMap((invoice) =>
  (invoice.invoice_items ?? []).map((item) => ({
    invoice,
    item,
  })),
);

if (invoiceItems.length > 0) {
  const sample = invoiceItems[0];
  assert.ok(sample.invoice.invoice_number, "Invoice item is missing invoice number.");
  assert.ok(sample.invoice.orders?.order_number, "Invoice item is missing order number.");
  assert.ok(sample.item.product_name, "Invoice item is missing product name.");
  assert.ok(sample.item.sku, "Invoice item is missing SKU.");
  assert.notEqual(sample.item.product_name, sample.item.sku, "Invoice product name must not be only SKU.");
}

console.log(
  JSON.stringify(
    {
      orders: orders?.length ?? 0,
      invoices: invoices?.length ?? 0,
      detailedInvoices: detailedInvoices?.length ?? 0,
      products: products?.length ?? 0,
      soldItems: soldItems.length,
      invoiceItems: invoiceItems.length,
      productNameSkuVerified: true,
      coverage: {
        retailOrders,
        wholesaleOrders,
        issuedInvoices,
        cancelledInvoices,
        cancelledOrders,
      },
    },
    null,
    2,
  ),
);
