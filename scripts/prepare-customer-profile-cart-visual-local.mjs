import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const password = process.env.CUSTOMER_VISUAL_PASSWORD ?? "Local-Cz-Customer-2026!";
const mode = process.argv[2] ?? "setup";
assert.ok(serviceKey, "Local service role key is required.");
assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost):54321$/, "Visual fixtures are local-only.");

const marker = "CUSTOMER-PROFILE-CART-LOCAL-ONLY";
const email = `${marker.toLowerCase()}@example.test`;
const slug = `${marker.toLowerCase()}-product`;
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

async function matchingUsers() {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  assert.ifError(error);
  return data.users.filter((user) => user.email === email);
}

async function cleanup() {
  const users = await matchingUsers();
  const userIds = users.map((user) => user.id);
  if (userIds.length) {
    const { data: customers } = await admin.from("customers").select("id").in("user_id", userIds);
    const customerIds = (customers ?? []).map((customer) => customer.id);
    if (customerIds.length) {
      await admin.from("audit_logs").delete().in("record_id", customerIds);
      await admin.from("customers").delete().in("id", customerIds);
    }
    for (const user of users) await admin.auth.admin.deleteUser(user.id);
  }
  await admin.from("products").delete().eq("slug", slug);
}

await cleanup();
if (mode === "cleanup") {
  console.log("Customer profile/cart visual fixture cleanup: OK");
  process.exit(0);
}

const { data: role, error: roleError } = await admin
  .from("roles")
  .upsert({ name: "cliente", description: "Cliente de portal", permissions: ["store:buy"] }, { onConflict: "name" })
  .select("id")
  .single();
assert.ifError(roleError);
const { data: authUser, error: authError } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: "Cliente Visual Local", username: "cliente.visual.local", phone: "+504 9999-7788" },
});
assert.ifError(authError);
assert.ifError((await admin.from("users").update({ role_id: role.id, active: true }).eq("id", authUser.user.id)).error);
const { data: customer, error: customerError } = await admin
  .from("customers")
  .insert({
    user_id: authUser.user.id,
    contact_name: "Cliente Visual Local",
    email,
    status: "active",
    active: true,
    source: "local_visual_test",
    lead_status: "cliente",
  })
  .select("id")
  .single();
assert.ifError(customerError);

const { data: category, error: categoryError } = await admin.from("categories").select("id").eq("active", true).limit(1).single();
assert.ifError(categoryError);
const { error: productError } = await admin.from("products").insert({
  category_id: category.id,
  sku: `${marker}-001`,
  internal_code: `${marker}-001`,
  slug,
  name: "Barra LED de prueba local",
  brand: "Car Zone",
  description: "Producto aislado para certificar el control de cantidad.",
  stock: 80,
  reserved_stock: 0,
  cost_price: 500,
  retail_price: 920,
  wholesale_price: 850,
  wholesale_min_quantity: 50,
  tax_category: "standard",
  tracks_inventory: true,
  status: "active",
  active: true,
});
assert.ifError(productError);

console.log(JSON.stringify({ email, password, customerId: customer.id, productSlug: slug, marker }, null, 2));
