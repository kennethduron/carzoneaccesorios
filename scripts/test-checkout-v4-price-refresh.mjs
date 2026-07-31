import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const cart = await readFile("src/contexts/cart-context.tsx", "utf8");
const checkout = await readFile("src/components/store/checkout-view.tsx", "utf8");

assert.match(cart, /refreshCart: \(\) => void/);
assert.match(cart, /const \[cartRefreshVersion, setCartRefreshVersion\] = useState\(0\)/);
assert.match(cart, /cartRequestKey = `\$\{commercialSignature\}:\$\{productIdsKey\}:\$\{cartRefreshVersion\}`/);
assert.match(
  checkout,
  /result\.code === 'CHECKOUT_PRICE_CHANGED' \|\| result\.code === 'CHECKOUT_STOCK_CHANGED'[\s\S]+refreshCart\(\)/,
);

console.log("Checkout V4 price refresh regression passed.");
