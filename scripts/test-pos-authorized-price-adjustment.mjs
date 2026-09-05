import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// Execute the actual JSX event handlers, including the parent callback that
// caused the regression. Do not duplicate the price update in a test model.
function handler(path, component, prop, bindings) {
  const source = readFileSync(path, 'utf8');
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) {
    if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && node.tagName.getText(tree) === component) {
      expression = node.attributes.properties.find((attribute) => attribute.name?.getText(tree) === prop)?.initializer?.expression;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, `${component}.${prop} exists`);
  const code = ts.transpile(`const callback = ${expression.getText(tree)};`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(bindings), `${code}; return callback;`)(...Object.values(bindings));
}
const workspace = 'src/components/admin/pos-workspace.tsx';
const cart = 'src/components/admin/pos-cart.tsx';
const baseline = process.argv.includes('--expect-before');
for (const sellerMode of [false, true]) {
  let items = [{ productId: 'fixture', baseUnitPrice: 5500, finalUnitPrice: 5500, priceOverridden: false, priceOverrideReason: null, quantity: 3 }];
  let requests = { fixture: { status: 'approved', requestedUnitPrice: 5000 } };
  const onChange = handler(workspace, 'PosCart', 'onChange', {
    sellerMode, setPriceRequests: (next) => { requests = next; }, markItems: (next) => { items = next; },
  });
  let editing = items[0];
  const onApply = handler(cart, 'PriceOverrideDialog', 'onApply', {
    editing, update: (id, patch) => onChange(items.map((item) => item.productId === id ? { ...item, ...patch } : item)),
    setEditing: (next) => { editing = next; },
  });
  onApply(5000, 'Precio autorizado por propietario');
  assert.equal(editing, null, 'modal closes');
  assert.deepEqual(requests, {}, 'cart edits invalidate quantity-bound seller requests');
  const expected = sellerMode || baseline ? 5500 : 5000;
  assert.equal(items[0].finalUnitPrice, expected);
  assert.equal(items[0].quantity * items[0].finalUnitPrice, expected * 3);
  if (!sellerMode) console.log(`Reproduction ${baseline ? 'BEFORE' : 'AFTER'}: unit=${expected}, quantity=3, merchandise=${expected * 3}`);
  if (baseline) continue;
  for (const quantity of [2, 1, 3]) {
    onChange(items.map((item) => ({ ...item, quantity })));
    assert.equal(items[0].finalUnitPrice, expected);
    assert.equal(items[0].quantity * items[0].finalUnitPrice, expected * quantity);
  }
  assert.equal(items[0].baseUnitPrice, 5500, 'catalog snapshot is untouched');
  assert.equal(items[0].priceOverridden, !sellerMode);
  assert.equal(sellerMode ? items[0].priceOverrideReason : items[0].priceOverrideReason.length > 5, sellerMode ? null : true);
}
console.log('Actual modal → workspace callback / quantity / seller separation: PASS');

const dialog = readFileSync('src/components/admin/price-override-dialog.tsx', 'utf8');
const validation = dialog.match(/const numericPrice = ([\s\S]*?);\s*const valid = ([\s\S]*?);/);
assert.ok(validation);
const valid = new Function('price', 'reason', `const numericPrice = ${validation[1]}; return ${validation[2]};`);
for (const value of ['', 'abc', '0', '-1', 'Infinity']) assert.equal(valid(value, 'Valid reason'), false, value);
for (const value of ['5000', '5500', '6000', '5000.129', '1000000000000000']) assert.equal(valid(value, 'Valid reason'), true, value);
assert.equal(valid('5000', 'abc'), false);
console.log('Existing modal validation: PASS (precision and maximum validated/normalized by database)');
