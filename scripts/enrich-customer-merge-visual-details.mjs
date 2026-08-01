import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost):54321$/, "visual enrichment may run only against local Supabase");
assert.ok(process.env.SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY is required");

const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const ids = {
  secondary: "da100000-0000-4000-8000-000000000002",
  order: "da200000-0000-4000-8000-000000000001",
  reservationA: "da700000-0000-4000-8000-000000000001",
  reservationB: "da700000-0000-4000-8000-000000000002",
  movementA: "da800000-0000-4000-8000-000000000001",
  movementB: "da800000-0000-4000-8000-000000000002",
  journal: "da900000-0000-4000-8000-000000000001",
  journalLineA: "daa00000-0000-4000-8000-000000000001",
  journalLineB: "daa00000-0000-4000-8000-000000000002",
  accountDebit: "dad00000-0000-4000-8000-000000000001",
  accountCredit: "dad00000-0000-4000-8000-000000000002",
};

const [{ data: order, error: orderError }, { data: products, error: productsError }, { data: accounts, error: accountsError }, { data: owner, error: ownerError }] = await Promise.all([
  admin.from("orders").select("id").eq("id", ids.order).single(),
  admin.from("products").select("id").order("created_at").limit(2),
  admin.from("accounting_accounts").select("id").eq("is_active", true).order("code").limit(2),
  admin.from("users").select("id").eq("email", "customer-merge-owner@example.test").single(),
]);
assert.ifError(orderError);
assert.ifError(productsError);
assert.ifError(accountsError);
assert.ifError(ownerError);
assert.equal(order.id, ids.order);
let fixtureProducts = products ?? [];
let fixtureAccounts = accounts ?? [];
if (fixtureProducts.length < 2) {
  const { data: existingCategory, error: categoryLookupError } = await admin.from("categories").select("id").order("created_at").limit(1).maybeSingle();
  assert.ifError(categoryLookupError);
  let categoryId = existingCategory?.id;
  if (!categoryId) {
    const { data: createdCategory, error: categoryCreateError } = await admin.from("categories").upsert({
      id: "dac00000-0000-4000-8000-000000000001",
      name: "Categoria visual merge",
      slug: "categoria-visual-merge",
      active: true,
    }, { onConflict: "id" }).select("id").single();
    assert.ifError(categoryCreateError);
    categoryId = createdCategory.id;
  }
  const { data: createdProducts, error: createProductsError } = await admin.from("products").upsert([
    { id: "dab00000-0000-4000-8000-000000000001", category_id: categoryId, sku: "VISUAL-MERGE-A", slug: "visual-merge-a", name: "Producto visual A", brand: "Fixture", stock: 10, retail_price: 100, wholesale_price: 90, cost_price: 60, status: "active", active: true },
    { id: "dab00000-0000-4000-8000-000000000002", category_id: categoryId, sku: "VISUAL-MERGE-B", slug: "visual-merge-b", name: "Producto visual B", brand: "Fixture", stock: 10, retail_price: 200, wholesale_price: 180, cost_price: 120, status: "active", active: true },
  ], { onConflict: "id" }).select("id");
  assert.ifError(createProductsError);
  fixtureProducts = createdProducts ?? [];
}
assert.equal(fixtureProducts.length, 2, "two local products are required");
if (fixtureAccounts.length < 2) {
  const { data: createdAccounts, error: createAccountsError } = await admin.from("accounting_accounts").upsert([
    { id: ids.accountDebit, code: "VISUAL-1101", name: "Cuenta débito visual", type: "asset", normal_balance: "debit", is_active: true, description: "Fixture local del asistente de fusión" },
    { id: ids.accountCredit, code: "VISUAL-4101", name: "Cuenta crédito visual", type: "revenue", normal_balance: "credit", is_active: true, description: "Fixture local del asistente de fusión" },
  ], { onConflict: "id" }).select("id");
  assert.ifError(createAccountsError);
  fixtureAccounts = createdAccounts ?? [];
}
assert.equal(fixtureAccounts.length, 2, "two local accounting accounts are required");

for (const [table, rowIds] of [
  ["inventory_reservations", [ids.reservationA, ids.reservationB]],
  ["inventory_movements", [ids.movementA, ids.movementB]],
  ["journal_entry_lines", [ids.journalLineA, ids.journalLineB]],
  ["journal_entries", [ids.journal]],
]) {
  const { error } = await admin.from(table).delete().in("id", rowIds);
  assert.ifError(error);
}

const now = new Date().toISOString();
const expires = new Date(Date.now() + 86_400_000).toISOString();
const { error: reservationsError } = await admin.from("inventory_reservations").insert([
  { id: ids.reservationA, order_id: ids.order, product_id: fixtureProducts[0].id, quantity: 2, status: "confirmed", expires_at: expires, confirmed_at: now },
  { id: ids.reservationB, order_id: ids.order, product_id: fixtureProducts[1].id, quantity: 1, status: "confirmed", expires_at: expires, confirmed_at: now },
]);
assert.ifError(reservationsError);

const { error: movementsError } = await admin.from("inventory_movements").insert([
  { id: ids.movementA, product_id: fixtureProducts[0].id, user_id: owner.id, movement_type: "sale", quantity: -2, stock_before: 10, stock_after: 8, reference_type: "order", reference_id: ids.order, notes: "Fixture visual local" },
  { id: ids.movementB, product_id: fixtureProducts[1].id, user_id: owner.id, movement_type: "sale", quantity: -1, stock_before: 10, stock_after: 9, reference_type: "order", reference_id: ids.order, notes: "Fixture visual local" },
]);
assert.ifError(movementsError);

const { error: journalError } = await admin.from("journal_entries").insert({
  id: ids.journal,
  entry_number: "PC-VISUAL-MERGE-001",
  entry_date: new Date().toISOString().slice(0, 10),
  description: "Partida sintética de validación visual",
  status: "borrador",
  source_type: "order",
  source_id: ids.order,
  created_by: owner.id,
});
assert.ifError(journalError);
const { error: linesError } = await admin.from("journal_entry_lines").insert([
  { id: ids.journalLineA, journal_entry_id: ids.journal, account_id: fixtureAccounts[0].id, debit: 2300, credit: 0, customer_id: ids.secondary, description: "Débito sintético" },
  { id: ids.journalLineB, journal_entry_id: ids.journal, account_id: fixtureAccounts[1].id, debit: 0, credit: 2300, customer_id: ids.secondary, description: "Crédito sintético" },
]);
assert.ifError(linesError);
const { error: postError } = await admin.from("journal_entries").update({ status: "publicada", posted_by: owner.id, posted_at: now }).eq("id", ids.journal);
assert.ifError(postError);

console.log("Local customer merge visual details enriched.", {
  reservations: 2,
  reservedQuantity: 3,
  inventoryMovements: 2,
  netMovementQuantity: -3,
  accountingEntries: 1,
});
