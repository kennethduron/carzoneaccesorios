import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const cartSource = await readFile("src/contexts/cart-context.tsx", "utf8");
const checkoutSource = await readFile("src/components/store/checkout-view.tsx", "utf8");

assert.match(cartSource, /const \[cart, setCart\] = useState<CartItem\[]>\(\[\]\)/);
assert.match(cartSource, /const cartRef = useRef<CartItem\[]>\(\[\]\)/);
assert.match(cartSource, /const commitCart = useCallback/);
assert.match(cartSource, /const clearCart = useCallback/);
assert.doesNotMatch(cartSource, /setCart\(\(current\) =>[\s\S]{0,1400}toast\./);
assert.match(
  checkoutSource,
  /\[accountInfo\.checkoutV4Enabled, clearCart, confirmation\]/,
);

console.log("Cart confirmation stability regression passed.");
