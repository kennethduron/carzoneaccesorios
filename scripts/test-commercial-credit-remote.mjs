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
const authUserIds = [];
const customerIds = [];
const productIds = [];
const orderIds = [];
const receivableIds = [];
const creditAccountIds = [];

function anonymousClient() {
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function createRoleClient(label, roleName) {
  const email = `codex-credit-${label}-${suffix}@example.com`;
  const password = `Test-${suffix}-Aa1!`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(error);
  authUserIds.push(data.user.id);

  const { data: role, error: roleError } = await admin.from("roles").select("id").eq("name", roleName).single();
  assert.ifError(roleError);
  assert.ifError((await admin.from("users").update({ role_id: role.id, active: true }).eq("id", data.user.id)).error);

  const roleClient = anonymousClient();
  assert.ifError((await roleClient.auth.signInWithPassword({ email, password })).error);
  return { client: roleClient, userId: data.user.id, email };
}

async function createCustomer(user, label) {
  const { data, error } = await admin
    .from("customers")
    .insert({
      user_id: user.userId,
      contact_name: `Cliente credito ${label} ${suffix}`,
      email: user.email,
      phone: label === "active" ? "99990101" : "99990102",
      status: "active",
      active: true,
      lead_status: "cliente",
    })
    .select("id")
    .single();
  assert.ifError(error);
  customerIds.push(data.id);
  return data.id;
}

async function createProduct() {
  const { data, error } = await admin
    .from("products")
    .insert({
      sku: `CODEX-CREDIT-${suffix}`,
      slug: `codex-credit-${suffix}`,
      name: `Codex credito ${suffix}`,
      brand: "Codex",
      description: "Fixture temporal de credito comercial.",
      stock: 3,
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

async function createCreditOrder(client, productId, phone) {
  const { data, error } = await client
    .rpc("create_checkout_order_v2", {
      customer_name: `Cliente credito ${suffix}`,
      customer_email: `credit-${phone}-${suffix}@example.com`,
      customer_phone: phone,
      customer_rtn: null,
      delivery_address: "San Pedro Sula, Honduras",
      delivery_country: "Honduras",
      country_code: "HN",
      delivery_department: "Cortes",
      delivery_city: "San Pedro Sula",
      requested_price_mode: "retail",
      requested_payment_method: "commercial_credit",
      requested_payment_timing: "before_delivery",
      bank_reference_number: null,
      order_items: [{ product_id: productId, quantity: 1 }],
      wholesale_code: null,
      wholesale_code_id: null,
      transfer_receipt_url: null,
    })
    .returns();
  if (error) return { error };
  const order = data[0];
  orderIds.push(order.order_id);
  return { order };
}

async function cleanupFixtureRows() {
  if (orderIds.length) {
    const { data: linkedReceivables } = await admin
      .from("accounts_receivable")
      .select("id")
      .in("order_id", orderIds);
    for (const row of linkedReceivables ?? []) {
      if (!receivableIds.includes(row.id)) receivableIds.push(row.id);
    }
  }
  if (receivableIds.length) {
    await admin.from("email_queue").delete().in("related_id", receivableIds);
    await admin.from("accounts_receivable").delete().in("id", receivableIds);
  }
  if (orderIds.length) {
    await admin.from("notification_logs").delete().in("order_id", orderIds);
    await admin.from("internal_notifications").delete().in("order_id", orderIds);
    await admin.from("inventory_movements").delete().in("reference_id", orderIds);
    await admin.from("invoices").delete().in("order_id", orderIds);
    await admin.from("orders").delete().in("id", orderIds);
  }
  if (customerIds.length) {
    await admin.from("internal_notifications").delete().in("customer_id", customerIds);
    await admin.from("email_queue").delete().in("idempotency_key", customerIds.map((id) => `credit.enabled:${id}`));
  }
  if (creditAccountIds.length) await admin.from("email_queue").delete().in("related_id", creditAccountIds);
  if (creditAccountIds.length) await admin.from("customer_credit_accounts").delete().in("id", creditAccountIds);
  if (customerIds.length) await admin.from("customers").delete().in("id", customerIds);
  if (productIds.length) {
    await admin.from("inventory_movements").delete().in("product_id", productIds);
    await admin.from("products").delete().in("id", productIds);
  }
  for (const userId of authUserIds) await admin.auth.admin.deleteUser(userId);
}

async function cleanupStaleFixtures() {
  const { data: staleProducts } = await admin.from("products").select("id").like("sku", "CODEX-CREDIT-%");
  const staleProductIds = (staleProducts ?? []).map((row) => row.id);
  const { data: staleItems } = staleProductIds.length
    ? await admin.from("order_items").select("order_id").in("product_id", staleProductIds)
    : { data: [] };
  const staleOrderIds = [...new Set((staleItems ?? []).map((row) => row.order_id))];
  const { data: staleReceivables } = staleOrderIds.length
    ? await admin.from("accounts_receivable").select("id").in("order_id", staleOrderIds)
    : { data: [] };
  const staleReceivableIds = (staleReceivables ?? []).map((row) => row.id);
  if (staleReceivableIds.length) {
    await admin.from("email_queue").delete().in("related_id", staleReceivableIds);
    await admin.from("accounts_receivable").delete().in("id", staleReceivableIds);
  }
  if (staleOrderIds.length) {
    await admin.from("notification_logs").delete().in("order_id", staleOrderIds);
    await admin.from("internal_notifications").delete().in("order_id", staleOrderIds);
    await admin.from("inventory_movements").delete().in("reference_id", staleOrderIds);
    await admin.from("invoices").delete().in("order_id", staleOrderIds);
    await admin.from("orders").delete().in("id", staleOrderIds);
  }
  const { data: staleCustomers } = await admin.from("customers").select("id").like("email", "codex-credit-%@example.com");
  const staleCustomerIds = (staleCustomers ?? []).map((row) => row.id);
  if (staleCustomerIds.length) {
    await admin.from("internal_notifications").delete().in("customer_id", staleCustomerIds);
    await admin.from("email_queue").delete().in("idempotency_key", staleCustomerIds.map((id) => `credit.enabled:${id}`));
    await admin.from("customer_credit_accounts").delete().in("customer_id", staleCustomerIds);
    await admin.from("customers").delete().in("id", staleCustomerIds);
  }
  if (staleProductIds.length) {
    await admin.from("inventory_movements").delete().in("product_id", staleProductIds);
    await admin.from("products").delete().in("id", staleProductIds);
  }
}

await cleanupStaleFixtures();

try {
  const roles = {};
  for (const roleName of [
    "technical_owner",
    "business_owner",
    "admin",
    "contadora",
    "vendedor",
    "bodega",
    "soporte",
  ]) {
    roles[roleName] = await createRoleClient(roleName, roleName);
  }
  const creditCustomerUser = await createRoleClient("customer-active", "cliente");
  const noCreditCustomerUser = await createRoleClient("customer-none", "cliente");
  const creditCustomerId = await createCustomer(creditCustomerUser, "active");
  await createCustomer(noCreditCustomerUser, "none");
  const productId = await createProduct();

  const managerRoles = ["technical_owner", "business_owner", "admin"];
  for (const roleName of managerRoles) {
    const { data, error } = await roles[roleName].client.rpc("set_customer_commercial_credit", {
      target_customer_id: creditCustomerId,
      credit_enabled: true,
      target_credit_limit: 1500,
      target_terms_days: 30,
      target_status: "active",
      internal_notes: `Prueba remota ${roleName}`,
    });
    assert.ifError(error);
    assert.equal(data.length, 1, `${roleName} must manage credit`);
    if (!creditAccountIds.includes(data[0].credit_account_id)) creditAccountIds.push(data[0].credit_account_id);
  }

  const { data: initialEnabledEmails, error: initialEnabledEmailsError } = await admin
    .from("email_queue")
    .select("id, idempotency_key, template_key")
    .eq("template_key", "commercial_credit.enabled")
    .eq("idempotency_key", `credit.enabled:${creditCustomerId}`);
  assert.ifError(initialEnabledEmailsError);
  assert.equal(initialEnabledEmails.length, 1, "Credit enabled email must be queued once on first activation");

  const { data: initialVisualNotifications, error: initialVisualNotificationsError } = await admin
    .from("internal_notifications")
    .select("id")
    .eq("customer_id", creditCustomerId)
    .eq("notification_type", "commercial_credit.enabled");
  assert.ifError(initialVisualNotificationsError);
  assert.equal(initialVisualNotifications.length, 1, "First activation must create one visual notification");

  const disableResult = await roles.admin.client.rpc("set_customer_commercial_credit", {
    target_customer_id: creditCustomerId,
    credit_enabled: false,
    target_credit_limit: 1500,
    target_terms_days: 30,
    target_status: "suspended",
    internal_notes: "Deshabilitar para probar idempotencia",
  });
  assert.ifError(disableResult.error);

  const reactivateResult = await roles.admin.client.rpc("set_customer_commercial_credit", {
    target_customer_id: creditCustomerId,
    credit_enabled: true,
    target_credit_limit: 1500,
    target_terms_days: 30,
    target_status: "active",
    internal_notes: "Reactivar para probar idempotencia",
  });
  assert.ifError(reactivateResult.error);

  const { data: enabledEmailsAfterReactivation, error: enabledEmailsAfterReactivationError } = await admin
    .from("email_queue")
    .select("id")
    .eq("template_key", "commercial_credit.enabled")
    .eq("idempotency_key", `credit.enabled:${creditCustomerId}`);
  assert.ifError(enabledEmailsAfterReactivationError);
  assert.equal(enabledEmailsAfterReactivation.length, 1, "Reactivation must not queue a second enabled email");

  const { data: visualNotificationsAfterReactivation, error: visualNotificationsAfterReactivationError } = await admin
    .from("internal_notifications")
    .select("id")
    .eq("customer_id", creditCustomerId)
    .eq("notification_type", "commercial_credit.enabled");
  assert.ifError(visualNotificationsAfterReactivationError);
  assert.equal(visualNotificationsAfterReactivation.length, 2, "Reactivation must create a new visual notification");

  const deniedRoles = ["contadora", "vendedor", "bodega", "soporte"];
  for (const roleName of deniedRoles) {
    const { data, error } = await roles[roleName].client.rpc("set_customer_commercial_credit", {
      target_customer_id: creditCustomerId,
      credit_enabled: true,
      target_credit_limit: 9999,
      target_terms_days: 60,
      target_status: "active",
      internal_notes: "Intento no autorizado",
    });
    assert.ifError(error);
    assert.deepEqual(data, [], `${roleName} must not manage credit`);
  }

  const { data: permissionAudits, error: permissionAuditError } = await admin
    .from("audit_logs")
    .select("actor_role")
    .eq("record_id", creditCustomerId)
    .eq("action", "commercial_credit.permission_denied");
  assert.ifError(permissionAuditError);
  for (const roleName of deniedRoles) {
    assert.equal(permissionAudits.some((row) => row.actor_role === roleName), true, `Missing denied audit for ${roleName}`);
  }

  const { data: noCreditRows, error: noCreditRowsError } = await noCreditCustomerUser.client
    .from("customer_credit_accounts")
    .select("id");
  assert.ifError(noCreditRowsError);
  assert.equal(noCreditRows.length, 0, "Customer without credit must not see credit data");

  const deniedCheckout = await createCreditOrder(noCreditCustomerUser.client, productId, "99990102");
  assert.ok(deniedCheckout.error, "Customer without credit must be blocked by backend");

  const { data: ownCredit, error: ownCreditError } = await creditCustomerUser.client
    .from("customer_credit_accounts")
    .select("is_credit_enabled, credit_limit, terms_days, status")
    .eq("customer_id", creditCustomerId)
    .single();
  assert.ifError(ownCreditError);
  assert.equal(ownCredit.is_credit_enabled, true);
  assert.equal(ownCredit.status, "active");

  const firstOrder = await createCreditOrder(creditCustomerUser.client, productId, "99990101");
  assert.ifError(firstOrder.error);

  const { data: orderState, error: orderStateError } = await admin
    .from("orders")
    .select("id, customer_id, payment_method, total, status, invoices(id), payments(payment_status, status), accounts_receivable(id, original_amount, balance_due, due_date, status, paid_at, payment_received_method, payment_received_reference, payment_recorded_by)")
    .eq("id", firstOrder.order.order_id)
    .single();
  assert.ifError(orderStateError);
  assert.equal(orderState.customer_id, creditCustomerId);
  assert.equal(orderState.payment_method, "commercial_credit");
  assert.equal(orderState.invoices?.length ?? 0, 0, "Credit checkout must not generate an invoice");
  assert.notEqual(orderState.payments[0].payment_status, "approved");
  const receivable = Array.isArray(orderState.accounts_receivable)
    ? orderState.accounts_receivable[0]
    : orderState.accounts_receivable;
  assert.ok(receivable);
  receivableIds.push(receivable.id);
  assert.equal(Number(receivable.original_amount), Number(orderState.total));
  assert.equal(Number(receivable.balance_due), Number(orderState.total));
  assert.equal(receivable.status, "open");

  const { data: queuedEmails, error: queuedEmailsError } = await admin
    .from("email_queue")
    .select("template_key, scheduled_at, idempotency_key, status")
    .eq("related_id", receivable.id)
    .order("scheduled_at");
  assert.ifError(queuedEmailsError);
  assert.equal(queuedEmails.length, 5);
  assert.equal(new Set(queuedEmails.map((row) => row.idempotency_key)).size, 5);

  const partialAttempt = await admin
    .from("accounts_receivable")
    .update({ balance_due: Number(receivable.balance_due) / 2 })
    .eq("id", receivable.id);
  assert.ok(partialAttempt.error, "Manual balance edits must be rejected by the database constraint");

  const secondOrder = await createCreditOrder(creditCustomerUser.client, productId, "99990101");
  assert.ok(secondOrder.error, "Credit limit must block a second order");
  assert.match(secondOrder.error.message, /supera el cr/i);

  const partialPaymentResult = await roles.admin.client.rpc("register_credit_receivable_payment", {
    target_receivable_id: receivable.id,
    payment_amount: 300,
    received_payment_method: "bank_transfer",
    payment_reference: "PARTIAL-REF-123",
    payment_received_at: new Date().toISOString(),
    payment_note: "Abono parcial de prueba remota",
    payment_receipt_url: null,
    payment_receipt_public_id: null,
    request_key: `remote-partial:${receivable.id}:${suffix}`,
  });
  assert.ifError(partialPaymentResult.error);
  assert.equal(partialPaymentResult.data.length, 1);
  assert.equal(partialPaymentResult.data[0].receivable_status, "partial");
  assert.equal(Number(partialPaymentResult.data[0].total_paid), 300);
  assert.equal(Number(partialPaymentResult.data[0].balance_due), Number(receivable.balance_due) - 300);

  const { data: partialReceivable, error: partialReceivableError } = await admin
    .from("accounts_receivable")
    .select("status, balance_due")
    .eq("id", receivable.id)
    .single();
  assert.ifError(partialReceivableError);
  assert.equal(partialReceivable.status, "partial");
  assert.equal(Number(partialReceivable.balance_due), Number(receivable.balance_due) - 300);

  const overpaymentResult = await roles.admin.client.rpc("register_credit_receivable_payment", {
    target_receivable_id: receivable.id,
    payment_amount: Number(partialReceivable.balance_due) + 1,
    received_payment_method: "cash",
    payment_reference: null,
    payment_received_at: new Date().toISOString(),
    payment_note: "Intento de sobrepago de prueba",
    payment_receipt_url: null,
    payment_receipt_public_id: null,
    request_key: `remote-overpay:${receivable.id}:${suffix}`,
  });
  assert.ok(overpaymentResult.error, "Overpayment must be blocked");
  assert.match(overpaymentResult.error.message, /saldo pendiente/i);

  const { data: accountantReceivables, error: accountantReadError } = await roles.contadora.client
    .from("accounts_receivable")
    .select("id, balance_due, status")
    .eq("id", receivable.id);
  assert.ifError(accountantReadError);
  assert.equal(accountantReceivables.length, 1, "Accountant must read receivables");

  for (const roleName of ["contadora", "vendedor", "bodega", "soporte"]) {
    const { data, error } = await roles[roleName].client.rpc("mark_credit_receivable_paid", {
      target_receivable_id: receivable.id,
      received_payment_method: "bank_transfer",
      payment_reference: "DENIED-TEST",
    });
    assert.ifError(error);
    assert.equal(data, false, `${roleName} must not mark credit paid`);
  }
  const customerMarkPaid = await creditCustomerUser.client.rpc("mark_credit_receivable_paid", {
    target_receivable_id: receivable.id,
    received_payment_method: "bank_transfer",
    payment_reference: "DENIED-CLIENT",
  });
  assert.ifError(customerMarkPaid.error);
  assert.equal(customerMarkPaid.data, false, "Customer must not mark credit paid");

  const beforeDeliveryProduct = await admin
    .from("products")
    .select("stock, reserved_stock, available_stock")
    .eq("id", productId)
    .single();
  assert.ifError(beforeDeliveryProduct.error);
  assert.deepEqual(beforeDeliveryProduct.data, { stock: 3, reserved_stock: 1, available_stock: 2 });

  assert.ifError(
    (await admin.from("orders").update({ status: "entregado", tracking_status: "entregado" }).eq("id", firstOrder.order.order_id)).error,
  );
  const afterDeliveryProduct = await admin
    .from("products")
    .select("stock, reserved_stock, available_stock")
    .eq("id", productId)
    .single();
  assert.ifError(afterDeliveryProduct.error);
  assert.deepEqual(afterDeliveryProduct.data, { stock: 2, reserved_stock: 0, available_stock: 2 });

  const noMethodPaidResult = await roles.admin.client.rpc("mark_credit_receivable_paid", {
    target_receivable_id: receivable.id,
  });
  assert.ifError(noMethodPaidResult.error);
  assert.equal(noMethodPaidResult.data, false, "Mark paid without real payment method must be blocked");

  const paidResult = await roles.admin.client.rpc("mark_credit_receivable_paid", {
    target_receivable_id: receivable.id,
    received_payment_method: "bank_transfer",
    payment_reference: "REF-123456789",
  });
  assert.ifError(paidResult.error);
  assert.equal(paidResult.data, true);

  const { data: paidReceivable, error: paidReceivableError } = await admin
    .from("accounts_receivable")
    .select("status, balance_due, paid_at, payment_received_method, payment_received_reference, payment_recorded_by")
    .eq("id", receivable.id)
    .single();
  assert.ifError(paidReceivableError);
  assert.equal(paidReceivable.status, "paid");
  assert.equal(Number(paidReceivable.balance_due), 0);
  assert.ok(paidReceivable.paid_at);
  assert.equal(paidReceivable.payment_received_method, "bank_transfer");
  assert.equal(paidReceivable.payment_received_reference, "REF-123456789");
  assert.ok(paidReceivable.payment_recorded_by);

  const secondPaidResult = await roles.admin.client.rpc("mark_credit_receivable_paid", {
    target_receivable_id: receivable.id,
    received_payment_method: "cash",
    payment_reference: null,
  });
  assert.ifError(secondPaidResult.error);
  assert.equal(secondPaidResult.data, false, "Paid receivable must not accept payment edits");

  const afterPaidProduct = await admin
    .from("products")
    .select("stock, reserved_stock, available_stock")
    .eq("id", productId)
    .single();
  assert.ifError(afterPaidProduct.error);
  assert.deepEqual(afterPaidProduct.data, afterDeliveryProduct.data, "Marking paid must not deduct inventory twice");

  const { data: pendingAfterPaid, error: pendingAfterPaidError } = await admin
    .from("accounts_receivable")
    .select("id")
    .eq("id", receivable.id)
    .in("status", ["open", "partial", "overdue"]);
  assert.ifError(pendingAfterPaidError);
  assert.equal(pendingAfterPaid.length, 0);

  const { data: creditEmailsAfterPaid, error: cancelledEmailsError } = await admin
    .from("email_queue")
    .select("template_key, status")
    .eq("related_id", receivable.id)
    .neq("template_key", "commercial_credit.created");
  assert.ifError(cancelledEmailsError);
  const reminderEmails = creditEmailsAfterPaid.filter((row) =>
    !["commercial_credit.payment_registered", "commercial_credit.paid_complete"].includes(row.template_key),
  );
  const collectionEmails = creditEmailsAfterPaid.filter((row) =>
    ["commercial_credit.payment_registered", "commercial_credit.paid_complete"].includes(row.template_key),
  );
  assert.equal(reminderEmails.every((row) => row.status === "cancelled"), true);
  assert.equal(collectionEmails.some((row) => row.template_key === "commercial_credit.payment_registered"), true);
  assert.equal(collectionEmails.some((row) => row.template_key === "commercial_credit.paid_complete"), true);

  const { data: roleRows, error: roleRowsError } = await admin
    .from("roles")
    .select("name, permissions")
    .in("name", ["technical_owner", "business_owner", "admin", "contadora", "vendedor", "bodega", "soporte", "cliente"]);
  assert.ifError(roleRowsError);
  const permissions = new Map(roleRows.map((row) => [row.name, row.permissions]));
  for (const roleName of managerRoles) {
    assert.equal(permissions.get(roleName).includes("credit:manage"), true);
    assert.equal(permissions.get(roleName).includes("credit:mark_paid"), true);
  }
  assert.equal(permissions.get("contadora").includes("receivables:read"), true);
  assert.equal(permissions.get("contadora").includes("credit:mark_paid"), false);
  for (const roleName of ["vendedor", "bodega", "soporte", "cliente"]) {
    assert.equal(permissions.get(roleName).includes("receivables:read"), false);
    assert.equal(permissions.get(roleName).includes("credit:manage"), false);
  }

  console.log("Remote commercial credit checks passed.", {
    customerWithoutCreditBlocked: true,
    customerWithCreditPurchased: true,
    limitExceededBlocked: true,
    partialPaymentAccepted: true,
    overpaymentRejected: true,
    inventoryDeductedOnDeliveryOnce: true,
    permissionsVerified: roleRows.map((row) => row.name).sort(),
  });
} finally {
  await cleanupFixtureRows();
}
