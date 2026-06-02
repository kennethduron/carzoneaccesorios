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

const { data: roles, error: rolesError } = await admin
  .from("roles")
  .select("id, name, permissions")
  .in("name", ["contadora", "bodega"]);
assert.ifError(rolesError);

const roleByName = new Map(roles.map((role) => [role.name, role]));
assert.deepEqual([...roleByName.get("bodega").permissions].sort(), [
  "admin:access",
  "inventory:manage",
  "notifications:read",
  "orders:manage_logistics",
  "orders:read",
  "products:read",
  "reservations:review",
  "shipments:manage",
].sort());
assert.equal(roleByName.get("contadora").permissions.includes("admin:access"), true);

for (const permission of ["payments:confirm", "payments:reject", "invoices:create", "invoices:manage", "crm:manage", "wholesale:manage", "security:read", "technical:tools"]) {
  assert.equal(roleByName.get("bodega").permissions.includes(permission), false, `remote bodega must not have ${permission}`);
  assert.equal(roleByName.get("contadora").permissions.includes(permission), false, `remote contadora must not have ${permission}`);
}

const allowedWarehouseNotifications = [
  "reservation.expired_review_required",
  "reservation.expiring_soon",
  "reservation.extended",
  "reservation.released",
  "order.ready_to_prepare",
  "order.logistics_review",
  "inventory.low_stock",
  "inventory.out_of_stock",
  "inventory.critical_low_stock",
];

const { data: prefsWithWarehouse, error: prefError } = await admin
  .from("notification_preferences")
  .select("notification_type, destination_roles, email_enabled")
  .contains("destination_roles", ["bodega"]);
assert.ifError(prefError);

const unexpectedWarehousePrefs = prefsWithWarehouse.filter((preference) => !allowedWarehouseNotifications.includes(preference.notification_type));
assert.equal(unexpectedWarehousePrefs.length, 0, `unexpected bodega preferences: ${unexpectedWarehousePrefs.map((item) => item.notification_type).join(", ")}`);

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const email = `codex-bodega-${suffix}@example.com`;
const password = `Bodega-${suffix}-Aa1!`;
let authUserId = null;

try {
  const { data: authUser, error: createError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(createError);
  authUserId = authUser.user.id;

  const { error: updateError } = await admin
    .from("users")
    .update({ role_id: roleByName.get("bodega").id, active: true })
    .eq("id", authUserId);
  assert.ifError(updateError);

  const bodega = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error: signInError } = await bodega.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);

  const randomOrderId = "00000000-0000-4000-8000-000000000001";
  const confirmPayment = await bodega.rpc("confirm_manual_order_payment", { target_order_id: randomOrderId });
  assert.match(confirmPayment.error?.message ?? "", /confirmar pagos/i);

  const rejectPayment = await bodega.rpc("reject_order_payment_and_release", {
    target_order_id: randomOrderId,
    rejection_reason: "Prueba bloqueada",
  });
  assert.match(rejectPayment.error?.message ?? "", /rechazar pagos/i);

  const invoiceGeneration = await bodega.rpc("generate_fiscal_invoice_from_order", { target_order_id: randomOrderId });
  assert.ok(invoiceGeneration.error, "bodega must not generate fiscal invoices");

  const logistics = await bodega.rpc("advance_order_logistics", {
    target_order_id: randomOrderId,
    target_status: "preparacion",
  });
  assert.match(logistics.error?.message ?? "", /Pedido no encontrado|Solo puedes avanzar|invalid input value for enum order_status/i);

  const { data: fiscalSettings, error: fiscalError } = await bodega.from("fiscal_settings").select("cai").limit(1);
  assert.ifError(fiscalError);
  assert.equal(fiscalSettings.length, 0, "bodega must not read fiscal settings through RLS");

  console.log("Remote warehouse scope checks passed.");
} finally {
  if (authUserId) {
    await admin.auth.admin.deleteUser(authUserId);
  }
}
