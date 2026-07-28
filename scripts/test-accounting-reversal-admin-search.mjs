import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const files = {
  migration: "supabase/migrations/202607270001_accounting_reversals_and_admin_search.sql",
  reports: "src/services/supabase/accounting-reports.service.ts",
  accountingUi: "src/components/admin/accounting-manager.tsx",
  publicProducts: "src/services/supabase/products.service.ts",
  checkout: "src/app/checkout/actions.ts",
  purchasesPage: "src/app/admin/compras/page.tsx",
  purchasesUi: "src/components/admin/purchases-manager.tsx",
  inventoryPage: "src/app/admin/inventario/page.tsx",
  purchaseSearchRoute: "src/app/api/admin/purchases/products/search/route.ts",
  inventorySearchRoute: "src/app/api/admin/inventory/products/search/route.ts",
  purchaseProductSearch: "src/components/admin/purchase-product-combobox.tsx",
  sharedSearch: "src/components/admin/async-search-combobox.tsx",
};

const source = Object.fromEntries(await Promise.all(
  Object.entries(files).map(async ([key, file]) => [key, await readFile(file, "utf8")]),
));

assert.match(source.migration, /entries\.status in \('publicada', 'reversada'\)/);
assert.match(source.reports, /accountedJournalEntryStatuses = \["publicada", "reversada"\]/);
assert.match(source.reports, /\.in\("journal_entries\.status", \[\.\.\.accountedJournalEntryStatuses\]\)/);

assert.match(source.migration, /for update;/);
assert.match(source.migration, /source_type = 'journal_reversal'/);
assert.match(source.migration, /entry_kind', ''\) = 'reversal'/);
assert.match(source.migration, /char_length\(normalized_reason\) < 10/);
assert.match(source.migration, /reversal_reason/);
assert.match(source.accountingUi, /!isReversalEntry\(entry\)/);
assert.match(source.accountingUi, /Motivo de la reversión/);

const publicView = source.migration.match(/create view public\.public_catalog_products_v1[\s\S]*?from public\.products[\s\S]*?;/)?.[0] ?? "";
assert.ok(publicView, "Debe existir el contrato público de productos.");
assert.doesNotMatch(publicView, /cost_price/);
assert.match(source.migration, /revoke select on public\.products from anon, authenticated/);
assert.match(source.migration, /search_purchase_products_v1/);
assert.match(source.migration, /has_permission\('purchases:read'\)/);
const publicImageView = source.migration.match(/create view public\.public_catalog_product_images_v1[\s\S]*?from public\.product_images[\s\S]*?;/)?.[0] ?? "";
assert.ok(publicImageView, "Debe existir el contrato publico de imagenes de productos.");
assert.doesNotMatch(publicImageView, /cost_price/);
assert.match(source.publicProducts, /\.from\("public_catalog_product_images_v1"\)/);
assert.match(source.migration, /has_permission\('inventory:read'\)/);
assert.match(source.migration, /search_accounting_accounts_v1/);

assert.doesNotMatch(source.publicProducts, /\.from\("products"\)/);
assert.match(source.publicProducts, /\.from\("public_catalog_products_v1"\)/);
const checkoutProductValidation = source.checkout.slice(
  source.checkout.indexOf("const productIds ="),
  source.checkout.indexOf("const availableProductIds ="),
);
assert.match(checkoutProductValidation, /\.from\("public_catalog_products_v1"\)/);
assert.doesNotMatch(checkoutProductValidation, /\.from\("products"\)/);
assert.doesNotMatch(source.purchasesPage, /getPurchaseProductOptions/);
assert.doesNotMatch(source.purchasesUi, /products\.map\(\(product\).*<option/);
assert.doesNotMatch(source.inventoryPage, /productOptions=/);

assert.match(source.purchaseSearchRoute, /p_include_inactive: true/);
assert.match(source.inventorySearchRoute, /p_include_inactive: true/);
assert.match(source.purchaseProductSearch, /Producto inactivo/);
assert.match(source.sharedSearch, /pr-24/);
assert.equal(
  [...source.sharedSearch.matchAll(/size-11/g)].length >= 2,
  true,
);
console.log("Accounting reversal, public product contract, and administrative search structure: OK");
