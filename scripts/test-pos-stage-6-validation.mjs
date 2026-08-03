import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { confirmPosSaleSchema } from "../src/lib/validation/pos-draft.ts";
import {
  applyPosDraftInventoryModes,
  isPosDraftItemStockInsufficient,
} from "../src/lib/pos/inventory-mode.ts";
import { effectivePermissions } from "../src/lib/auth/permissions.ts";
import { hasPosPermission } from "../src/lib/auth/pos-permissions.ts";

const cardWithSensitiveFields = confirmPosSaleSchema.safeParse({
  requestKey: crypto.randomUUID(), expectedDraftVersion: 2, invoiceDate: "2026-08-02",
  payment: {
    method: "card", verified: true, reference: "POS-STAGE6-LOCAL-ONLY-CARD",
    card_number: "4111111111111111", cvv: "123", pin: "0000",
  },
});
assert.equal(cardWithSensitiveFields.success, false);
if (!cardWithSensitiveFields.success) {
  assert.deepEqual(
    cardWithSensitiveFields.error.issues.flatMap((issue) => issue.code === "unrecognized_keys" ? issue.keys : []),
    ["card_number", "cvv", "pin"],
  );
}
const card = confirmPosSaleSchema.parse({
  requestKey: crypto.randomUUID(), expectedDraftVersion: 2, invoiceDate: "2026-08-02",
  payment: { method: "card", verified: true, reference: "POS-STAGE6-LOCAL-ONLY-CARD" },
});
assert.equal(card.payment.method, "card");
assert.equal(confirmPosSaleSchema.safeParse({
  requestKey: crypto.randomUUID(), expectedDraftVersion: 2, invoiceDate: "2026-08-02",
  payment: { method: "cash", amountTendered: -0.01 },
}).success, false);

const baseInventoryItem = {
  productId: crypto.randomUUID(), quantity: 1, availableStock: 0,
  tracksInventory: true, stockStatus: "insufficient", validationStatus: "warning",
  costFloorValidated: true,
};
assert.equal(isPosDraftItemStockInsufficient(baseInventoryItem), true);
const serviceDraft = applyPosDraftInventoryModes({
  items: [baseInventoryItem],
  validationStatus: "warning",
  validationMessages: [{ code: "DRAFT_REVALIDATION_REQUIRED", message: "stock" }],
}, new Map([[baseInventoryItem.productId, false]]));
assert.equal(serviceDraft.items[0].tracksInventory, false);
assert.equal(serviceDraft.items[0].stockStatus, "available");
assert.equal(serviceDraft.items[0].validationStatus, "valid");
assert.equal(serviceDraft.validationStatus, "valid");
assert.deepEqual(serviceDraft.validationMessages, []);
assert.equal(isPosDraftItemStockInsufficient(serviceDraft.items[0]), false);
const noCostService = applyPosDraftInventoryModes({
  items: [{ ...baseInventoryItem, costFloorValidated: false }],
  validationStatus: "warning",
  validationMessages: [{ code: "DRAFT_REVALIDATION_REQUIRED", message: "cost" }],
}, new Map([[baseInventoryItem.productId, false]]));
assert.equal(noCostService.items[0].validationStatus, "warning");
assert.equal(noCostService.validationStatus, "warning");
for (const role of ["technical_owner", "business_owner", "admin"]) {
  const permissions = effectivePermissions(role);
  assert.equal(permissions.includes("pos:confirm_sale"), true, `${role} confirmation permission`);
  assert.equal(permissions.includes("pos:reprint_documents"), true, `${role} reprint permission`);
  assert.equal(hasPosPermission({ role, permissions }, "pos:confirm_sale"), true);
}
for (const role of ["contadora", "vendedor", "bodega", "soporte", "cliente"]) {
  const permissions = effectivePermissions(role);
  assert.equal(hasPosPermission({ role, permissions }, "pos:confirm_sale"), false);
}
assert.equal(confirmPosSaleSchema.safeParse({
  requestKey: crypto.randomUUID(), expectedDraftVersion: 2, invoiceDate: "2026-08-02",
  payment: { method: "bank_transfer", verified: true, reference: "" },
}).success, false);

const [migration, route, service, guard, baseline, localTest] = await Promise.all([
  readFile(new URL("../supabase/migrations/202608020002_pos_stage_5_atomic_sale_confirmation.sql", import.meta.url), "utf8"),
  readFile(new URL("../src/app/api/admin/pos/drafts/[draftId]/confirm/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/services/supabase/pos-draft.service.ts", import.meta.url), "utf8"),
  readFile(new URL("./pos-stage-6-local-guard.mjs", import.meta.url), "utf8"),
  readFile(new URL("./pos-stage-6-baseline.mjs", import.meta.url), "utf8"),
  readFile(new URL("./test-pos-stage-6-local.mjs", import.meta.url), "utf8"),
]);
assert.match(migration, /pg_advisory_xact_lock/);
assert.match(migration, /order by products\.id for update/i);
assert.match(migration, /POS_CREDIT_INSUFFICIENT/);
assert.match(migration, /pos\.sale\.confirmed/);
assert.match(migration, /set search_path = public, extensions, pg_temp/);
assert.doesNotMatch(migration, /card_credit|card_debit|card_number|\bcvv\b|\bpin\b/i);
assert.match(route, /authorizePosCustomerRequest\("pos:confirm_sale"\)/);
assert.match(route, /recoverPosSaleConfirmation/);
assert.match(service, /recover_pos_sale_confirmation_v1/);
assert.match(guard, /mbowrapstbufzzfefipn/);
assert.match(guard, /127\\\.0\\\.0\\\.1\|localhost/);
assert.match(guard, /current_database\(\), current_user, inet_server_addr\(\), inet_server_port\(\)/);
assert.match(baseline, /prefixCounts/);
assert.match(localTest, /POS_CREDIT_INSUFFICIENT/);
assert.match(localTest, /bank_transfer/);
assert.match(localTest, /method: "card"/);
assert.match(localTest, /recover_pos_sale_confirmation_v1/);

console.log("POS Stage 6 application hardening validation: PASS");
