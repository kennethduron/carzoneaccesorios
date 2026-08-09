import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  resolvePosCustomerDeliveryAddress,
  resolvePosCustomerSelectionDeliveryAddress,
  shouldPrefillPosCustomerDeliveryAddress,
} from "../src/lib/pos/customer-delivery-address.ts";

const customerA = { customerId: "customer-a", address: "  Col. Trejo, 5 calle  ", city: "San Pedro Sula" };
const customerOnlyCity = { customerId: "customer-city", address: null, city: "  Tegucigalpa  " };
const customerEmpty = { customerId: "customer-empty", address: null, city: null };

assert.equal(resolvePosCustomerDeliveryAddress(customerA), "Col. Trejo, 5 calle", "address has priority over city");
assert.equal(resolvePosCustomerDeliveryAddress(customerOnlyCity), "Tegucigalpa", "city is the visual fallback");
assert.equal(resolvePosCustomerDeliveryAddress(customerEmpty), "", "missing location stays empty");
assert.equal(resolvePosCustomerDeliveryAddress({ address: "   ", city: "  El Progreso  " }), "El Progreso");

assert.equal(shouldPrefillPosCustomerDeliveryAddress(null, customerA.customerId, false), true, "new customer prepopulates");
assert.equal(shouldPrefillPosCustomerDeliveryAddress(customerA.customerId, customerA.customerId, false), false, "same-customer rerender preserves manual override");
assert.equal(shouldPrefillPosCustomerDeliveryAddress(customerA.customerId, customerOnlyCity.customerId, false), true, "A to B replaces the address");
assert.equal(shouldPrefillPosCustomerDeliveryAddress(customerA.customerId, customerEmpty.customerId, false), true, "A to empty B clears the address");
assert.equal(shouldPrefillPosCustomerDeliveryAddress(customerA.customerId, customerA.customerId, true), false, "restored draft preserves its address");

assert.equal(resolvePosCustomerSelectionDeliveryAddress({ currentAddress: "", currentCustomerId: null, nextCustomer: customerA, hasDraft: false }), "Col. Trejo, 5 calle");
assert.equal(resolvePosCustomerSelectionDeliveryAddress({ currentAddress: "Dirección manual", currentCustomerId: customerA.customerId, nextCustomer: customerA, hasDraft: false }), "Dirección manual", "rerender preserves manual override");
assert.equal(resolvePosCustomerSelectionDeliveryAddress({ currentAddress: "Dirección A", currentCustomerId: customerA.customerId, nextCustomer: customerOnlyCity, hasDraft: false }), "Tegucigalpa", "A to city-only B replaces A");
assert.equal(resolvePosCustomerSelectionDeliveryAddress({ currentAddress: "Dirección A", currentCustomerId: customerA.customerId, nextCustomer: customerEmpty, hasDraft: false }), "", "A to empty B clears A");
assert.equal(resolvePosCustomerSelectionDeliveryAddress({ currentAddress: "Dirección guardada en draft", currentCustomerId: customerA.customerId, nextCustomer: customerA, hasDraft: true }), "Dirección guardada en draft");

const [workspace, delivery, visualFixture, browserTest] = await Promise.all([
  readFile(new URL("../src/components/admin/pos-workspace.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-delivery-fields.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/pos-layout-certification.tsx", import.meta.url), "utf8"),
  readFile(new URL("./test-pos-layout-browser.mjs", import.meta.url), "utf8"),
]);

assert.match(workspace, /resolvePosCustomerSelectionDeliveryAddress\(\{/);
assert.match(workspace, /setDelivery\(draftDelivery\(next\)\)/, "restored drafts remain authoritative");
assert.match(workspace, /setDelivery\(\{ \.\.\.draftDelivery\(created\), address \}\)/, "new draft keeps the selected customer prefill");
assert.doesNotMatch(workspace, /useEffect\([\s\S]{0,250}resolvePosCustomerDeliveryAddress/, "prefill is not driven by an effect");
assert.doesNotMatch(workspace, /method:\s*["'](?:PUT|PATCH)["'][\s\S]{0,200}customers/, "workspace performs no customer writeback");
assert.match(delivery, /autoComplete="shipping street-address"/);
assert.match(delivery, /maxLength=\{500\}/);
assert.match(visualFixture, /select-customer-city/);
assert.match(visualFixture, /select-customer-empty/);
assert.match(browserTest, /refetch lógico del mismo cliente conserva override manual/);
assert.match(browserTest, /dirección de 500 caracteres no causa overflow global/);

console.log("POS customer address prefill, fallback, transitions, draft precedence and accessibility: PASS");
