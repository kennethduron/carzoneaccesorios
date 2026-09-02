import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const migration = read("supabase/migrations/202609020001_sales_commercial_phase2.sql");
const permissions = read("src/lib/auth/permissions.ts");
const confirmRoute = read("src/app/api/admin/pos/drafts/[draftId]/confirm/route.ts");
const priceRoute = read("src/app/api/admin/pos/price-requests/route.ts");
const mySalesApi = read("src/app/api/admin/pos/my-sales/route.ts");
const invoiceRoute = read("src/app/api/admin/facturas/[invoiceId]/pdf/route.ts");
const correctionRoute = read("src/app/api/admin/pos/sales/[orderId]/seller/route.ts");
const workspace = read("src/components/admin/pos-workspace.tsx");
const approvalsUi = read("src/components/admin/price-approvals-dashboard.tsx");
const salesUi = read("src/components/admin/my-sales-dashboard.tsx");

for (const expected of [
  "pos:price_request", "pos:sales:read_own", "pos:customers:write_basic",
  "pos:price_approvals:read", "pos:price_approvals:decide", "pos:seller_attribution:correct",
]) assert.ok(permissions.includes(`\"${expected}\"`), `missing permission ${expected}`);

const sellerBlock = permissions.match(/vendedor:\s*\[([\s\S]*?)\],\s*bodega:/)?.[1] ?? "";
for (const denied of ["orders:read", "customers:manage", "crm:manage", "pos:price_override", "orders:cancel", "inventory:cost_read"])
  assert.ok(!sellerBlock.includes(`\"${denied}\"`), `seller must not receive ${denied}`);
for (const allowed of ["pos:access", "pos:confirm_sale", "pos:price_request", "pos:sales:read_own"])
  assert.ok(sellerBlock.includes(`\"${allowed}\"`), `seller missing ${allowed}`);

for (const route of [confirmRoute, priceRoute, correctionRoute]) assert.ok(route.includes("verifySameOriginRequest"), "mutation route missing same-origin enforcement");
assert.ok(mySalesApi.includes('authorizePosCustomerRequest("pos:sales:read_own")'));
assert.ok(invoiceRoute.includes('"pos:sales:read_own"'));

for (const token of [
  "seller_display_name_snapshot", "pos_seller_attribution_events", "correct_pos_order_seller_v1",
  "pos_price_requests_one_open_binding_idx", "interval '30 minutes'", "consume_pos_price_approval_on_order_item_v1",
  "invalidate_changed_pos_price_requests_v1", "PHASE2_CONFIRMATION_PATCH_SOURCE_DRIFT",
  "source='pos' and order_record.seller_id=actor_id", "POS_REQUESTED_PRICE_NOT_PERMITTED",
  "request_record.seller_user_id=actor_id", "pg_advisory_xact_lock", "product_name_snapshot",
  "protect_pos_seller_attribution_v1", "'sellers',coalesce",
]) assert.ok(migration.includes(token), `migration missing ${token}`);

assert.ok(!migration.match(/update\s+public\.orders[\s\S]{0,180}where\s+seller_id\s+is\s+null/i), "historical seller backfill is prohibited");
assert.ok(migration.includes("before insert on public.order_items"), "approval must consume in confirmation transaction");
assert.ok(migration.includes("status='consumed'"), "one-use consumption missing");
assert.ok(migration.includes("where id=request_record.id and status='approved'"), "consume CAS missing");
assert.ok(migration.includes("product.cost_price") && migration.includes("POS_REQUESTED_PRICE_NOT_PERMITTED"), "cost floor fail-closed guard missing");

assert.ok(workspace.includes("hasPendingPriceRequest") && workspace.includes("priceOverrideRequestIds"));
assert.ok(approvalsUi.includes("Aprobaciones de precio") && approvalsUi.includes("Revocar autorización"));
assert.ok(salesUi.includes("Solo se muestran las ventas asignadas a tu usuario") && salesUi.includes("md:hidden"));

console.log("Sales commercial Phase 2 structural/security contracts: PASS");
