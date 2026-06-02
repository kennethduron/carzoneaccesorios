import assert from "node:assert/strict";
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

assert.ok(env.NEXT_PUBLIC_SUPABASE_URL, "Missing NEXT_PUBLIC_SUPABASE_URL");
assert.ok(env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");
assert.ok(env.SUPABASE_SERVICE_ROLE_KEY, "Missing SUPABASE_SERVICE_ROLE_KEY");

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const productIds = [];
const orderIds = [];
const customerIds = new Set();
const authUserIds = [];

function client() {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createRoleClient(label, roleName) {
  const email = `codex-payment-${label}-${suffix}@example.com`;
  const password = `Test-${suffix}-Aa1!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(error);
  authUserIds.push(data.user.id);
  const { data: role, error: roleError } = await admin.from("roles").select("id").eq("name", roleName).single();
  assert.ifError(roleError);
  const { error: updateError } = await admin.from("users").update({ role_id: role.id, active: true }).eq("id", data.user.id);
  assert.ifError(updateError);
  const roleClient = client();
  const { error: signInError } = await roleClient.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);
  return roleClient;
}

async function createProduct(label, stock = 1) {
  const { data, error } = await admin
    .from("products")
    .insert({
      sku: `CODEX-PAY-${label}-${suffix}`,
      slug: `codex-pay-${label}-${suffix}`,
      name: `Codex pago ${label} ${suffix}`,
      brand: "Codex",
      description: "Fixture temporal de pruebas de pagos y reservas.",
      stock,
      retail_price: 1000,
      wholesale_price: 900,
      cost_price: 500,
      active: true,
      status: "active",
    })
    .select("id")
    .single();
  assert.ifError(error);
  productIds.push(data.id);
  return data.id;
}

async function createOrder(productId, { method = "bank_transfer", timing = "before_delivery", reference = "REF-1234", phone = "99990001" } = {}) {
  const { data, error } = await admin
    .rpc("create_checkout_order_v2", {
      customer_name: `Cliente prueba ${suffix}`,
      customer_email: `cliente-${phone}-${suffix}@example.com`,
      customer_phone: phone,
      customer_rtn: null,
      delivery_address: "San Pedro Sula, Honduras",
      delivery_country: "Honduras",
      country_code: "HN",
      delivery_department: "Cortés",
      delivery_city: "San Pedro Sula",
      requested_price_mode: "retail",
      requested_payment_method: method,
      requested_payment_timing: timing,
      bank_reference_number: reference,
      order_items: [{ product_id: productId, quantity: 1 }],
      wholesale_code: null,
      wholesale_code_id: null,
      transfer_receipt_url: null,
    })
    .returns();
  if (error) return { error };
  const order = data[0];
  orderIds.push(order.order_id);
  const { data: customerOrder } = await admin.from("orders").select("customer_id").eq("id", order.order_id).single();
  if (customerOrder?.customer_id) customerIds.add(customerOrder.customer_id);
  return { order };
}

async function orderState(orderId) {
  const { data, error } = await admin
    .from("orders")
    .select("id, status, payment_timing, cash_on_delivery_fee, total, order_reservation_status, reservation_review_required, payments(payment_status, payment_timing, bank_reference_number), inventory_reservations(status, expires_at, review_required)")
    .eq("id", orderId)
    .single();
  assert.ifError(error);
  return data;
}

async function productState(productId) {
  const { data, error } = await admin.from("products").select("stock, reserved_stock, available_stock").eq("id", productId).single();
  assert.ifError(error);
  return data;
}

async function expireReservation(orderId) {
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  assert.ifError((await admin.from("inventory_reservations").update({ expires_at: expiredAt }).eq("order_id", orderId).eq("status", "reserved")).error);
  assert.ifError((await admin.from("orders").update({ reservation_expires_at: expiredAt, reservation_review_required: false }).eq("id", orderId)).error);
}

try {
  const manager = await createRoleClient("manager", "admin");
  const warehouse = await createRoleClient("warehouse", "bodega");

  const deliveryTransferProduct = await createProduct("transfer-delivery");
  const deliveryTransfer = await createOrder(deliveryTransferProduct, { timing: "on_delivery", reference: null, phone: "99990001" });
  assert.ifError(deliveryTransfer.error);

  let state = await orderState(deliveryTransfer.order.order_id);
  assert.equal(state.payment_timing, "on_delivery");
  assert.equal(state.payments[0].payment_timing, "on_delivery");
  assert.equal(state.payments[0].bank_reference_number, null);
  assert.ok(Number(state.cash_on_delivery_fee) > 0, "Transfer on delivery must include COD fee");
  assert.equal(state.order_reservation_status, "reserved");
  assert.deepEqual(await productState(deliveryTransferProduct), { stock: 1, reserved_stock: 1, available_stock: 0 });

  const competingOrder = await createOrder(deliveryTransferProduct, { timing: "on_delivery", reference: null, phone: "99990002" });
  assert.ok(competingOrder.error, "Second checkout must lose the last-unit race");

  await expireReservation(deliveryTransfer.order.order_id);
  const { data: detected, error: detectedError } = await admin.rpc("check_expired_inventory_reservations", { max_orders: 100 });
  assert.ifError(detectedError);
  assert.ok(Number(detected) >= 1);
  state = await orderState(deliveryTransfer.order.order_id);
  assert.equal(state.reservation_review_required, true);
  assert.equal(state.inventory_reservations[0].status, "reserved", "Expired reservation must stay reserved until manual review");
  assert.deepEqual(await productState(deliveryTransferProduct), { stock: 1, reserved_stock: 1, available_stock: 0 });

  const { data: alert, error: alertError } = await admin
    .from("internal_notifications")
    .select("event_type, status")
    .eq("order_id", deliveryTransfer.order.order_id)
    .eq("event_type", "reservation.expired_review_required")
    .single();
  assert.ifError(alertError);
  assert.equal(alert.status, "open");

  assert.ifError((await manager.rpc("add_order_internal_note", { target_order_id: deliveryTransfer.order.order_id, note_text: "Cliente confirmó entrega programada." })).error);
  assert.ifError((await manager.rpc("extend_order_reservation", { target_order_id: deliveryTransfer.order.order_id, extension_minutes: 720, extension_reason: "Entrega programada con cliente." })).error);
  state = await orderState(deliveryTransfer.order.order_id);
  assert.equal(state.reservation_review_required, false);
  assert.ok(new Date(state.inventory_reservations[0].expires_at).getTime() > Date.now());

  assert.ok((await manager.rpc("confirm_manual_order_payment", { target_order_id: deliveryTransfer.order.order_id })).error, "On-delivery payment cannot confirm before delivery");
  assert.ifError((await admin.from("orders").update({ status: "entregado", tracking_status: "entregado" }).eq("id", deliveryTransfer.order.order_id)).error);
  assert.ifError((await manager.rpc("confirm_manual_order_payment", { target_order_id: deliveryTransfer.order.order_id })).error);
  state = await orderState(deliveryTransfer.order.order_id);
  assert.equal(state.payments[0].payment_status, "approved");
  assert.equal(state.order_reservation_status, "confirmed");
  assert.deepEqual(await productState(deliveryTransferProduct), { stock: 0, reserved_stock: 0, available_stock: 0 });

  const bankProduct = await createProduct("transfer-now");
  assert.ok((await createOrder(bankProduct, { timing: "before_delivery", reference: null, phone: "99990003" })).error, "Transfer now requires reference");
  const bankOrder = await createOrder(bankProduct, { timing: "before_delivery", reference: "REF-9988", phone: "99990004" });
  assert.ifError(bankOrder.error);
  state = await orderState(bankOrder.order.order_id);
  assert.equal(Number(state.cash_on_delivery_fee), 0);
  assert.equal(state.payments[0].bank_reference_number, "REF-9988");
  assert.ifError((await manager.rpc("reject_order_payment_and_release", { target_order_id: bankOrder.order.order_id, rejection_reason: "Referencia no encontrada." })).error);
  state = await orderState(bankOrder.order.order_id);
  assert.equal(state.status, "cancelado");
  assert.equal(state.payments[0].payment_status, "rejected");
  assert.ok(["released", "canceled"].includes(state.order_reservation_status));
  assert.deepEqual(await productState(bankProduct), { stock: 1, reserved_stock: 0, available_stock: 1 });

  const cardProduct = await createProduct("card");
  const cardOrder = await createOrder(cardProduct, { method: "card", timing: "before_delivery", reference: null, phone: "99990005" });
  assert.ifError(cardOrder.error);
  assert.ok((await manager.rpc("confirm_manual_order_payment", { target_order_id: cardOrder.order.order_id })).error, "Card cannot be confirmed manually");
  assert.ifError((await admin.rpc("confirm_card_payment_from_backend", { target_order_id: cardOrder.order.order_id, provider_reference: "BAC-TEST-123" })).error);
  state = await orderState(cardOrder.order.order_id);
  assert.equal(state.payments[0].payment_status, "approved");
  assert.equal(state.order_reservation_status, "confirmed");

  const cashProduct = await createProduct("cash");
  const cashOrder = await createOrder(cashProduct, { method: "cash", timing: "before_delivery", reference: null, phone: "99990006" });
  assert.ifError(cashOrder.error);
  state = await orderState(cashOrder.order.order_id);
  assert.equal(state.payment_timing, "on_delivery");
  assert.ok(Number(state.cash_on_delivery_fee) > 0);
  assert.ok((await warehouse.rpc("confirm_manual_order_payment", { target_order_id: cashOrder.order.order_id })).error, "Warehouse role cannot confirm payments");
  assert.ifError((await admin.from("orders").update({ status: "preparacion", tracking_status: "preparacion" }).eq("id", cashOrder.order.order_id)).error);
  await expireReservation(cashOrder.order.order_id);
  assert.ifError((await admin.rpc("check_expired_inventory_reservations", { max_orders: 100 })).error);
  state = await orderState(cashOrder.order.order_id);
  assert.equal(state.status, "preparacion");
  assert.equal(state.inventory_reservations[0].status, "reserved", "Advanced logistics reservation must not auto-release");

  const { data: roles, error: rolesError } = await admin
    .from("roles")
    .select("name, permissions")
    .in("name", ["technical_owner", "business_owner", "admin", "contadora", "bodega"]);
  assert.ifError(rolesError);
  const permissions = new Map(roles.map((role) => [role.name, role.permissions]));
  for (const role of ["technical_owner", "business_owner", "admin"]) {
    assert.equal(permissions.get(role).includes("payments:confirm"), true, `${role} must confirm payments`);
  }
  assert.equal(permissions.get("contadora").includes("payments:confirm"), false, "contadora must not confirm payments");
  assert.equal(permissions.get("contadora").includes("payments:manage"), false, "contadora must not manage payments");
  assert.equal(permissions.get("bodega").includes("payments:confirm"), false);
  assert.equal(permissions.get("bodega").includes("reservations:review"), true);

  const { data: technicalSettings, error: technicalSettingsError } = await admin
    .from("technical_alert_settings")
    .select("service_account_email")
    .eq("id", true)
    .single();
  assert.ifError(technicalSettingsError);
  assert.equal(technicalSettings.service_account_email, "carzonetech0@gmail.com");

  console.log("Remote payment and reservation workflow checks passed.");
} finally {
  if (orderIds.length) {
    await admin.from("notification_logs").delete().in("order_id", orderIds);
    await admin.from("invoices").delete().in("order_id", orderIds);
    await admin.from("inventory_movements").delete().in("reference_id", orderIds);
    await admin.from("orders").delete().in("id", orderIds);
  }
  if (customerIds.size) await admin.from("customers").delete().in("id", [...customerIds]);
  if (productIds.length) {
    await admin.from("inventory_movements").delete().in("product_id", productIds);
    await admin.from("products").delete().in("id", productIds);
  }
  for (const userId of authUserIds) await admin.auth.admin.deleteUser(userId);
}
