import assert from "node:assert/strict";
import { createPosDraftSchema, posProductSearchSchema, savePosDraftSchema } from "../src/lib/validation/pos-draft.ts";
import { productTaxCategorySchema } from "../src/lib/validation/product-tax.ts";

const id = "11111111-1111-4111-8111-111111111111";
assert.equal(createPosDraftSchema.safeParse({ requestKey: id, customerId: id }).success, true);
assert.equal(createPosDraftSchema.safeParse({ requestKey: id, customerId: id, actor: id }).success, false);

const save = { requestKey: id, expectedVersion: 1, customerId: id, expectedCustomerCommercialVersion: 0, items: [{ productId: id, quantity: 1, finalUnitPrice: null, priceOverrideReason: null, expectedProductSalesVersion: 1 }], deliveryMode: "store_immediate", deliveryAddress: null, deliveryNotes: null, internalNotes: null, shippingFee: 0, codFee: 0, additionalCharge: 0, additionalChargeDescription: null, otherCharge: 0, otherChargeDescription: null };
assert.equal(savePosDraftSchema.safeParse(save).success, true);
assert.equal(savePosDraftSchema.safeParse({ ...save, items: [{ ...save.items[0], finalUnitPrice: 0 }] }).success, false);
assert.equal(savePosDraftSchema.safeParse({ ...save, items: [{ ...save.items[0], quantity: 10000 }] }).success, false);
assert.equal(savePosDraftSchema.safeParse({ ...save, shippingFee: -0.01 }).success, false);
assert.equal(savePosDraftSchema.safeParse({ ...save, shippingFee: 0.29 }).success, true);
assert.equal(savePosDraftSchema.safeParse({ ...save, additionalCharge: 0.001 }).success, false);
assert.equal(savePosDraftSchema.safeParse({ ...save, otherCharge: Number.NaN }).success, false);

assert.equal(posProductSearchSchema.safeParse({ query: "  radio  android ", customerId: id, expectedCustomerCommercialVersion: "2", includeUnavailable: "false", limit: "25", offset: "0" }).success, true);
assert.equal(posProductSearchSchema.safeParse({ query: "radio", customerId: id, expectedCustomerCommercialVersion: "0", includeUnavailable: "true", limit: "25", offset: "0" }).success, true);
assert.equal(posProductSearchSchema.safeParse({ query: "radio", customerId: "not-a-uuid", expectedCustomerCommercialVersion: "2", includeUnavailable: "true", limit: "25", offset: "0" }).success, false);
assert.equal(productTaxCategorySchema.safeParse("standard").success, true);
assert.equal(productTaxCategorySchema.safeParse("exempt").success, true);
assert.equal(productTaxCategorySchema.safeParse("unknown").success, false);

console.log("POS Stage 4 Zod contracts: OK");
