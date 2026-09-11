import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { adminPriceViewCookieName, canUseAdminPriceView, isAdminPriceViewMode, normalizeAdminPriceViewProductIds } from "../src/lib/admin-price-view.ts";
import { resolveAdminDisplayPrice } from "../src/utils/admin-price-view.ts";

const userA = "11111111-1111-4111-8111-111111111111";
const userB = "22222222-2222-4222-8222-222222222222";
const productA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const productB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

for (const role of ["technical_owner", "business_owner", "admin"]) {
  assert.equal(canUseAdminPriceView(role), true, role + " must be eligible");
}
for (const role of ["vendedor", "bodega", "contadora", "soporte", "cliente", null, undefined]) {
  assert.equal(canUseAdminPriceView(role), false, String(role) + " must be ineligible");
}

assert.equal(isAdminPriceViewMode("retail"), true);
assert.equal(isAdminPriceViewMode("wholesale"), true);
assert.equal(isAdminPriceViewMode("customer_wholesale"), false);
assert.notEqual(adminPriceViewCookieName(userA), adminPriceViewCookieName(userB));
assert.match(adminPriceViewCookieName(userA), new RegExp(userA + "$"));
assert.throws(() => adminPriceViewCookieName("not-a-user"));

assert.deepEqual(normalizeAdminPriceViewProductIds([productA, productA.toUpperCase(), productB]), [productA, productB]);
assert.throws(() => normalizeAdminPriceViewProductIds(["not-a-product"]));
assert.throws(() => normalizeAdminPriceViewProductIds(Array.from({ length: 49 }, () => productA)));

assert.deepEqual(
  resolveAdminDisplayPrice({
    eligible: false,
    mode: "wholesale",
    retailPrice: 120,
    commercialPrice: 93,
    adminWholesalePrice: 80,
  }),
  { price: 93, kind: "commercial" },
);
assert.deepEqual(
  resolveAdminDisplayPrice({
    eligible: true,
    mode: "retail",
    retailPrice: 120,
    commercialPrice: 93,
    adminWholesalePrice: 80,
  }),
  { price: 120, kind: "admin-retail" },
);
assert.deepEqual(
  resolveAdminDisplayPrice({
    eligible: true,
    mode: "wholesale",
    retailPrice: 120,
    commercialPrice: 120,
    adminWholesalePrice: 80,
  }),
  { price: 80, kind: "admin-wholesale" },
);
for (const invalidPrice of [null, 0, -1, 121, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.deepEqual(
    resolveAdminDisplayPrice({
      eligible: true,
      mode: "wholesale",
      retailPrice: 120,
      commercialPrice: 93,
      adminWholesalePrice: invalidPrice,
    }),
    { price: 120, kind: "admin-fallback" },
  );
}

const source = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const action = source("src/app/actions/admin-price-view.ts");
const service = source("src/services/supabase/admin-price-view.service.ts");
const provider = source("src/contexts/admin-price-view-context.tsx");
const selector = source("src/components/store/admin-price-view-selector.tsx");
const card = source("src/components/store/catalog-product-card.tsx");
const detail = source("src/components/store/product-detail.tsx");
const layout = source("src/app/layout.tsx");

assert.match(action, /getAdminPriceViewActor/);
assert.ok(action.indexOf("getAdminPriceViewActor") < action.indexOf("cookieStore.set"));
assert.match(action, /httpOnly:\s*true/);
assert.match(action, /sameSite:\s*"lax"/);
assert.match(action, /adminPriceViewCookieName\(actor\.userId\)/);
assert.doesNotMatch(action + service, /getSupabaseAdminClient|service[_-]role|unstable_cache/i);
assert.match(service, /\.from\("products"\)/);
assert.match(service, /\.in\("id", ids\)/);
assert.match(service, /getAdminPriceViewActor/);
assert.match(provider, /setCurrentMode\(previousMode\)/);
assert.match(provider, /router\.refresh\(\)/);
assert.match(provider, /finally[\s\S]*setPendingMode\(null\)/);
assert.match(selector, /Detalle/);
assert.match(selector, /Mayorista/);
assert.match(selector, /pendingMode !== null/);
assert.match(card, /resolveAdminDisplayPrice/);
assert.match(detail, /formatCurrency\(commercialPrice\)/);
assert.match(detail, /no cambia carrito, checkout ni condiciones comerciales/);
assert.match(layout, /initialAdminPriceView/);

const protectedContracts = [
  "src/contexts/price-mode-context.tsx",
  "src/contexts/cart-context.tsx",
  "src/app/checkout/actions.ts",
  "src/app/checkout/checkout-view.tsx",
  "src/services/supabase/portal-commercial-context.service.ts",
  "src/services/supabase/products.service.ts",
  "src/utils/pricing.ts",
  "src/types/commerce.ts",
  "src/services/supabase/pos-draft.service.ts",
];
const contractDiff = execFileSync("git", ["diff", "--", ...protectedContracts], { encoding: "utf8" });
assert.equal(contractDiff, "", "commercial and transactional contracts must remain unchanged");

console.log("admin price view targeted tests: PASS");
