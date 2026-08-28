import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { imagePayload } from "../src/utils/product-image-payload.ts";
import {
  productImageLimitErrorCode,
  productImageMaxBytes,
  productImageMaxCount,
  productImageMaxPixels,
} from "../src/utils/product-image-rules.ts";
import {
  productCatalogLimitErrorCode,
  productCatalogMaxRows,
} from "../src/utils/product-catalog-limits.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const image = (index, primary = false) => ({
  public_url: `https://example.test/product-${index}.webp`,
  public_id: `product-${index}`,
  storage_path: `product-${index}`,
  angle: index === 0 ? "principal" : "lateral",
  alt_text: `Imagen ${index}`,
  sort_order: index,
  is_primary: primary,
});

assert.equal(productImageMaxCount, 4);
assert.equal(productImageMaxBytes, 3_000_000);
assert.equal(productImageMaxPixels, 3_000_000);
assert.equal(productCatalogMaxRows, 3_000);

assert.deepEqual(imagePayload([]), []);
for (const count of [1, 2, 3, 4]) {
  const payload = imagePayload(Array.from({ length: count }, (_, index) => image(index, index === count - 1)));
  assert.equal(payload.length, count, `${count} images must be preserved without truncation`);
  assert.equal(payload.filter((entry) => entry.is_primary).length, 1);
  assert.equal(payload[count - 1].is_primary, true);
}
assert.throws(
  () => imagePayload(Array.from({ length: 5 }, (_, index) => image(index))),
  (error) => error instanceof Error && error.message === productImageLimitErrorCode,
  "a fifth canonical image must be rejected explicitly",
);
const noLocalBlob = imagePayload([
  { ...image(0), is_primary: false },
  { public_url: "", public_id: null, storage_path: null, angle: "principal", alt_text: null, sort_order: 1, is_primary: true },
]);
assert.equal(noLocalBlob.length, 1, "a local-only/failed image must not enter the canonical payload");
assert.equal(noLocalBlob[0].is_primary, true, "a failed local primary selection must not remove the persisted primary");

const manager = read("src/components/admin/product-manager.tsx");
const service = read("src/services/product-save.service.ts");
const createRoute = read("src/app/api/admin/productos/create/route.ts");
const updateRoute = read("src/app/api/admin/productos/update/route.ts");
const uploadRoute = read("src/app/api/admin/productos/images/upload/route.ts");
const uploadHttp = read("src/lib/product-image-upload-http.ts");
const uploadHandler = read("src/lib/product-image-upload-route-handler.ts");
const config = read("next.config.ts");
const migration = read("supabase/migrations/202608280001_product_image_catalog_limits.sql");

assert.match(config, /"\/api\/admin\/productos\/images\/upload"[\s\S]*?\.\/node_modules\/@img\/sharp-libvips-linux-x64\/\*\*\/\*/);
assert.doesNotMatch(config, /node_modules\/\*\*/);
assert.match(manager, /status: "existing" \| "local_preview" \| "uploading" \| "uploaded" \| "error"/);
assert.match(manager, /upload\.status === "local_preview" \|\| upload\.status === "uploading"/);
assert.match(manager, /hasFailedImageUpload/);
assert.match(manager, /if \(imageSaveBlockReason\)/, "submit must independently enforce the image save gate");
assert.match(manager, /disabled=\{pending \|\| Boolean\(imageSaveBlockReason\)\}/);
assert.match(manager, /Descartar cambio de imagen/);
assert.match(manager, /delete next\[index\]/);
assert.match(manager, /uploadState\?\.previewUrl \|\| image\.public_url/);
assert.match(manager, /requestId: uploadIdentity\.requestId/);
assert.match(manager, /disabled=\{!image\.public_url \|\| image\.is_primary \|\| hasLocalChange\}/);
assert.doesNotMatch(service, /\.slice\(0,\s*4\)/);
assert.match(service, /PRODUCT_IMAGE_LIMIT_EXCEEDED/);
assert.match(service, /PRODUCT_CATALOG_LIMIT_REACHED/);
assert.match(createRoute, /saveProductCanonical\(product, \{ requestId \}\)/);
assert.match(updateRoute, /saveProductCanonical\(product, \{ requestId \}\)/);
assert.match(uploadRoute, /createProductImageUploadRouteHandler/);
assert.match(uploadHttp, /input\.slotIndex >= productImageMaxCount/);
assert.match(uploadHandler, /slotIndex >= productImageMaxCount/);

for (const token of [
  "pg_advisory_xact_lock",
  "PRODUCT_CATALOG_LIMIT_REACHED",
  "PRODUCT_IMAGE_LIMIT_EXCEEDED",
  "before insert or delete on public.products",
  "before insert or delete on public.product_images",
  "jsonb_array_length(images_data) > 4",
]) assert.match(migration, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
assert.match(migration, /if tg_op = 'INSERT'[\s\S]*?count\(\*\)[\s\S]*?>= 3000/);
assert.doesNotMatch(migration, /delete from public\.(products|product_images)/i);
assert.equal(productCatalogLimitErrorCode, "PRODUCT_CATALOG_LIMIT_REACHED");

console.log("PRODUCT_FINAL_HARDENING_UNIT_PASS");
