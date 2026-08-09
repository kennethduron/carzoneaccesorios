import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseCartQuantityDraft, validateCartQuantity } from "../src/utils/cart-quantity.ts";

for (const value of ["1", "2", "10", "50", "100", "999", "10000"]) {
  assert.equal(parseCartQuantityDraft(value), Number(value), `${value} must parse as a positive integer`);
}
for (const value of ["", " ", "0", "-1", "1.5", "abc", "10abc", "NaN", "Infinity", "999999999999999999999999"]) {
  assert.equal(parseCartQuantityDraft(value), null, `${JSON.stringify(value)} must be rejected`);
}

assert.equal(validateCartQuantity({ requestedQuantity: 8, availableStock: 8, wholesaleMinimum: 1, wholesaleMinimumApplies: false }).ok, true);
assert.equal(validateCartQuantity({ requestedQuantity: 9, availableStock: 8, wholesaleMinimum: 1, wholesaleMinimumApplies: false }).code, "STOCK_EXCEEDED");
assert.equal(validateCartQuantity({ requestedQuantity: 10001, availableStock: 20000, wholesaleMinimum: 1, wholesaleMinimumApplies: false }).code, "QUANTITY_TOO_HIGH");
assert.equal(validateCartQuantity({ requestedQuantity: 5, availableStock: 100, wholesaleMinimum: 6, wholesaleMinimumApplies: true }).code, "WHOLESALE_MINIMUM");
assert.equal(validateCartQuantity({ requestedQuantity: 6, availableStock: 100, wholesaleMinimum: 6, wholesaleMinimumApplies: true }).ok, true);
assert.equal(validateCartQuantity({ requestedQuantity: 5, availableStock: 100, wholesaleMinimum: 6, wholesaleMinimumApplies: false }).ok, true, "retail must not inherit wholesale minimum");

const context = await readFile("src/contexts/cart-context.tsx", "utf8");
const control = await readFile("src/components/store/cart-quantity-control.tsx", "utf8");
const cartView = await readFile("src/components/store/cart-view.tsx", "utf8");
assert.match(context, /const setQuantity = useCallback/);
assert.match(context, /const result = setQuantity\(productId, nextQuantity\)/, "+/- wrapper must delegate positive quantities to setQuantity");
assert.match(context, /if \(nextQuantity <= 0\)[\s\S]*commitCart/, "minus from one must preserve removal semantics");
assert.match(control, /onBlur=\{commitQuantity\}/);
assert.match(control, /event\.key === "Enter"[\s\S]*commitQuantity\(\)/);
assert.match(control, /type="text"[\s\S]*inputMode="numeric"[\s\S]*pattern="\[0-9\]\*"/);
assert.match(control, /aria-invalid=\{Boolean\(error\)\}/);
assert.match(control, /size-11/, "quantity controls must provide 44px targets");
assert.match(cartView, /CartQuantityControl/);
assert.match(cartView, /aria-label=\{`Eliminar \$\{item\.product\.name\} del carrito`\}/);

console.log("Cart direct quantity regression: OK");
