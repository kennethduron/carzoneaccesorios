import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile("src/contexts/cart-context.tsx", "utf8");

assert.doesNotMatch(
  source,
  /useState<CartItem\[\]>\(\s*readStoredCart\s*\)/,
  "Cart state must not read sessionStorage during the server/client hydration render.",
);
assert.match(
  source,
  /const \[cart, setCart\] = useState<CartItem\[\]>\(\[\]\);/,
  "Cart state must use the same empty initial value on the server and client.",
);
assert.match(
  source,
  /useEffect\(\(\) => \{\s*let cancelled = false;\s*const storedCart = readStoredCart\(\);\s*queueMicrotask\(\(\) => \{\s*if \(cancelled\) return;\s*cartRef\.current = storedCart;\s*setCart\(storedCart\);\s*\}\);/,
  "The persisted cart must be restored after hydration in a cancelable microtask.",
);

console.log("Cart hydration regression: OK");
