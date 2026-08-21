import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [migration, schema, paymentService, wizard, productAction, productSaveService, productManager, confirmationRoute, cache] = await Promise.all([
  read("supabase/migrations/202608200001_payment_effective_date_product_creation_hardening_v1.sql"),
  read("src/schemas/supplier-multi-payment.ts"),
  read("src/services/supabase/supplier-multi-payment.service.ts"),
  read("src/components/admin/supplier-multi-payment-wizard.tsx"),
  read("src/app/admin/productos/actions.ts"),
  read("src/services/product-save.service.ts"),
  read("src/components/admin/product-manager.tsx"),
  read("src/app/api/admin/productos/confirm-create/route.ts"),
  read("src/lib/product-availability-cache.ts"),
]);

const contains = (text, values, label) => values.forEach((value) =>
  assert.ok(text.includes(value), `${label}: missing ${value}`),
);

contains(migration, [
  "resolve_accounts_payable_payment_recognition_v2",
  "accounts_payable_recognized_direct_event",
  "accounts_payable_recognized_opening_balance_control",
  "accounts_payable_individual_recognition_incompatible",
  "opening_balance_entry_not_posted",
  "opening_balance_entry_reversed",
  "supplier_payment_existing_journal",
  "is_date_in_closed_accounting_period",
  "effective_payment_precedes_recognition_date",
  "save_product_catalog_v3_locked",
  "save_product_catalog_v2_locked",
  "set_product_stock_locked",
], "migration contract");
assert.ok(!migration.includes("payment_date_before_payable_recognition"), "chronology-only rejection must be removed from the payment resolver");
assert.ok(!migration.includes("La fecha del pago es anterior al reconocimiento"), "the atomic registration must not retain the chronology-only rejection");
const registerBlock = migration.slice(migration.indexOf("create or replace function public.register_supplier_multi_payment_v1"), migration.indexOf("-- Routing and worker validation"));
assert.ok(!registerBlock.includes("supplier_payment_accounting_occurred_at"), "registration must not replace the selected date with a cutover/recorded date");
assert.ok(registerBlock.includes("accounting_date := effective_date"), "the selected effective date must remain the payment accounting date");
assert.ok(!/^\s*(insert|update|delete)\s+/im.test(migration.split("create or replace function")[0]), "migration must not backfill business rows");

contains(schema + paymentService + wizard, [
  "effective_payment_date",
  "input.effective_payment_date",
  "draft.paidDate",
  "accounts_payable_ids",
  "setCheckingEligibility(true)",
], "effective-date UI contract");
assert.ok(!paymentService.includes("todayCivilDate"), "explicit payment eligibility must not depend on todayCivilDate");

contains(productAction + productSaveService, [
  "ProductSaveActionResult",
  "AUTHENTICATION_REQUIRED",
  "PERMISSION_DENIED",
  "VALIDATION_FAILED",
  "CATEGORY_INVALID",
  "DUPLICATE_PRODUCT",
  "PRODUCT_WRITE_FAILED",
  "PRODUCT_WRITE_UNCONFIRMED",
  "PRODUCT_SAVED_REFRESH_PENDING",
  "PRODUCT_SAVED_POST_SAVE_WARNING",
  "correlationId",
  "save_product_catalog_v3_locked",
  "markProductAvailabilityStale",
], "product action contract");
contains(productManager, [
  "saveExecutionGuard.tryStart()",
  "runProductCreateWithConfirmation",
  "confirmProductCreateOutcome",
  "/api/admin/productos/confirm-create",
  "try {",
  "catch {",
  "revisa la lista antes de volver a guardar",
  "saveExecutionGuard.finish()",
], "product client containment");
contains(confirmationRoute, [
  "getSessionProfile",
  "getProductCapabilities(profile).create",
  "classifyProductCreateConfirmation",
  "PRODUCT_CREATED_CONFIRMED",
  "PRODUCT_NOT_CREATED",
  "PRODUCT_CONFIRMATION_CONFLICT",
  ".from(\"products\").select(\"id, sku, slug\")",
], "read-only confirmation route");
assert.ok(!/\.(insert|update|delete|upsert|rpc)\(/.test(confirmationRoute), "confirmation route must remain read-only");
assert.ok(!productManager.includes("router.refresh()"), "a committed save must not be coupled to a fallible route refresh");
contains(cache, ["revalidateTag(tag, \"max\")"], "deferred cache invalidation");

const saveBlock = productAction.slice(
  productAction.indexOf("export async function saveProductAction"),
  productAction.indexOf("export async function setProductActiveAction"),
);
assert.ok(!saveBlock.includes("revalidateProductCatalog("), "product save must not force an immediate current-route Server Action rerender");
assert.ok(!saveBlock.includes("setProductStockLocked("), "catalog and stock must use the single transactional V3 RPC");
assert.ok(saveBlock.includes("saveProductCanonical(input)"), "the legacy action must delegate to the canonical server-only service");
assert.ok(productSaveService.includes("productId: saved.product_id"), "committed success must return the canonical product ID");

console.log("payment effective-date and product-create hardening structure: PASS");
