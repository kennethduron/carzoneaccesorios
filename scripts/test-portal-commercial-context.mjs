import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(resolve(root, path), "utf8");
const linkMigration = read("supabase/migrations/202607280011_portal_commercial_context_wholesale_credit.sql");
const checkoutMigration = read("supabase/migrations/202607280012_checkout_order_idempotency_v3.sql");
const checkoutV4Migration = read('supabase/migrations/202607280022_checkout_v4_atomic_core.sql');
const productsService = read("src/services/supabase/products.service.ts");
const cartContext = read("src/contexts/cart-context.tsx");
const checkoutAction = read("src/app/checkout/actions.ts");
const checkoutView = read("src/components/store/checkout-view.tsx");
const crmAction = read("src/app/admin/crm/actions.ts");
const crmWorkspace = read("src/components/admin/customer-portal-link-workspace.tsx");

assert.match(linkMigration, /link_customer_portal_account_v2/);
assert.match(linkMigration, /p_expected_commercial_version integer/);
assert.match(linkMigration, /PORTAL_LINK_IDEMPOTENCY_CONFLICT/);
assert.match(linkMigration, /normalized_evidence_reference = 'audit:' \|\| a\.id::text/g);
assert.match(linkMigration, /customer_portal_link_history/);
assert.match(linkMigration, /PORTAL_LINK_HISTORY_APPEND_ONLY/);
assert.match(linkMigration, /resolve_portal_commercial_context_v1/);
assert.match(linkMigration, /portal_user_id uuid := auth\.uid\(\)/);
assert.match(linkMigration, /'effectivePriceMode', effective_price_mode/);
assert.match(linkMigration, /'creditUsable', credit_usable/);
assert.match(linkMigration, /where r\.status in \('open', 'partial', 'overdue'\)/);
assert.match(linkMigration, /CREDIT_OVERDUE_WARNING/);
assert.match(linkMigration, /normalized_evidence_reference <> \(/);
assert.match(linkMigration, /coalesce\(o\.total, o\.subtotal, 0\) >= minimum_amount/);
assert.doesNotMatch(
  linkMigration.match(/create view public\.public_catalog_products_v2[\s\S]*?grant select on public\.public_catalog_products_v2/)?.[0] ?? "",
  /\bwholesale_price\b/,
);
assert.doesNotMatch(
  linkMigration.match(/create view public\.public_catalog_products_v1[\s\S]*?grant select on public\.public_catalog_products_v1/)?.[0] ?? "",
  /\bwholesale_price\b/,
);

assert.match(checkoutMigration, /create_checkout_order_v3/);
assert.match(checkoutMigration, /checkout_idempotency_requests/);
assert.match(checkoutMigration, /for update/);
assert.match(checkoutMigration, /COMMERCIAL_CONTEXT_CHANGED/);
assert.match(checkoutMigration, /CREDIT_NOT_AVAILABLE/);
assert.match(checkoutMigration, /from public\.create_checkout_order_v2/);
assert.match(checkoutMigration, /'transfer_receipt_url', trim\(coalesce\(p_transfer_receipt_url/);
assert.match(checkoutMigration, /'context_token', nullif\(trim\(coalesce\(p_expected_context_token/);
assert.ok(
  checkoutMigration.indexOf("from public.checkout_idempotency_requests") <
    checkoutMigration.indexOf("context_record := public.resolve_portal_commercial_context_v1()"),
  "checkout replay lookup must precede current-context validation",
);

assert.match(productsService, /\.from\("portal_catalog_products_v1"\)/);
assert.match(productsService, /effective_price_mode/);
assert.doesNotMatch(productsService, /filters\.priceMode/);
assert.match(cartContext, /getCartProductsAction/);
assert.match(cartContext, /parsed\.some\(\(item\) => "productSnapshot" in item\)/);
assert.doesNotMatch(cartContext, /item\.productSnapshot \?\?/);
assert.doesNotMatch(cartContext, /productSnapshot: product/);

assert.match(checkoutAction, /getPortalCommercialContextV2\(\)/);
assert.match(checkoutAction, /\.rpc\("create_checkout_order_v3"/);
assert.match(checkoutAction, /\.rpc\('create_checkout_order_v4'/);
assert.match(checkoutAction, /p_expected_commercial_version: input\.expectedCommercialVersion/);
assert.match(checkoutAction, /p_expected_context_token: input\.expectedContextToken/);
assert.doesNotMatch(checkoutAction, /formData\.get\("priceMode"\)/);
assert.doesNotMatch(checkoutAction, /\.from\("public_catalog_products_v1"\)/);
assert.match(checkoutView, /requestAttemptRef\.current \?\?= \{/);
assert.match(checkoutView, /Crédito comercial no disponible/);
assert.match(checkoutView, /Tu crédito no cubre el total de este pedido/);
assert.match(checkoutView, /Enviar pedido/);
assert.match(checkoutView, /getCheckoutRequestStatusAction/);
assert.match(checkoutView, /checkoutRecoveryStorageKey/);

assert.match(checkoutV4Migration, /resolve_portal_commercial_context_v2/);
assert.match(checkoutV4Migration, /create_checkout_order_v4/);
assert.match(checkoutV4Migration, /begin_checkout_request_v1/);
assert.match(checkoutV4Migration, /get_checkout_request_status_v1/);
assert.doesNotMatch(
  checkoutV4Migration.match(/create or replace function public\.create_checkout_order_v4[\s\S]*?comment on function public\.create_checkout_order_v4/)?.[0] ?? '',
  /create_checkout_order_v[123]|from public\.create_checkout_order\(/,
);

assert.doesNotMatch(crmAction, /portalLinkRoles:[^\n]*contadora/);
assert.match(crmAction, /\.rpc\("link_customer_portal_account_v2"/);
assert.match(crmAction, /p_expected_commercial_version: input\.expectedCommercialVersion/);
assert.match(crmAction, /p_evidence_reference: input\.evidenceReference/);
assert.match(crmWorkspace, /linkRequestKeyRef\.current \?\?= crypto\.randomUUID\(\)/);
assert.match(crmWorkspace, /Evidencia autenticada disponible/);

console.log("Portal commercial context structural contract: OK");
