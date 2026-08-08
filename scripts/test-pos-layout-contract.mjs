import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [shell, workspace, cart, cartCss, customer, customerCss, layout, layoutCss, fixturePage] = await Promise.all([
  readFile(new URL("../src/components/admin/admin-shell.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-cart.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-cart.module.css", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-customer-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-customer-workspace.module.css", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-layout.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-layout.module.css", import.meta.url), "utf8"),
  readFile(new URL("../src/app/pos-layout-certification-local/page.tsx", import.meta.url), "utf8"),
]);

assert.match(cart, /role="region"/);
assert.match(cart, /tabIndex=\{0\}/);
assert.match(cart, /pos-cart-header/);
assert.match(cart, /lines\.scrollTo/);
assert.match(cartCss, /max-height:\s*52dvh/);
assert.match(cartCss, /max-height:\s*clamp\(42rem, 82vh, 46rem\)/);
assert.match(cartCss, /overflow-y:\s*auto/);
assert.match(cartCss, /scrollbar-width:\s*thin/);

assert.match(workspace, /POS_WORKSPACE_GRID_CLASS/);
assert.match(workspace, /<PosCustomerWorkspace compact selectedCustomerId/);
assert.match(workspace, /Cliente listo para preparar la venta/);
assert.match(layout, /styles\.workspaceGrid/);
assert.match(layoutCss, /@media \(min-width: 1280px\)/);
assert.match(layoutCss, /@media \(min-width: 1700px\)/);
assert.match(layoutCss, /minmax\(360px, 0\.9fr\)/);
assert.match(layoutCss, /minmax\(520px, 1\.35fr\)/);

assert.match(customerCss, /container-type:\s*inline-size/);
assert.match(customerCss, /@container \(min-width: 36rem\)/);
assert.match(customerCss, /@container \(min-width: 44rem\)/);
assert.match(customer, /\[overflow-wrap:anywhere\]/);
assert.match(customer, /whitespace-nowrap font-semibold tabular-nums/);
assert.doesNotMatch(customer, /break-all/);

assert.match(shell, /data-testid=\{isWide \? "pos-admin-header"/);
assert.match(shell, /grid-cols-\[minmax\(0,1fr\)_auto\]/);
assert.match(shell, /min-h-11/);
assert.match(fixturePage, /NODE_ENV !== "development"/);
assert.match(fixturePage, /robots: \{ index: false, follow: false \}/);

console.log("POS layout source contracts: PASS");
