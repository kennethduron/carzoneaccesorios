import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const password = process.env.POS_VISUAL_PASSWORD;
assert.ok(serviceKey && anonKey && password, "Local keys and POS_VISUAL_PASSWORD are required.");
assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost):54321$/, "Visual fixtures are local-only.");

const marker = "POS-CUSTOMER-CART-LOCAL-ONLY-VISUAL";
const email = `${marker.toLowerCase()}@example.test`;
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const permissions = [
  "admin:access", "pos:create_sale", "pos:apply_discount", "pos:access",
  "pos:customers:search", "pos:customers:create", "pos:customers:update",
  "customers:read_commercial", "customers:read_credit", "wholesale:manage",
  "credit:read", "credit:manage", "pos:drafts:create", "pos:drafts:read",
  "pos:drafts:edit_own", "pos:drafts:edit_any", "pos:drafts:abandon",
  "pos:products:search", "pos:price_override", "pos:confirm_sale",
];

const { data: role, error: roleError } = await admin.from("roles").upsert({
  name: "technical_owner",
  description: marker,
  permissions,
}, { onConflict: "name" }).select("id").single();
assert.ifError(roleError);
const { data: authList } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
for (const user of authList.users.filter((candidate) => candidate.email === email)) {
  await admin.auth.admin.deleteUser(user.id);
}
const { data: authUser, error: authError } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: `${marker} Operador` },
});
assert.ifError(authError);
assert.ifError((await admin.from("users").update({ role_id: role.id, active: true }).eq("id", authUser.user.id)).error);
const operator = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
assert.ifError((await operator.auth.signInWithPassword({ email, password })).error);

const created = await operator.rpc("save_pos_customer_commercial_profile_v1", {
  p_request_key: crypto.randomUUID(),
  p_customer_id: null,
  p_expected_commercial_version: null,
  p_contact_name: `${marker} Cliente Mayorista`,
  p_phone: "+504 9999-1122",
  p_email: `${marker.toLowerCase()}-customer@example.test`,
  p_business_name: `${marker} Empresa`,
  p_tax_id: "08011999112233",
  p_address: "Tegucigalpa, Honduras",
  p_city: "Tegucigalpa",
  p_commercial_notes: "Fixture visual local no sensible.",
  p_customer_type: "wholesale",
  p_credit_mode: "active",
  p_credit_limit: 25000,
  p_credit_terms_days: 45,
  p_credit_notes: "Crédito visual local.",
  p_change_reason: "Preparación de certificación visual local aislada.",
});
assert.ifError(created.error);
assert.equal(created.data.ok, true);

const { data: category, error: categoryError } = await admin.from("categories").select("id").eq("active", true).limit(1).single();
assert.ifError(categoryError);
const products = [
  {
    category_id: category.id, sku: `${marker}-STOCK`, internal_code: `${marker}-001`,
    slug: `${marker.toLowerCase()}-stock`, name: `${marker} Faro LED`, brand: "Car Zone",
    description: "Producto visual con inventario", stock: 3, reserved_stock: 0, cost_price: 500,
    retail_price: 920, wholesale_price: 850, wholesale_min_quantity: 1,
    tax_category: "standard", tracks_inventory: true, status: "active", active: true,
  },
  {
    category_id: category.id, sku: `${marker}-SERVICE`, internal_code: `${marker}-002`,
    slug: `${marker.toLowerCase()}-service`, name: `${marker} Instalación profesional`, brand: "Car Zone",
    description: "Servicio visual sin inventario", stock: 0, reserved_stock: 0, cost_price: 100,
    retail_price: 500, wholesale_price: 450, wholesale_min_quantity: 1,
    tax_category: "exempt", tracks_inventory: false, status: "active", active: true,
  },
];
assert.ifError((await admin.from("products").insert(products)).error);

console.log(JSON.stringify({
  email,
  customerName: `${marker} Cliente Mayorista`,
  productQuery: marker,
  customerId: created.data.customerId,
  marker,
}, null, 2));
