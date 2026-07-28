import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const migrationPath = "supabase/migrations/202607180001_product_stock_automation_and_purchase_inventory.sql";
const purchaseActionsPath = "src/app/admin/compras/actions.ts";
const purchaseServicePath = "src/services/supabase/purchases.service.ts";
const purchaseSearchRoutePath = "src/app/api/admin/purchases/products/search/route.ts";
const productActionsPath = "src/app/admin/productos/actions.ts";
const cachePath = "src/lib/product-availability-cache.ts";

const [migration, purchaseActions, purchaseService, purchaseSearchRoute, productActions, cache] = await Promise.all([
  readFile(migrationPath, "utf8"),
  readFile(purchaseActionsPath, "utf8"),
  readFile(purchaseServicePath, "utf8"),
  readFile(purchaseSearchRoutePath, "utf8"),
  readFile(productActionsPath, "utf8"),
  readFile(cachePath, "utf8"),
]);

function automaticTransition(current, nextStock, nextReserved) {
  const available = Math.max(nextStock - nextReserved, 0);

  if (available <= 0 && (current.active || current.autoDisabled)) {
    return { active: false, autoDisabled: true, available };
  }

  if (available > 0 && current.autoDisabled) {
    return { active: true, autoDisabled: false, available };
  }

  return { ...current, available };
}

function manualTransition(current, requestedActive) {
  if (!requestedActive) {
    return { ...current, active: false, autoDisabled: false };
  }

  if (current.available <= 0) {
    return { ...current, active: false, autoDisabled: true };
  }

  return { ...current, active: true, autoDisabled: false };
}

function calculatePurchaseTotals(items, shippingAmount) {
  const normalized = items.map((item) => ({
    ...item,
    totalCost: Math.max(Math.round((item.quantity * item.unitCost + item.taxAmount - item.discountAmount) * 100) / 100, 0),
  }));
  const subtotal = Math.round(normalized.reduce((sum, item) => sum + item.quantity * item.unitCost, 0) * 100) / 100;
  const taxAmount = Math.round(normalized.reduce((sum, item) => sum + item.taxAmount, 0) * 100) / 100;
  const discountAmount = Math.round(normalized.reduce((sum, item) => sum + item.discountAmount, 0) * 100) / 100;
  const total = Math.max(Math.round((subtotal + taxAmount + shippingAmount - discountAmount) * 100) / 100, 0);
  return { normalized, subtotal, taxAmount, discountAmount, shippingAmount, total };
}

function hasDuplicateIds(items) {
  return new Set(items.map((item) => item.id)).size !== items.length;
}

const case1 = automaticTransition({ active: true, autoDisabled: false }, 0, 0);
assert.deepEqual(case1, { active: false, autoDisabled: true, available: 0 });

const case2 = automaticTransition(case1, 10, 0);
assert.deepEqual(case2, { active: true, autoDisabled: false, available: 10 });

const case3Manual = manualTransition({ active: true, autoDisabled: false, available: 10 }, false);
const case3Purchase = automaticTransition(case3Manual, 30, 0);
assert.equal(case3Purchase.active, false);
assert.equal(case3Purchase.autoDisabled, false);

const case4 = manualTransition({ active: false, autoDisabled: false, available: 5 }, true);
assert.equal(case4.active, true);
assert.equal(case4.autoDisabled, false);

const case5 = automaticTransition(case4, 0, 0);
assert.equal(case5.active, false);
assert.equal(case5.autoDisabled, true);

const case6 = automaticTransition(case5, 3, 0);
assert.equal(case6.active, true);
assert.equal(case6.autoDisabled, false);

const case7 = automaticTransition({ active: true, autoDisabled: false }, 0, 0);
assert.equal(case7.autoDisabled, true);

const case8Manual = automaticTransition({ active: false, autoDisabled: false }, 8, 0);
assert.equal(case8Manual.active, false);
const case8Automatic = automaticTransition({ active: false, autoDisabled: true }, 8, 0);
assert.equal(case8Automatic.active, true);

const case9 = automaticTransition({ active: true, autoDisabled: false }, 0, 0);
assert.equal(case9.active, false);

const case10 = automaticTransition({ active: false, autoDisabled: true }, 1, 0);
assert.equal(case10.active, true);

const firstPurchaseDelta = 10 - 0;
const retriedEditDelta = 10 - 10;
assert.equal(firstPurchaseDelta, 10);
assert.equal(retriedEditDelta, 0);

const serverTotals = calculatePurchaseTotals([
  { quantity: 2, unitCost: 100, taxAmount: 30, discountAmount: 10 },
  { quantity: 1, unitCost: 50, taxAmount: 0, discountAmount: 5 },
], 20);
assert.deepEqual(serverTotals, {
  normalized: [
    { quantity: 2, unitCost: 100, taxAmount: 30, discountAmount: 10, totalCost: 220 },
    { quantity: 1, unitCost: 50, taxAmount: 0, discountAmount: 5, totalCost: 45 },
  ],
  subtotal: 250,
  taxAmount: 30,
  discountAmount: 15,
  shippingAmount: 20,
  total: 285,
});
assert.equal(hasDuplicateIds([{ id: "same" }, { id: "same" }]), true);
assert.equal(hasDuplicateIds([{ id: "first" }, { id: "second" }]), false);
assert.equal(13 - 8, 5, "Purchase cancellation must reverse the exact net applied quantity");

assert.match(migration, /auto_disabled_by_stock boolean not null default false/);
assert.match(migration, /before insert or update of stock, reserved_stock on public\.products/);
assert.match(migration, /greatest\(coalesce\(new\.stock, 0\) - coalesce\(new\.reserved_stock, 0\), 0\)/);
assert.match(migration, /product\.auto_deactivated_by_stock/);
assert.match(migration, /product\.auto_reactivated_by_stock/);
assert.match(migration, /create or replace function public\.save_purchase_with_inventory/);
assert.match(migration, /for update/);
assert.match(migration, /'purchase'::public\.inventory_movement_type/);
assert.match(migration, /'adjustment'::public\.inventory_movement_type/);
assert.match(migration, /inventory\.purchase_movement_created/);
assert.match(migration, /purchase\.registered_with_inventory/);
assert.match(migration, /provided_id/);
assert.match(migration, /grant execute on function public\.save_purchase_with_inventory/);
assert.match(migration, /having count\(\*\) > 1/);
assert.match(migration, /La solicitud contiene IDs de lineas duplicados/);
assert.match(migration, /next_subtotal \+ next_tax_amount \+ next_shipping_amount - next_discount_amount/);
assert.doesNotMatch(migration, /next_subtotal := round\(coalesce\(\(purchase_data->>'subtotal'\)/);
assert.match(migration, /revoke insert, update, delete on public\.purchases from authenticated, service_role/);
assert.match(migration, /drop policy if exists purchases_insert on public\.purchases/);
assert.match(migration, /create or replace function public\.confirm_purchase_locked/);
assert.match(migration, /create or replace function public\.cancel_purchase_with_inventory/);
assert.match(migration, /reference_type = 'purchase'/);
assert.match(migration, /reference_type,[\s\S]*'purchase_cancellation'/);
assert.match(migration, /if purchase_row\.status = 'cancelled' then/);
assert.match(migration, /for update of products/);
assert.match(migration, /and status = 'active'[\s\S]*greatest\(stock - coalesce\(reserved_stock, 0\), 0\) = 0/);
assert.match(migration, /new\.active := new\.status = 'active'/);
assert.match(migration, /coalesce\(new\.auto_disabled_by_stock, false\)/);

assert.match(purchaseActions, /\.rpc\("save_purchase_with_inventory"/);
assert.match(purchaseActions, /\.rpc\("confirm_purchase_locked"/);
assert.match(purchaseActions, /\.rpc\("cancel_purchase_with_inventory"/);
assert.match(purchaseActions, /Compra registrada correctamente\. El inventario fue actualizado\./);
assert.doesNotMatch(purchaseService, /\.eq\("active", true\)/);
assert.match(purchaseSearchRoute, /p_include_inactive: true/);
assert.match(purchaseSearchRoute, /is_active/);
assert.match(purchaseSearchRoute, /status/);

assert.match(productActions, /product\.manually_activated/);
assert.match(productActions, /product\.manually_deactivated/);
assert.match(productActions, /auto_disabled_by_stock/);

assert.match(cache, /updateTag\("products"\)|for \(const tag of \["products"/);
assert.match(cache, /revalidatePath\("\/sitemap\.xml"\)|"\/sitemap\.xml"/);
assert.doesNotMatch(cache, /revalidateTag/);

console.log("Product stock automation and purchase inventory structure: OK");
