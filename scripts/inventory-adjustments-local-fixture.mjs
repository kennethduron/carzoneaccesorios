import { createClient } from "@supabase/supabase-js";

const PREFIX = "INVENTORY-ADJUSTMENT-IMPLEMENTATION-LOCAL-ONLY";
const EMAIL = "inventory-adjustment-local@carzone.test";
const PASSWORD = "Local-only-Inventory-2026!";
const localUrl = process.env.LOCAL_SUPABASE_URL;
const localServiceKey = process.env.LOCAL_SUPABASE_SERVICE_ROLE_KEY;
if (!localUrl?.startsWith("http://127.0.0.1:") || !localServiceKey) throw new Error("Local Supabase is required.");
const admin = createClient(localUrl, localServiceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const permissions = ["admin:access","inventory:read","inventory:manage","inventory:adjust_read","inventory:adjust_create","inventory:adjust_confirm","inventory:adjust_reverse","inventory:cost_read","products:read"];
let { data: role } = await admin.from("roles").select("id").eq("name", "admin").maybeSingle();
if (!role) ({ data: role } = await admin.from("roles").insert({ name: "admin", description: PREFIX, permissions }).select("id").single());
else await admin.from("roles").update({ permissions }).eq("id", role.id);

const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
let authUser = listed.data.users.find((user) => user.email === EMAIL);
if (!authUser) {
  const created = await admin.auth.admin.createUser({ email: EMAIL, password: PASSWORD, email_confirm: true, user_metadata: { full_name: PREFIX } });
  if (created.error) throw created.error;
  authUser = created.data.user;
}
if (!authUser) throw new Error("Could not create local user.");
const userWrite = await admin.from("users").upsert({ id: authUser.id, role_id: role.id, full_name: PREFIX, email: EMAIL, active: true });
if (userWrite.error) throw userWrite.error;
const { data: category } = await admin.from("categories").select("id").eq("slug", "exterior").single();
for (const [index, stock, reserved] of [[1, 25, 3], [2, 12, 0], [3, 6, 4]]) {
  const sku = `INV-ADJ-UI-${String(index).padStart(3,"0")}`;
  const product = { category_id: category.id, sku, slug: sku.toLowerCase(), name: `${PREFIX} Producto ${index}`, brand: "Car Zone", stock, reserved_stock: reserved, retail_price: 500, wholesale_price: 450, cost_price: 300, active: index !== 3, status: index !== 3 ? "active" : "inactive" };
  const write = await admin.from("products").upsert(product, { onConflict: "sku" });
  if (write.error) throw write.error;
}
console.log(JSON.stringify({ email: EMAIL, password: PASSWORD, prefix: PREFIX }));
