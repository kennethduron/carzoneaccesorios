import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [shell, workspace, cart, cartCss, customer, customerCss, layout, layoutCss, fixturePage, drafts, delivery, summary, mobileBar] = await Promise.all([
  readFile(new URL("../src/components/admin/admin-shell.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-cart.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-cart.module.css", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-customer-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-customer-workspace.module.css", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-layout.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-layout.module.css", import.meta.url), "utf8"),
  readFile(new URL("../src/app/pos-layout-certification-local/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-active-drafts.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-delivery-fields.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-draft-summary.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-mobile-total-bar.tsx", import.meta.url), "utf8"),
]);

assert.match(cart, /role="region"/);
assert.match(cart, /tabIndex=\{0\}/);
assert.match(cart, /pos-cart-header/);
assert.match(cart, /lines\.scrollTo/);
assert.match(cartCss, /max-height:\s*min\(50dvh, 22rem\)/);
assert.match(cartCss, /max-height:\s*clamp\(18rem, 38vh, 21rem\)/);
assert.match(cartCss, /container-type:\s*inline-size/);
assert.match(cartCss, /overflow-y:\s*auto/);
assert.match(cartCss, /scrollbar-width:\s*thin/);

assert.match(workspace, /POS_WORKSPACE_GRID_CLASS/);
assert.match(workspace, /POS_OPERATIONAL_COLUMN_CLASS/);
assert.match(workspace, /POS_PRODUCT_COLUMN_CLASS/);
assert.match(workspace, /<PosCustomerWorkspace compact selectedCustomerId/);
assert.doesNotMatch(workspace, /min-h-(?:\[)?(?:70vh|800px)/);
assert.match(workspace, /pos-sale-toolbar/);
assert.match(workspace, /keyboardOpen/);
assert.match(layout, /styles\.workspaceGrid/);
assert.match(layout, /styles\.operationalColumn/);
assert.match(layoutCss, /@media \(min-width: 800px\)/);
assert.match(layoutCss, /@media \(min-width: 1320px\)/);
assert.match(layoutCss, /minmax\(280px, 0\.72fr\)/);
assert.match(layoutCss, /display:\s*contents/);

assert.match(customerCss, /container-type:\s*inline-size/);
assert.match(customerCss, /@container \(min-width: 36rem\)/);
assert.match(customerCss, /@container \(min-width: 44rem\)/);
assert.match(customer, /\[overflow-wrap:anywhere\]/);
assert.match(customer, /whitespace-nowrap font-semibold tabular-nums/);
assert.match(customer, /pos-commercial-details/);
assert.match(customer, /pos-credit-card/);
assert.doesNotMatch(customer, /break-all/);

assert.match(drafts, /<details/);
assert.match(delivery, /pos-delivery-disclosure/);
assert.match(delivery, /matchMedia\('\(min-width: 800px\)'\)/);
assert.match(summary, /pos-fiscal-breakdown/);
assert.match(mobileBar, /env\(safe-area-inset-bottom\)/);
assert.match(mobileBar, /min-h-14/);

assert.match(shell, /data-testid=\{isWide \? "pos-admin-header"/);
assert.match(shell, /grid-cols-\[minmax\(0,1fr\)_auto\]/);
assert.match(shell, /min-h-11/);
assert.match(fixturePage, /NODE_ENV !== "development"/);
assert.match(fixturePage, /robots: \{ index: false, follow: false \}/);

console.log("POS layout source contracts: PASS");
