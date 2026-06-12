import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const envFile = await readFile(new URL("../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(
  envFile
    .split(/\r?\n/)
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

assert.ok(env.NEXT_PUBLIC_SUPABASE_URL);
assert.ok(env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
assert.ok(env.SUPABASE_SERVICE_ROLE_KEY);

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const password = `Cz-${randomUUID()}-Aa1!`;
const authUserIds = [];
const customerIds = [];
const orderIds = [];
const fixtureEmails = [];
let productId = null;

async function createWholesaleClient(type) {
  const email = `codex-wholesale-checkout-${type}-${randomUUID().slice(0, 8)}@example.com`;
  fixtureEmails.push(email);
  const { data: authData, error: authError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(authError);
  authUserIds.push(authData.user.id);

  const { data: customer, error: customerError } = await admin
    .from("customers")
    .insert({
      user_id: authData.user.id,
      business_name: `Negocio ${type} ${suffix}`,
      company_name: `Negocio ${type} ${suffix}`,
      contact_name: `Cliente ${type}`,
      email,
      phone: `98${Math.floor(100000 + Math.random() * 899999)}`,
      is_wholesale: true,
      wholesale_status: "approved",
      wholesale_customer_type: type,
      status: "active",
      active: true,
    })
    .select("id")
    .single();
  assert.ifError(customerError);
  customerIds.push(customer.id);

  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);

  return { client, customerId: customer.id, email };
}

async function checkout(client, email, quantity) {
  const { data, error } = await client.rpc("create_checkout_order_v2", {
    customer_name: "Cliente mayorista Codex",
    customer_email: email,
    customer_phone: "98765432",
    customer_rtn: null,
    delivery_address: "San Pedro Sula, Honduras",
    delivery_country: "Honduras",
    country_code: "HN",
    delivery_department: "Cortés",
    delivery_city: "San Pedro Sula",
    requested_price_mode: "wholesale",
    requested_payment_method: "bank_transfer",
    requested_payment_timing: "before_delivery",
    bank_reference_number: `WH-${randomUUID().slice(0, 8)}`,
    order_items: [{ product_id: productId, quantity }],
    wholesale_code: null,
    wholesale_code_id: null,
    transfer_receipt_url: null,
  });

  if (error) {
    return { error, order: null };
  }

  const order = data[0];
  orderIds.push(order.order_id);
  return { error: null, order };
}

try {
  const { data: product, error: productError } = await admin
    .from("products")
    .insert({
      sku: `CZ-WH-${suffix}`,
      slug: `codex-wholesale-${suffix}`,
      name: `Producto mayorista Codex ${suffix}`,
      brand: "Codex",
      description: "Fixture temporal para validar reglas mayoristas.",
      stock: 100,
      retail_price: 6000,
      wholesale_price: 5000,
      wholesale_min_quantity: 1,
      cost_price: 2500,
      active: true,
      status: "active",
    })
    .select("id")
    .single();
  assert.ifError(productError);
  productId = product.id;

  const newWholesale = await createWholesaleClient("new");
  const blocked = await checkout(newWholesale.client, newWholesale.email, 1);
  assert.ok(blocked.error, "A new wholesale customer must be blocked below L 10,000");
  assert.match(blocked.error.message, /Para activar tu primera compra mayorista/);

  const firstValid = await checkout(newWholesale.client, newWholesale.email, 2);
  assert.ifError(firstValid.error);

  const { data: completedCustomer, error: completedError } = await admin
    .from("customers")
    .select("wholesale_first_purchase_completed, wholesale_first_purchase_completed_at")
    .eq("id", newWholesale.customerId)
    .single();
  assert.ifError(completedError);
  assert.equal(completedCustomer.wholesale_first_purchase_completed, true);
  assert.ok(completedCustomer.wholesale_first_purchase_completed_at);

  const secondSmaller = await checkout(newWholesale.client, newWholesale.email, 1);
  assert.ifError(secondSmaller.error);

  const { error: cancelError } = await admin
    .from("orders")
    .update({ status: "cancelado" })
    .in("id", [firstValid.order.order_id, secondSmaller.order.order_id]);
  assert.ifError(cancelError);
  const { data: reopenedCustomer, error: reopenedError } = await admin
    .from("customers")
    .select("wholesale_first_purchase_completed, wholesale_first_purchase_completed_at")
    .eq("id", newWholesale.customerId)
    .single();
  assert.ifError(reopenedError);
  assert.equal(reopenedCustomer.wholesale_first_purchase_completed, false);
  assert.equal(reopenedCustomer.wholesale_first_purchase_completed_at, null);
  const blockedAfterCancellation = await checkout(newWholesale.client, newWholesale.email, 1);
  assert.ok(blockedAfterCancellation.error, "Cancelling every valid wholesale order must restore the first-purchase minimum");

  const existingWholesale = await createWholesaleClient("existing");
  const existingSmaller = await checkout(existingWholesale.client, existingWholesale.email, 1);
  assert.ifError(existingSmaller.error);

  const { data: auditRows, error: auditError } = await admin
    .from("audit_logs")
    .select("id, action, record_id")
    .eq("record_id", newWholesale.customerId)
    .eq("action", "wholesale.first_purchase_completed");
  assert.ifError(auditError);
  assert.ok(auditRows.length > 0, "First wholesale purchase must create an audit log");

  const { error: typeChangeError } = await admin
    .from("customers")
    .update({ wholesale_customer_type: "new" })
    .eq("id", existingWholesale.customerId);
  assert.ifError(typeChangeError);
  const existingChangedToNew = await checkout(existingWholesale.client, existingWholesale.email, 1);
  assert.ok(
    existingChangedToNew.error,
    "Changing an existing wholesale customer to new must restore the minimum when no valid first purchase exists",
  );
  assert.match(existingChangedToNew.error.message, /Para activar tu primera compra mayorista/);

  const newChangedToExisting = await createWholesaleClient("new");
  const { error: newToExistingError } = await admin
    .from("customers")
    .update({ wholesale_customer_type: "existing" })
    .eq("id", newChangedToExisting.customerId);
  assert.ifError(newToExistingError);
  const newChangedToExistingCheckout = await checkout(newChangedToExisting.client, newChangedToExisting.email, 1);
  assert.ifError(newChangedToExistingCheckout.error);

  await newWholesale.client.auth.signOut();
  await existingWholesale.client.auth.signOut();
  await newChangedToExisting.client.auth.signOut();
  console.log("Remote wholesale checkout type checks passed.");
} finally {
  if (orderIds.length > 0) {
    await admin.from("notification_logs").delete().in("order_id", orderIds);
    await admin.from("invoices").delete().in("order_id", orderIds);
    await admin.from("inventory_movements").delete().in("reference_id", orderIds);
    await admin.from("orders").delete().in("id", orderIds);
  }
  if (customerIds.length > 0) {
    await admin.from("audit_logs").delete().in("record_id", customerIds);
    await admin.from("customers").delete().in("id", customerIds);
  }
  if (fixtureEmails.length > 0) {
    const { data: fixtureCustomers } = await admin.from("customers").select("id").in("email", fixtureEmails);
    const fixtureCustomerIds = fixtureCustomers?.map((customer) => customer.id) ?? [];
    if (fixtureCustomerIds.length > 0) {
      await admin.from("crm_notes").delete().in("customer_id", fixtureCustomerIds);
      await admin.from("crm_followups").delete().in("customer_id", fixtureCustomerIds);
      await admin.from("audit_logs").delete().in("record_id", fixtureCustomerIds);
      await admin.from("customers").delete().in("id", fixtureCustomerIds);
    }
  }
  if (productId) {
    await admin.from("inventory_movements").delete().eq("product_id", productId);
    await admin.from("products").delete().eq("id", productId);
  }
  for (const userId of authUserIds) {
    await admin.auth.admin.deleteUser(userId);
  }
}
