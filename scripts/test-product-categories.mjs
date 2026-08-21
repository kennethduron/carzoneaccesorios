import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getOfficialProductCategory,
  normalizeImportedProductCategoryName,
  normalizeProductCategorySlug,
  officialProductCategories,
  sortOfficialProductCategories,
} from "../src/lib/product-categories.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const expectedCategories = [
  ["Exterior", "exterior"],
  ["Interior", "interior"],
  ["Iluminación", "iluminacion"],
  ["Polarizado y Herramientas", "polarizado-y-herramientas"],
  ["Carrocería", "carroceria"],
  ["Seguridad", "seguridad"],
  ["Audio y Sonido", "audio-y-sonido"],
];

assert.deepEqual(
  officialProductCategories.map(({ name, slug }) => [name, slug]),
  expectedCategories,
  "the seven official categories must keep the requested order",
);

const legacyMappings = [
  ["Audio", "Audio y Sonido", "audio-y-sonido"],
  ["Herramientas", "Polarizado y Herramientas", "polarizado-y-herramientas"],
  ["Luces", "Iluminación", "iluminacion"],
  ["Tecnología", "Interior", "interior"],
  ["Tecnologia", "Interior", "interior"],
];

for (const [legacy, expectedName, expectedSlug] of legacyMappings) {
  assert.equal(normalizeImportedProductCategoryName(legacy), expectedName, `${legacy} import normalization`);
  assert.equal(normalizeProductCategorySlug(legacy), expectedSlug, `${legacy} URL compatibility`);
}

assert.equal(normalizeImportedProductCategoryName(""), null, "empty category is never commercial");
assert.equal(normalizeImportedProductCategoryName("Sin categoría"), null, "placeholder is never commercial");
assert.equal(normalizeImportedProductCategoryName("Categoría desconocida"), null, "unknown category is rejected");
assert.equal(getOfficialProductCategory("Iluminacion")?.name, "Iluminación", "accentless historical spelling is tolerated");

const shuffled = [
  { id: "security", name: "Seguridad", slug: "seguridad" },
  { id: "legacy", name: "Audio", slug: "audio" },
  { id: "exterior", name: "Exterior", slug: "exterior" },
  { id: "audio", name: "Audio y Sonido", slug: "audio-y-sonido" },
];
assert.deepEqual(
  sortOfficialProductCategories(shuffled).map((category) => category.id),
  ["exterior", "security", "audio"],
  "options are official-only and ordered",
);

const manager = read("src/components/admin/product-manager.tsx");
const productSaveService = read("src/services/product-save.service.ts");
const adminService = read("src/services/supabase/admin-products.service.ts");
const adminInventoryService = read("src/services/supabase/admin-inventory.service.ts");
const publicService = read("src/services/supabase/products.service.ts");
const homePage = read("src/app/page.tsx");
const categoriesPage = read("src/app/categorias/page.tsx");
const productPage = read("src/app/producto/[slug]/page.tsx");
const proxy = read("src/proxy.ts");
const seed = read("supabase/seed/seed.sql");
const migration = read("supabase/migrations/202607190001_official_product_categories.sql");

assert.match(manager, /<option value="">Sin categoría<\/option>/, "placeholder remains visible");
assert.match(manager, /required\s+aria-invalid=\{categoryMissing\}/, "selector has client constraint");
assert.match(manager, /Selecciona una categoría para guardar el producto\./, "client validation message");
assert.match(manager, /normalizeImportedProductCategoryName\(product\.category_name\) \?\? ""/, "exports normalize official names");
assert.match(manager, /findImportedCategory\(categories, categoryName\)/, "Excel imports normalize historical names");
assert.match(manager, /allowBlank: false/, "Excel category list is mandatory");
assert.match(manager, /officialProductCategories\.map\(\(category\) => category\.name\)/, "Excel uses the official list");

assert.match(productSaveService, /if \(!categoryId\)/, "server rejects empty category");
assert.match(productSaveService, /isOfficialProductCategory\(category\)/, "server rejects non-official category IDs");
assert.match(productSaveService, /\.from\("categories"\)/, "server verifies the referenced category");

assert.match(adminService, /officialProductCategories\.map\(\(category\) => category\.slug\)/, "admin options are official-only");
assert.match(adminService, /sortOfficialProductCategories/, "admin options keep official order");
assert.match(adminService, /category_id\.in\.\(\$\{matchingCategoryIds\.join\(","\)\}\)/, "admin search includes category matches");
assert.match(adminInventoryService, /normalizeImportedProductCategoryName\(categoryName\)/, "inventory displays canonical category names");
assert.match(publicService, /sortOfficialProductCategories/, "public options keep official order");
assert.match(publicService, /normalizeProductCategorySlug\(category\)/, "public filters accept historical slugs");
assert.match(publicService, /catalog-active-categories-official-v2/, "category cache key was invalidated");
assert.match(proxy, /NextResponse\.redirect\(canonicalUrl, 308\)/, "historical category URLs receive a permanent redirect");
assert.match(proxy, /canonicalUrl\.searchParams\.set\("categoria", canonicalCategory\)/, "redirect preserves other query parameters");
assert.match(proxy, /matcher: \["\/catalogo"/, "catalog redirects run before rendering");
assert.match(productPage, /getOfficialProductCategory\(product\.category\)/, "SEO only emits official categories");

for (const source of [homePage, categoriesPage]) {
  assert.doesNotMatch(source, /^\s*(audio|herramientas|luces|tecnologia):/m, "legacy presentation key remains");
}

const seedCategoryBlock = seed.match(/insert into public\.categories[\s\S]*?on conflict \(slug\)/)?.[0] ?? "";
for (const [name, slug] of expectedCategories) {
  assert.match(seedCategoryBlock, new RegExp(`'${name}', '${slug}'`), `seed missing ${name}`);
}
assert.doesNotMatch(seedCategoryBlock, /\('(?:Audio|Herramientas|Luces|Tecnologia|Tecnología)'/, "seed exposes a legacy category");

for (const [legacy, expectedName] of legacyMappings.slice(0, 4)) {
  assert.match(migration, new RegExp(`'${legacy.replace("í", "[ií]")}'`), `migration missing ${legacy}`);
  assert.match(migration, new RegExp(`'${expectedName}'`), `migration missing ${expectedName}`);
}
assert.match(migration, /before insert or update of category_id/, "database validates inserts and category edits");
assert.match(migration, /if new\.category_id is null/, "database rejects empty categories");
assert.match(migration, /Existing null categories remain compatible with stock-only updates/, "legacy null records remain inventory-compatible");

const productUpdates = [...migration.matchAll(/update public\.products\s+set([\s\S]*?)where/g)].map((match) => match[1]);
assert.equal(productUpdates.length, 1, "migration has one deterministic product update statement");
assert.match(productUpdates[0], /category_id = chosen_id/, "migration updates only the category reference");
assert.doesNotMatch(
  productUpdates[0],
  /\b(stock|reserved_stock|cost_price|retail_price|wholesale_price|active|status|slug|sku|name)\b/,
  "migration must not modify commercial, inventory, URL, or state fields",
);

console.log("PRODUCT_CATEGORIES_PASS");
