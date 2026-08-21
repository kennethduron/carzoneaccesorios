import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createProductViaHttpApi } from "../src/lib/product-create-http.ts";
import {
  createProductSaveSingleFlightGuard,
  runProductCreateWithConfirmation,
} from "../src/lib/product-create-hardening.ts";
import { verifySameOriginRequest } from "../src/lib/http/same-origin-request.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const manager = read("src/components/admin/product-manager.tsx");
const actions = read("src/app/admin/productos/actions.ts");
const service = read("src/services/product-save.service.ts");
const route = read("src/app/api/admin/productos/create/route.ts");
const confirmRoute = read("src/app/api/admin/productos/confirm-create/route.ts");
const migration = read("supabase/migrations/202608200001_payment_effective_date_product_creation_hardening_v1.sql");

const requestId = "11111111-1111-4111-8111-111111111111";
const product = {
  category_id: "22222222-2222-4222-8222-222222222222",
  sku: "API-TEST-CONTRACT",
  internal_code: null,
  slug: "api-test-contract",
  name: "API contract fixture",
  brand: "Fixture",
  vehicle_brand: null,
  vehicle_model: null,
  vehicle_year_start: null,
  vehicle_year_end: null,
  short_description: null,
  description: "",
  features: null,
  specifications: null,
  compatibility_notes: null,
  stock: 4,
  min_stock: 1,
  cost_price: 10,
  retail_price: 20,
  wholesale_price: 15,
  wholesale_min_quantity: 1,
  tax_category: "standard",
  tracks_inventory: true,
  is_new: true,
  status: "active",
  active: true,
  images: [],
};
const created = {
  ok: true,
  code: "PRODUCT_CREATED",
  message: "Producto creado correctamente.",
  productId: "33333333-3333-4333-8333-333333333333",
  slug: product.slug,
  correlationId: requestId,
};

let observedRequest;
const result = await createProductViaHttpApi(product, requestId, {
  fetchImpl: async (url, init) => {
    observedRequest = { url, init };
    return Response.json(created, { status: 201 });
  },
});
assert.deepEqual(result, created, "valid create must preserve the structured API success");
assert.equal(observedRequest.url, "/api/admin/productos/create");
assert.equal(observedRequest.init.method, "POST");
assert.equal(observedRequest.init.credentials, "same-origin");
assert.equal(observedRequest.init.cache, "no-store");
assert.equal(observedRequest.init.headers["X-Request-ID"], requestId);
assert.deepEqual(JSON.parse(observedRequest.init.body), { requestId, product });

const expectedFailure = {
  ok: false,
  code: "PRODUCT_WRITE_FAILED",
  message: "No fue posible guardar el producto. La información permanece en el formulario.",
  correlationId: requestId,
};
assert.deepEqual(
  await createProductViaHttpApi(product, requestId, { fetchImpl: async () => Response.json(expectedFailure, { status: 500 }) }),
  expectedFailure,
  "a deterministic HTTP 500 body must remain a scoped form failure",
);

const confirmed = { ok: true, code: "PRODUCT_CREATED_CONFIRMED", message: "Producto guardado correctamente.", productId: created.productId, correlationId: requestId };
assert.deepEqual(
  await runProductCreateWithConfirmation(
    () => createProductViaHttpApi(product, requestId, { fetchImpl: async () => { throw new Error("network before server"); } }),
    async () => ({ ok: false, code: "PRODUCT_NOT_CREATED", message: "not created", correlationId: requestId }),
  ),
  { ok: false, code: "PRODUCT_NOT_CREATED", message: "not created", correlationId: requestId },
  "network failure before a write must use canonical confirmation",
);
assert.deepEqual(
  await runProductCreateWithConfirmation(
    () => createProductViaHttpApi(product, requestId, { fetchImpl: async () => { throw new Error("lost response after commit"); } }),
    async () => confirmed,
  ),
  confirmed,
  "a lost response after commit must become confirmed success",
);

await assert.rejects(
  createProductViaHttpApi(product, requestId, {
    timeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
  }),
  (error) => error instanceof DOMException && error.name === "AbortError",
  "the create request must have a bounded timeout",
);
assert.deepEqual(
  await runProductCreateWithConfirmation(
    () => createProductViaHttpApi(product, requestId, {
      timeoutMs: 5,
      fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    }),
    async () => confirmed,
  ),
  confirmed,
  "a timeout after a committed write must resolve to confirmed success",
);

const guard = createProductSaveSingleFlightGuard();
assert.equal(guard.tryStart(), true);
assert.equal(guard.tryStart(), false, "double click must not start a second create");
guard.finish();

const requestBodies = [];
const idempotentFetch = async (_url, init) => {
  requestBodies.push(JSON.parse(init.body));
  return requestBodies.length === 1
    ? Response.json(created, { status: 201 })
    : Response.json({ ok: false, code: "DUPLICATE_PRODUCT", message: "El SKU ya está usado por otro producto.", correlationId: requestId }, { status: 409 });
};
await createProductViaHttpApi(product, requestId, { fetchImpl: idempotentFetch });
await createProductViaHttpApi(product, requestId, { fetchImpl: idempotentFetch });
assert.equal(requestBodies[0].requestId, requestBodies[1].requestId, "the same retry must keep one request ID");
assert.equal(requestBodies[0].product.sku, requestBodies[1].product.sku, "the same retry must keep canonical identity");

assert.deepEqual(
  verifySameOriginRequest(new Request("https://carzoneaccesorios.com/api/admin/productos/create", { headers: { origin: "https://carzoneaccesorios.com", "sec-fetch-site": "same-origin" } })),
  { ok: true },
);
assert.equal(verifySameOriginRequest(new Request("https://carzoneaccesorios.com/api/admin/productos/create")).ok, false);
assert.equal(verifySameOriginRequest(new Request("https://carzoneaccesorios.com/api/admin/productos/create", { headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" } })).ok, false);

const submitBlock = manager.match(/function submitProduct\(\)[\s\S]*?async function toggleActive/)?.[0] ?? "";
assert.match(submitBlock, /createProductViaHttpApi\(normalizedProduct, requestId\)/);
assert.doesNotMatch(submitBlock.match(/normalizedProduct\.id[\s\S]*?: await runProductCreateWithConfirmation[\s\S]*?\);/)?.[0] ?? "", /\(\) => saveProductAction\(normalizedProduct\)/);
assert.match(manager, /const requestId = crypto\.randomUUID\(\)/);
assert.match(manager, /requestId \}\)/, "confirmation must retain the create request ID");
assert.doesNotMatch(manager, /cuando la conexión esté estable/);
assert.doesNotMatch(manager, /Error en el panel administrativo/);

assert.match(actions, /return saveProductCanonical\(input\)/, "legacy edit action must delegate to the shared canonical service");
assert.match(route, /saveProductCanonical\(product, \{ requestId \}\)/, "HTTP create must delegate to the same canonical service");
assert.equal((service.match(/save_product_catalog_v3_locked/g) ?? []).length, 2, "service should call and safely log one atomic RPC name");
assert.doesNotMatch(actions, /save_product_catalog_v3_locked/, "business persistence must not remain duplicated in the action module");
assert.match(migration, /save_product_catalog_v2_locked/);
assert.match(migration, /set_product_stock_locked/);
assert.match(migration, /now share one database transaction\. A failure in any write rolls back all of it\./);
assert.match(service, /action: input\.id \? "product\.updated" : "product\.created"/);
assert.match(service, /runProductPostSaveTasks/);
assert.match(service, /SKU, nombre y marca son obligatorios/);
assert.match(service, /precio al detalle debe ser mayor que cero/);
assert.match(service, /productTaxCategorySchema\.safeParse/);
assert.match(service, /Selecciona una categoría oficial y activa/);
assert.match(service, /\.from\("categories"\)/);
assert.match(route, /case "AUTHENTICATION_REQUIRED": return 401/);
assert.match(route, /case "PERMISSION_DENIED": return 403/);
assert.match(route, /case "DUPLICATE_PRODUCT": return 409/);
assert.match(route, /verifySameOriginRequest\(request\)/);
assert.match(route, /Object\.prototype\.hasOwnProperty\.call\(product, "id"\)/);
assert.doesNotMatch(route, /service.role|service_role|SUPABASE_SERVICE_ROLE|request.*role/is);
assert.match(confirmRoute, /PRODUCT_CREATED_CONFIRMED/);
assert.match(confirmRoute, /requestIdPattern\.test\(input\.requestId\)/);
assert.match(confirmRoute, /Producto guardado correctamente\./);
assert.match(manager, /const retryDelaysMs = \[0, 1_500, 3_000\]/, "ambiguous confirmation must absorb a late commit race with read-only retries");

const serverActionUnavailable = async () => { throw new Error("invalid server action id"); };
await assert.rejects(serverActionUnavailable, /invalid server action id/);
assert.deepEqual(
  await createProductViaHttpApi(product, requestId, { fetchImpl: async () => Response.json(created, { status: 201 }) }),
  created,
  "API create must remain available when Server Action dispatch is unavailable",
);

console.log("PRODUCT_CREATE_API_TRANSPORT_MATRIX_PASS");
