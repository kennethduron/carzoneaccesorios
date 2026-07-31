import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const actions = await readFile("src/app/checkout/actions.ts", "utf8");
const view = await readFile("src/components/store/checkout-view.tsx", "utf8");

assert.match(
  actions,
  /input\.expectedPriceMode === "wholesale" && !user[\s\S]+code: 'CHECKOUT_SESSION_REQUIRED'/,
);
assert.match(actions, /message: checkoutV4Message\('CHECKOUT_SESSION_REQUIRED'\)/);
assert.match(
  view,
  /if \(result\.code === 'CHECKOUT_SESSION_REQUIRED'\)[\s\S]+removeItem\(checkoutRecoveryStorageKey\)/,
);
assert.doesNotMatch(
  view,
  /result\.code === 'CHECKOUT_STOCK_CHANGED' \|\|\s*result\.code === 'CHECKOUT_SESSION_REQUIRED'/,
);
assert.match(view, /Iniciar sesión nuevamente/);
assert.match(view, /href="\/login\?next=%2Fcheckout"/);

console.log("Checkout V4 session-lost UI regression passed.");
