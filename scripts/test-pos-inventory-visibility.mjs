import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  applyPosDraftInventorySnapshots,
  isPosDraftItemStockInsufficient,
} from "../src/lib/pos/inventory-mode.ts";

const productId = crypto.randomUUID();
const originalDraft = {
  draftId: crypto.randomUUID(),
  customerId: crypto.randomUUID(),
  version: 7,
  deliveryMode: "home_delivery",
  deliveryAddress: "Dirección intacta",
  additionalCharge: 25,
  additionalChargeDescription: "Instalación",
  paymentMarker: "no-reconstruir",
  items: [{
    productId,
    productName: "Producto reservado",
    quantity: 3,
    availableStock: 5,
    physicalStock: 5,
    reservedStock: 0,
    tracksInventory: true,
    hasActiveReservations: false,
    stockObservedAt: "2026-08-08T00:00:00.000Z",
    stockStatus: "available",
    validationStatus: "valid",
    validationMessages: [],
    costFloorValidated: true,
    finalUnitPrice: 777,
    priceOverridden: true,
    priceOverrideReason: "Autorización intacta",
  }],
  validationStatus: "valid",
  validationMessages: [],
};
const refreshed = applyPosDraftInventorySnapshots(originalDraft, new Map([[productId, {
  productId,
  tracksInventory: true,
  physicalStock: 5,
  reservedStock: 3,
  availableStock: 2,
  hasActiveReservations: true,
  stockObservedAt: "2026-08-08T00:01:00.000Z",
}]]));
assert.equal(refreshed.customerId, originalDraft.customerId);
assert.equal(refreshed.version, 7);
assert.equal(refreshed.deliveryAddress, "Dirección intacta");
assert.equal(refreshed.additionalChargeDescription, "Instalación");
assert.equal(refreshed.paymentMarker, "no-reconstruir");
assert.equal(refreshed.items[0].finalUnitPrice, 777);
assert.equal(refreshed.items[0].priceOverrideReason, "Autorización intacta");
assert.equal(refreshed.items[0].physicalStock, 5);
assert.equal(refreshed.items[0].reservedStock, 3);
assert.equal(refreshed.items[0].availableStock, 2);
assert.equal(isPosDraftItemStockInsufficient(refreshed.items[0]), true);

const untracked = applyPosDraftInventorySnapshots(originalDraft, new Map([[productId, {
  productId,
  tracksInventory: false,
  physicalStock: null,
  reservedStock: null,
  availableStock: null,
  hasActiveReservations: false,
  stockObservedAt: "2026-08-08T00:02:00.000Z",
}]]));
assert.equal(untracked.items[0].physicalStock, null);
assert.equal(untracked.items[0].reservedStock, null);
assert.equal(untracked.items[0].availableStock, null);
assert.equal(isPosDraftItemStockInsufficient(untracked.items[0]), false);

const [migration, service, cart, search, workspace, confirmation, confirmRoute, snapshotRoute, reservationsRoute, dialog] = await Promise.all([
  readFile(new URL("../supabase/migrations/202608080002_pos_inventory_visibility_read_models.sql", import.meta.url), "utf8"),
  readFile(new URL("../src/services/supabase/pos-draft.service.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-cart.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-product-search.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-confirmation-panel.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/app/api/admin/pos/drafts/[draftId]/confirm/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/app/api/admin/pos/products/inventory/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/app/api/admin/pos/products/[productId]/reservations/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-product-reservations-dialog.tsx", import.meta.url), "utf8"),
]);

assert.match(migration, /get_pos_product_inventory_snapshot_v1/);
assert.match(migration, /get_pos_product_reservations_v1/);
assert.match(migration, /security definer/gi);
assert.match(migration, /set search_path = public/gi);
assert.doesNotMatch(migration, /alter\s+table|create\s+table|create\s+trigger/i);
assert.match(service, /get_pos_product_inventory_snapshot_v1/);
assert.doesNotMatch(service, /get_pos_product_inventory_modes_v1/);
assert.match(service, /get_pos_product_reservations_v1/);
assert.match(cart, /Disponible:/);
assert.match(cart, /Sin control de inventario/);
assert.match(cart, /Ver pedidos relacionados/);
assert.doesNotMatch(cart, />Existencia:\s*\{/);
assert.match(search, /reservada\{product\.reservedStock === 1/);
assert.match(workspace, /applyPosInventorySnapshotsToItems/);
assert.match(workspace, /data-pos-product-id/);
assert.doesNotMatch(workspace, /applyDraft\([^)]*snapshot/i);
assert.match(confirmation, /POS_INSUFFICIENT_STOCK/);
assert.match(confirmation, /POS_PRODUCT_INACTIVE/);
assert.match(confirmation, /Existencia física:/);
assert.match(confirmRoute, /POS_INSUFFICIENT_STOCK/);
assert.match(confirmRoute, /\? 409/);
assert.match(snapshotRoute, /authorizePosCustomerRequest\("pos:products:search"\)/);
assert.match(reservationsRoute, /orders:read/);
assert.match(reservationsRoute, /orders:manage/);
assert.match(dialog, /\/admin\/pedidos\?orderId=/);
assert.match(dialog, /aria-modal="true"/);
assert.match(dialog, /event\.key === "Escape"/);
assert.doesNotMatch(reservationsRoute, /\.from\(|\.select\(/, "reservation endpoint delegates only to the PII-free RPC service");
assert.doesNotMatch(dialog, /customer(Name|Email|Phone|Address)|\brtn\b|payment/i, "reservation dialog renders no customer or payment PII");

console.log("POS inventory visibility, conflict preservation, read-only detail and Spanish UI contracts: PASS");
