import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifySameOriginRequest } from "../src/lib/http/same-origin-request.ts";
import { updateProductViaHttpApi } from "../src/lib/product-update-http.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const manager = read("src/components/admin/product-manager.tsx");
const updateRoute = read("src/app/api/admin/productos/update/route.ts");
const createRoute = read("src/app/api/admin/productos/create/route.ts");
const actions = read("src/app/admin/productos/actions.ts");
const service = read("src/services/product-save.service.ts");
const permissions = read("src/lib/auth/permissions.ts");
const catalogMigration = read("supabase/migrations/202607150001_granular_product_permissions.sql");
const skuGuardMigration = read("supabase/migrations/202608080004_product_catalog_consistency_and_sku_guards.sql");

const requestId = "11111111-1111-4111-8111-111111111111";
const product = {
  id: "22222222-2222-4222-8222-222222222222",
  category_id: "33333333-3333-4333-8333-333333333333",
  sku: "EDITED-SKU",
  internal_code: null,
  slug: "stable-product-slug",
  name: "Existing product",
  brand: "Fixture",
  vehicle_brand: "Toyota",
  vehicle_model: "Hilux",
  vehicle_year_start: 2016,
  vehicle_year_end: 2025,
  short_description: null,
  description: "",
  features: null,
  specifications: null,
  compatibility_notes: "Keep linked compatibility",
  stock: 7,
  min_stock: 1,
  cost_price: 10,
  retail_price: 20,
  wholesale_price: 15,
  wholesale_min_quantity: 1,
  tax_category: "standard",
  tracks_inventory: true,
  is_new: false,
  status: "active",
  active: true,
  images: [],
};
const updated = {
  ok: true,
  code: "PRODUCT_UPDATED",
  message: "Producto actualizado correctamente.",
  productId: product.id,
  slug: product.slug,
  correlationId: requestId,
};

let observedRequest;
assert.deepEqual(
  await updateProductViaHttpApi(product, requestId, {
    fetchImpl: async (url, init) => {
      observedRequest = { url, init };
      return Response.json(updated);
    },
  }),
  updated,
);
assert.equal(observedRequest.url, "/api/admin/productos/update");
assert.equal(observedRequest.init.method, "PUT");
assert.equal(observedRequest.init.credentials, "same-origin");
assert.equal(observedRequest.init.cache, "no-store");
assert.equal(observedRequest.init.headers["X-Request-ID"], requestId);
assert.deepEqual(JSON.parse(observedRequest.init.body), { requestId, product });

const duplicate = {
  ok: false,
  code: "DUPLICATE_PRODUCT",
  message: "El SKU ya está usado por otro producto. Usa un SKU diferente.",
  correlationId: requestId,
  stage: "database_write",
};
assert.deepEqual(
  await updateProductViaHttpApi(product, requestId, {
    fetchImpl: async () => Response.json(duplicate, { status: 409 }),
  }),
  duplicate,
  "duplicate SKU must remain a scoped form failure",
);

await assert.rejects(
  updateProductViaHttpApi(product, requestId, {
    fetchImpl: async () => Response.json({ ...updated, productId: "44444444-4444-4444-8444-444444444444" }),
  }),
  /INVALID_PRODUCT_UPDATE_RESPONSE/,
  "an update response must preserve the same product identity",
);
await assert.rejects(
  updateProductViaHttpApi(product, requestId, {
    fetchImpl: async () => Response.json({ ...updated, code: "PRODUCT_CREATED" }),
  }),
  /INVALID_PRODUCT_UPDATE_RESPONSE/,
  "the update transport must never accept a create result",
);
await assert.rejects(
  updateProductViaHttpApi(product, requestId, {
    timeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
  }),
  (error) => error instanceof DOMException && error.name === "AbortError",
  "the update request must have a bounded timeout",
);

const serverActionUnavailable = async () => { throw new Error("sharp native module unavailable"); };
await assert.rejects(serverActionUnavailable, /sharp native module unavailable/);
assert.deepEqual(
  await updateProductViaHttpApi(product, requestId, { fetchImpl: async () => Response.json(updated) }),
  updated,
  "HTTP update must remain available when Server Action dispatch cannot load its module",
);

assert.deepEqual(
  verifySameOriginRequest(new Request("https://carzoneaccesorios.com/api/admin/productos/update", { headers: { origin: "https://carzoneaccesorios.com", "sec-fetch-site": "same-origin" } })),
  { ok: true },
);
assert.equal(verifySameOriginRequest(new Request("https://carzoneaccesorios.com/api/admin/productos/update")).ok, false);
assert.equal(verifySameOriginRequest(new Request("https://carzoneaccesorios.com/api/admin/productos/update", { headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" } })).ok, false);

const submitBlock = manager.match(/function submitProduct\(\)[\s\S]*?async function toggleActive/)?.[0] ?? "";
assert.match(submitBlock, /normalizedProduct\.id\s*\? await updateProductViaHttpApi/);
assert.match(submitBlock, /: await runProductCreateWithConfirmation/);
assert.match(submitBlock, /createProductViaHttpApi\(normalizedProduct, requestId\)/, "create transport must remain unchanged");
assert.doesNotMatch(submitBlock, /saveProductAction/);
assert.doesNotMatch(manager, /\bsaveProductAction\b/, "browser edit path must have no Server Action dependency");
assert.match(actions, /import sharp from "sharp"/, "the failing native dependency remains isolated to image actions");

assert.match(updateRoute, /export async function PUT/);
assert.match(updateRoute, /verifySameOriginRequest\(request\)/);
assert.match(updateRoute, /typeof product\.id !== "string"/);
assert.match(updateRoute, /saveProductCanonical\(product, \{ requestId \}\)/);
assert.match(updateRoute, /case "AUTHENTICATION_REQUIRED": return 401/);
assert.match(updateRoute, /case "PERMISSION_DENIED": return 403/);
assert.match(updateRoute, /case "DUPLICATE_PRODUCT": return 409/);
assert.doesNotMatch(updateRoute, /sharp|saveProductAction|service_role|SUPABASE_SERVICE_ROLE/);
assert.match(createRoute, /export async function POST/);
assert.match(createRoute, /Esta ruta solo permite crear productos nuevos/);

assert.match(service, /const requiredCapability = input\.id \? "update" : "create"/);
assert.match(service, /target_product_id: input\.id \?\? null/);
assert.match(service, /action: input\.id \? "product\.updated" : "product\.created"/);
assert.match(service, /PRODUCT_SAVED_REFRESH_PENDING/);
assert.match(service, /products_sku_key/);
assert.match(catalogMigration, /where id = target_product_id[\s\S]*?for update/);
assert.match(catalogMigration, /sku = trim\(product_data->>'sku'\)/);
assert.match(skuGuardMigration, /unique index if not exists products_sku_upper_btrim_uidx/);
assert.match(skuGuardMigration, /upper\(btrim\(sku\)\)/);
assert.match(catalogMigration, /if delta = 0 then[\s\S]*?movement_id := null[\s\S]*?quantity := 0/);
assert.match(permissions, /contadora:\s*\[[\s\S]*?"products:update"/);

console.log("PRODUCT_UPDATE_API_TRANSPORT_MATRIX_PASS");
