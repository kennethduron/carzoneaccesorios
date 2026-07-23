import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const allowedRoles = ["technical_owner", "business_owner", "admin"];
const deniedRoles = ["contadora", "vendedor", "bodega", "soporte", "cliente"];
const permissionSet = new Set(["pos:create_sale", "pos:apply_discount"]);
const hasPosPermission = (role, permissions, permission) =>
  allowedRoles.includes(role) && permissionSet.has(permission) && permissions.includes(permission);

for (const role of allowedRoles) {
  for (const permission of permissionSet) assert.equal(hasPosPermission(role, [permission], permission), true);
}
for (const role of deniedRoles) {
  for (const permission of permissionSet) assert.equal(hasPosPermission(role, [permission], permission), false);
}
assert.equal(hasPosPermission("admin", [], "pos:create_sale"), false);

const [migration, helper, types, contract, accounting, transitions, plan, checkout] = await Promise.all([
  read("supabase/migrations/202607210003_pos_phase_1_foundation.sql"),
  read("src/lib/auth/pos-permissions.ts"),
  read("src/types/point-of-sale.ts"),
  read("docs/point-of-sale/phase-1-contract.md"),
  read("docs/point-of-sale/accounting-contract.md"),
  read("docs/point-of-sale/state-transitions.md"),
  read("docs/point-of-sale/implementation-plan.md"),
  read("src/app/checkout/actions.ts"),
]);

assert.match(helper, /posAuthorizedRoles = \["technical_owner", "business_owner", "admin"\]/);
assert.match(helper, /profile\.permissions\.includes\(permission\)/);
for (const column of ["source", "channel", "created_by", "seller_id"]) {
  assert.match(migration, new RegExp(`add column if not exists ${column}`));
}
assert.match(migration, /source text not null default 'web'/);
assert.match(migration, /channel text not null default 'website'/);
assert.match(migration, /orders_origin_actor_consistency_check/);
assert.match(migration, /orders_internal_source_created_at_idx/);
assert.match(migration, /orders_internal_channel_created_at_idx/);
assert.match(migration, /orders_created_by_created_at_idx/);
assert.match(migration, /protect_order_origin_metadata/);
assert.match(migration, /"pos:create_sale", "pos:apply_discount"/);
assert.match(migration, /where name in \('technical_owner', 'business_owner', 'admin'\)/);
assert.match(migration, /where name in \('contadora', 'vendedor', 'bodega', 'soporte', 'cliente'\)/);
assert.match(migration, /public\.current_actor_role\(\) in \('technical_owner', 'business_owner', 'admin'\)/);
assert.match(migration, /public\.has_permission\(permission_key\)/);

assert.match(migration, /create table if not exists public\.pos_idempotency_requests/);
assert.match(migration, /request_key uuid not null/);
assert.match(migration, /unique \(operation, request_key\)/);
assert.match(migration, /status in \('processing', 'succeeded', 'failed'\)/);
assert.match(migration, /on conflict \(operation, request_key\) do nothing/);
assert.match(migration, /for update/);
assert.match(migration, /stored\.actor_id <> actor_user_id/);
assert.match(migration, /stored\.payload_hash <> normalized_hash/);
assert.match(migration, /lease_expires_at/);
assert.match(migration, /get_pos_idempotency_status_v1/);
assert.match(migration, /requests\.actor_id = auth\.uid\(\)/);
assert.match(migration, /enable row level security/);
assert.match(migration, /revoke all on table public\.pos_idempotency_requests from public, anon, authenticated/);
assert.doesNotMatch(migration, /grant .*pos_idempotency_requests to anon/);
assert.match(migration, /security definer[\s\S]*set search_path = public/);
assert.match(migration, /revoke all on function public\.claim_pos_idempotency_v1[\s\S]*authenticated/);
assert.match(migration, /grant execute on function public\.get_pos_idempotency_status_v1[\s\S]*authenticated/);

assert.doesNotMatch(migration, /create_internal_sale_v1\s*\(/);
assert.doesNotMatch(migration, /insert into public\.(orders|payments|invoices|accounts_receivable|inventory_movements|financial_events|journal_entries)/);
assert.doesNotMatch(migration, /automation_mode[\s\S]*(draft_only|auto_post)/);

for (const typeName of [
  "PosSource", "PosChannel", "PosDeliveryMode", "PosPaymentMethod", "PosPaymentState",
  "PosCustomerCommercialStatus", "PosCreditSnapshot", "PosPriceSnapshot", "PosDiscountInput",
  "PosDeliveryChargeInput", "PosSaleRequest", "PosSaleResult", "PosRecoverableWarning",
]) assert.match(types, new RegExp(`export type ${typeName}`));
assert.doesNotMatch(types, /\bany\b/);
assert.doesNotMatch(types, /finalPrice|finalTax|stockAvailable|actorId|actorRole/);

assert.match(checkout, /rpc\("create_checkout_order_v2"/);
assert.match(contract, /orders\.user_id/);
assert.match(contract, /L 10,000/);
assert.match(contract, /ISV incluido/);
assert.match(contract, /mercadería final después de descuentos/);
assert.match(contract, /L 120/);
assert.match(contract, /confirmación excepcional/);
assert.match(contract, /fuera de la base gravada/);
assert.match(accounting, /sale_revenue/);
assert.match(accounting, /payment_received/);
assert.match(accounting, /inventory_cogs/);
assert.match(transitions, /Transferencia o tarjeta pendiente/);
assert.match(plan, /Etapa 3/);

console.log("POS phase 1 runtime structure checks passed.", {
  allowedRoles,
  deniedRoles,
  idempotencyStates: ["processing", "succeeded", "failed"],
  anonymousAccess: false,
  realSalesImplemented: false,
  accountingAutomationChanged: false,
});
