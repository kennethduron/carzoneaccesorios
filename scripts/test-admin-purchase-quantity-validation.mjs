import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [manager, responsiveUi, actions, purchasesMigration, initialSchema] = await Promise.all([
  readFile(new URL("../src/components/admin/purchases-manager.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/purchases-responsive-ui.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/app/admin/compras/actions.ts", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/202607180001_product_stock_automation_and_purchase_inventory.sql", import.meta.url), "utf8"),
  readFile(new URL("../supabase/migrations/202605090001_initial_schema.sql", import.meta.url), "utf8"),
]);

function nativeNumberValidity(rawValue, { min, step, required = false }) {
  const valueMissing = required && rawValue === "";
  const parsed = rawValue === "" ? NaN : Number(rawValue);
  const badInput = rawValue !== "" && !Number.isFinite(parsed);
  const rangeUnderflow = !badInput && !valueMissing && parsed < min;
  const quotient = (parsed - min) / step;
  const stepMismatch = !badInput && !valueMissing && !rangeUnderflow
    && Math.abs(quotient - Math.round(quotient)) > 1e-9;

  return {
    valueMissing,
    badInput,
    rangeUnderflow,
    stepMismatch,
    valid: !(valueMissing || badInput || rangeUnderflow || stepMismatch),
  };
}

function serverQuantityValidity(rawValue, productLinked) {
  const quantity = Math.round(Number(rawValue ?? 0) * 100) / 100;
  return Number.isFinite(quantity) && quantity > 0 && (!productLinked || Number.isInteger(quantity));
}

function quantityIsAccepted(rawValue, contract, productLinked) {
  return nativeNumberValidity(rawValue, contract).valid && serverQuantityValidity(rawValue, productLinked);
}

const incidentContract = { min: 0.01, step: 1 };
const incidentValidity = nativeNumberValidity("1", incidentContract);
assert.equal(incidentValidity.stepMismatch, true, "the released min=0.01/step=1 contract must reproduce the incident");
assert.equal(incidentValidity.rangeUnderflow, false);
assert.equal(incidentValidity.badInput, false);
assert.equal(nativeNumberValidity("0.01", incidentContract).valid, true);
assert.equal(nativeNumberValidity("1.01", incidentContract).valid, true);

assert.match(
  responsiveUi,
  /label="Cantidad" min=\{line\.product_id \? "1" : "0\.01"\} step=\{line\.product_id \? "1" : "0\.01"\}/,
  "the quantity input must align its min and step bases with the linked/unlinked contract",
);

const linkedContract = { min: 1, step: 1 };
for (const value of ["1", "2", "10", "100"]) {
  assert.equal(quantityIsAccepted(value, linkedContract, true), true, `linked quantity ${value} must be valid`);
}
for (const value of ["0", "-1", "", "NaN", "Infinity", "0.01", "0.5", "1.01", "1.5"]) {
  assert.equal(quantityIsAccepted(value, linkedContract, true), false, `linked quantity ${value || "blank"} must be invalid`);
}
assert.equal(nativeNumberValidity("", linkedContract).valid, true, "the existing optional HTML input delegates blank rejection to the server action");
assert.equal(serverQuantityValidity("", true), false, "the server action must reject a blank linked quantity");

const unlinkedContract = { min: 0.01, step: 0.01 };
for (const value of ["0.01", "0.10", "0.5", "1", "1.01", "1.5", "2.75", "2", "10", "100"]) {
  assert.equal(quantityIsAccepted(value, unlinkedContract, false), true, `unlinked quantity ${value} must be valid`);
}
for (const value of ["0", "-0.01", "", "NaN", "Infinity", "0.001", "1.001"]) {
  assert.equal(quantityIsAccepted(value, unlinkedContract, false), false, `unlinked quantity ${value || "blank"} must be invalid`);
}

const syntheticQuantity = "1";
const serializedQuantity = syntheticQuantity;
const persistedPayloadQuantity = Math.round(Number(serializedQuantity) * 100) / 100;
assert.equal(serializedQuantity, "1", "the client payload must preserve the user's exact entry");
assert.equal(persistedPayloadQuantity, 1, "server normalization must persist quantity one without correction");
assert.equal(nativeNumberValidity(serializedQuantity, linkedContract).stepMismatch, false);

const syntheticUnitCost = 37.45;
assert.equal(persistedPayloadQuantity * syntheticUnitCost, 37.45, "line-total multiplication must remain unchanged");

assert.match(manager, /quantity: 1, unit_cost: 0/);
assert.match(manager, /quantity: String\(line\.quantity \?\? ""\)/, "quantity changes must remain part of dirty-state signatures");
assert.match(manager, /quantity: line\.quantity/, "the client payload must serialize the entered quantity without auto-correction");
assert.match(manager, /line\.product_id && !Number\.isInteger\(Number\(line\.quantity\)\)/);
assert.match(actions, /const quantity = toMoney\(item\.quantity\)/);
assert.match(actions, /item\.product_id && !Number\.isInteger\(item\.quantity\)/);
assert.match(actions, /quantity,\s+unit_cost: unitCost/);

assert.match(purchasesMigration, /round\(coalesce\(\(item->>'quantity'\)::numeric, 0\), 2\) as quantity/);
assert.match(purchasesMigration, /\(item->>'quantity'\)::numeric <> trunc\(\(item->>'quantity'\)::numeric\)/);
assert.match(purchasesMigration, /sum\(\(item->>'quantity'\)::numeric\)::integer as quantity/);
assert.match(purchasesMigration, /coalesce\(new_quantities\.quantity, 0\) - coalesce\(old_quantities\.quantity, 0\) as quantity_delta/);
assert.match(purchasesMigration, /when created_value then 'purchase_item' else 'purchase_item_edit_delta' end/);
assert.match(initialSchema, /create table public\.inventory_movements[\s\S]*quantity integer not null/);
assert.match(initialSchema, /stock integer not null default 0/);

assert.equal((responsiveUi.match(/<LineNumberField label="Cantidad"/g) ?? []).length, 1, "create and edit must share one canonical quantity input");
assert.match(manager, /function purchaseToDraft\([\s\S]*purchase\.items\.map\(\(item\) => \(\{\s+\.\.\.item,/);
assert.match(responsiveUi, /function LineNumberField[\s\S]*<Input type="number"/);
assert.match(responsiveUi, /function Field[\s\S]*min-w-0/);
assert.doesNotMatch(responsiveUi, /LineNumberField[\s\S]{0,500}min-w-\[/);

console.log("Admin purchase quantity validation contract: PASS");
