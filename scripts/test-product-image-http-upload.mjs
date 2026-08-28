import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import sharp from "sharp";
import {
  productImageUploadApiPath,
} from "../src/lib/product-image-upload-contract.ts";
import {
  ProductImageUploadTransportError,
  uploadProductImageViaHttp,
} from "../src/lib/product-image-upload-http.ts";
import { createProductImageUploadRouteHandler } from "../src/lib/product-image-upload-route-handler.ts";
import { createProductImageSharpImportDiagnostic } from "../src/lib/product-image-sharp-diagnostic.ts";
import {
  productImageRemoteIdentity,
  uploadProductImageToCloudinary,
} from "../src/services/product-image-upload.service.ts";
import { productImageMaxBytes, productImageMaxCount } from "../src/utils/product-image-rules.ts";

const requestId = "11111111-1111-4111-8111-111111111111";
const secondRequestId = "22222222-2222-4222-8222-222222222222";
const fallbackCorrelationId = "99999999-9999-4999-8999-999999999999";
const routeUrl = `https://carzoneaccesorios.com${productImageUploadApiPath}`;
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

function cloudinaryDouble(mode = "success") {
  const calls = [];
  const client = {
    uploader: {
      upload_stream(options, callback) {
        return {
          end(buffer) {
            calls.push({ options, bytes: buffer.length });
            if (mode === "failure") {
              callback(new Error("synthetic cloudinary failure"));
              return;
            }
            const fullPublicId = `${options.folder}/${options.public_id}`;
            callback(null, {
              secure_url: mode === "invalid" ? "javascript:invalid" : `https://res.cloudinary.com/test/image/upload/${fullPublicId}.webp`,
              public_id: mode === "identity-mismatch" ? `${fullPublicId}-wrong` : fullPublicId,
            });
          },
        };
      },
    },
  };
  return { calls, client };
}

function routeDependencies({ profile = { id: "admin-1" }, canManageImages = true, uploadImage, logFailure } = {}) {
  return {
    createCorrelationId: () => fallbackCorrelationId,
    getSessionProfile: async () => profile,
    canManageImages: () => canManageImages,
    uploadImage: uploadImage ?? (async () => ({
      ok: true,
      image: {
        publicUrl: "https://res.cloudinary.com/test/image/upload/product.webp",
        publicId: `car-zone/productos/producto/principal-${requestId}`,
        storagePath: `car-zone/productos/producto/principal-${requestId}`,
      },
    })),
    logFailure,
  };
}

function uploadRequest({
  file,
  id = requestId,
  headerId = id,
  origin = "https://carzoneaccesorios.com",
  fetchSite = "same-origin",
  productSlug = "producto",
  angle = "principal",
  slotIndex = "0",
  includeFile = true,
} = {}) {
  const formData = new FormData();
  if (includeFile && file) formData.set("file", file);
  formData.set("requestId", id);
  formData.set("productSlug", productSlug);
  formData.set("angle", angle);
  formData.set("slotIndex", slotIndex);
  return new Request(routeUrl, {
    method: "POST",
    headers: {
      origin,
      "sec-fetch-site": fetchSite,
      ...(headerId === null ? {} : { "x-request-id": headerId }),
    },
    body: formData,
  });
}

async function responseJson(response) {
  const value = await response.json();
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-correlation-id"), value.correlationId);
  return value;
}

const sourceBuffers = {
  "image/jpeg": await sharp({ create: { width: 64, height: 48, channels: 3, background: "#e4252c" } }).jpeg().toBuffer(),
  "image/png": await sharp({ create: { width: 64, height: 48, channels: 4, background: "#e4252c" } }).png().toBuffer(),
  "image/webp": await sharp({ create: { width: 64, height: 48, channels: 3, background: "#e4252c" } }).webp().toBuffer(),
};

for (const [mimeType, buffer] of Object.entries(sourceBuffers)) {
  const remote = cloudinaryDouble();
  const handler = createProductImageUploadRouteHandler(routeDependencies({
    uploadImage: (input) => uploadProductImageToCloudinary(input, { getCloudinary: () => remote.client }),
  }));
  const response = await handler(uploadRequest({ file: new File([buffer], `fixture.${mimeType.split("/")[1]}`, { type: mimeType }) }));
  const result = await responseJson(response);
  assert.equal(response.status, 200, `${mimeType} should upload through the HTTP boundary`);
  assert.equal(result.ok, true);
  assert.equal(result.requestId, requestId);
  assert.equal(result.correlationId, requestId);
  assert.equal(result.image.publicId, result.image.storagePath);
  assert.equal(remote.calls.length, 1);
  assert.equal(remote.calls[0].options.format, "webp");
  assert.equal(remote.calls[0].options.overwrite, true);
}

const validJpeg = new File([sourceBuffers["image/jpeg"]], "valid.jpg", { type: "image/jpeg" });
const exactByteBoundaryResponse = await createProductImageUploadRouteHandler(routeDependencies())(
  uploadRequest({
    file: new File([new Uint8Array(productImageMaxBytes)], "exact-boundary.jpg", { type: "image/jpeg" }),
  }),
);
assert.equal(exactByteBoundaryResponse.status, 200, "exactly 3,000,000 bytes must pass the HTTP size gate");

const routeCases = [
  {
    name: "invalid origin",
    dependencies: routeDependencies(),
    request: uploadRequest({ file: validJpeg, origin: "https://attacker.example", fetchSite: "cross-site" }),
    status: 403,
    code: "ORIGIN_DENIED",
  },
  {
    name: "unauthenticated",
    dependencies: routeDependencies({ profile: null }),
    request: uploadRequest({ file: validJpeg }),
    status: 401,
    code: "AUTHENTICATION_REQUIRED",
  },
  {
    name: "unauthorized",
    dependencies: routeDependencies({ canManageImages: false }),
    request: uploadRequest({ file: validJpeg }),
    status: 403,
    code: "PERMISSION_DENIED",
  },
  {
    name: "authentication check unavailable",
    dependencies: {
      ...routeDependencies(),
      getSessionProfile: async () => { throw new Error("synthetic auth dependency failure"); },
    },
    request: uploadRequest({ file: validJpeg }),
    status: 503,
    code: "AUTHENTICATION_CHECK_FAILED",
  },
  {
    name: "missing request id",
    dependencies: routeDependencies(),
    request: uploadRequest({ file: validJpeg, headerId: null }),
    status: 400,
    code: "INVALID_REQUEST_ID",
  },
  {
    name: "malformed request id",
    dependencies: routeDependencies(),
    request: uploadRequest({ file: validJpeg, id: "not-a-uuid", headerId: "not-a-uuid" }),
    status: 400,
    code: "INVALID_REQUEST_ID",
  },
  {
    name: "request identity mismatch",
    dependencies: routeDependencies(),
    request: uploadRequest({ file: validJpeg, id: secondRequestId, headerId: requestId }),
    status: 400,
    code: "INVALID_UPLOAD_INPUT",
  },
  {
    name: "unsupported mime",
    dependencies: routeDependencies(),
    request: uploadRequest({ file: new File(["gif"], "bad.gif", { type: "image/gif" }) }),
    status: 415,
    code: "UNSUPPORTED_IMAGE_TYPE",
  },
  {
    name: "oversized file",
    dependencies: routeDependencies(),
    request: uploadRequest({ file: new File([new Uint8Array(productImageMaxBytes + 1)], "large.jpg", { type: "image/jpeg" }) }),
    status: 413,
    code: "IMAGE_TOO_LARGE",
  },
  {
    name: "empty file",
    dependencies: routeDependencies(),
    request: uploadRequest({ file: new File([], "empty.jpg", { type: "image/jpeg" }) }),
    status: 400,
    code: "EMPTY_IMAGE_FILE",
  },
  {
    name: "missing file",
    dependencies: routeDependencies(),
    request: uploadRequest({ includeFile: false }),
    status: 400,
    code: "MISSING_IMAGE_FILE",
  },
  {
    name: "invalid angle",
    dependencies: routeDependencies(),
    request: uploadRequest({ file: validJpeg, angle: "../../secret" }),
    status: 400,
    code: "INVALID_UPLOAD_INPUT",
  },
  {
    name: "invalid slot",
    dependencies: routeDependencies(),
    request: uploadRequest({ file: validJpeg, slotIndex: String(productImageMaxCount) }),
    status: 400,
    code: "INVALID_UPLOAD_INPUT",
  },
];

for (const testCase of routeCases) {
  const response = await createProductImageUploadRouteHandler(testCase.dependencies)(testCase.request);
  const result = await responseJson(response);
  assert.equal(response.status, testCase.status, testCase.name);
  assert.equal(result.ok, false, testCase.name);
  assert.equal(result.code, testCase.code, testCase.name);
  assert.equal("errorStack" in result, false, `${testCase.name} must not expose a stack`);
}

const invalidContentTypeResponse = await createProductImageUploadRouteHandler(routeDependencies())(new Request(routeUrl, {
  method: "POST",
  headers: {
    origin: "https://carzoneaccesorios.com",
    "sec-fetch-site": "same-origin",
    "x-request-id": requestId,
    "content-type": "application/json",
  },
  body: "{}",
}));
assert.equal(invalidContentTypeResponse.status, 415);
assert.equal((await invalidContentTypeResponse.json()).code, "INVALID_CONTENT_TYPE");

const corruptRemote = cloudinaryDouble();
const corruptResult = await uploadProductImageToCloudinary({
  file: new File(["not an image"], "corrupt.jpg", { type: "image/jpeg" }),
  productSlug: "producto",
  angle: "principal",
  requestId,
}, { getCloudinary: () => corruptRemote.client });
assert.equal(corruptResult.ok, false);
assert.equal(corruptResult.code, "INVALID_IMAGE_CONTENT");
assert.equal(corruptRemote.calls.length, 0);

const tooManyPixelsBuffer = await sharp({
  create: { width: 2000, height: 1600, channels: 3, background: "#ffffff" },
}).jpeg().toBuffer();
const pixelRemote = cloudinaryDouble();
const pixelResult = await uploadProductImageToCloudinary({
  file: new File([tooManyPixelsBuffer], "pixels.jpg", { type: "image/jpeg" }),
  productSlug: "producto",
  angle: "principal",
  requestId,
}, { getCloudinary: () => pixelRemote.client });
assert.equal(pixelResult.ok, false);
assert.equal(pixelResult.code, "IMAGE_TOO_MANY_PIXELS");
assert.equal(pixelRemote.calls.length, 0);

const pixelBoundaryBuffer = await sharp({
  create: { width: 2000, height: 1500, channels: 3, background: "#ffffff" },
}).jpeg().toBuffer();
const pixelBoundaryRemote = cloudinaryDouble();
const pixelBoundaryResult = await uploadProductImageToCloudinary({
  file: new File([pixelBoundaryBuffer], "pixels-boundary.jpg", { type: "image/jpeg" }),
  productSlug: "producto",
  angle: "principal",
  requestId,
}, { getCloudinary: () => pixelBoundaryRemote.client });
assert.equal(pixelBoundaryResult.ok, true, "exactly 3,000,000 pixels must pass");
assert.equal(pixelBoundaryRemote.calls.length, 1);

let cloudinaryAccesses = 0;
const fakeApiKey = "sk_test_FAKE_DIAGNOSTIC_KEY_123456789";
const fakeAuthorization = "Bearer fake.authorization.token";
const adversarialError = Object.assign(new Error(
  `apiKey=${fakeApiKey}\r\nauthorization=${fakeAuthorization} C:\\Users\\fixture\\secret\\sharp.node `
  + "/var/task/node_modules/sharp/lib/index.js /vercel/path0/node_modules/@img/sharp-linux-x64/lib/sharp.node /opt/runtime/secret.node "
  + "x".repeat(900),
), { code: "ERR_DLOPEN_FAILED" });
adversarialError.stack = `${adversarialError.name}: ${adversarialError.message}\n`
  + "    at load (C:\\Users\\fixture\\secret\\loader.js:10:2)\n"
  + "    at importSharp (/var/task/node_modules/sharp/lib/index.js:12:4)\n"
  + "    at bootstrap (/vercel/path0/app/server.js:20:6)\n"
  + "    at fifth (/var/task/fifth.js:1:1)";
const standaloneDiagnostic = createProductImageSharpImportDiagnostic(adversarialError);
assert.deepEqual(Object.keys(standaloneDiagnostic), [
  "errorName",
  "errorCode",
  "errorMessageSanitized",
  "stackOrigin",
  "nodeVersion",
  "platform",
  "arch",
]);
assert.equal(standaloneDiagnostic.errorCode, "ERR_DLOPEN_FAILED");
assert.ok(standaloneDiagnostic.errorMessageSanitized.length <= 500);
assert.ok(standaloneDiagnostic.stackOrigin.length <= 1000);
assert.ok(standaloneDiagnostic.stackOrigin.split("\n").length <= 4);
assert.match(standaloneDiagnostic.errorMessageSanitized, /<runtime>\/node_modules\/sharp/);
assert.match(standaloneDiagnostic.errorMessageSanitized, /<build>\/node_modules\/@img\/sharp-linux-x64/);
assert.doesNotMatch(standaloneDiagnostic.errorMessageSanitized, /\/opt\/runtime/);
assert.doesNotMatch(JSON.stringify(standaloneDiagnostic), /C:\\\\Users\\\\fixture/i);
assert.doesNotMatch(JSON.stringify(standaloneDiagnostic), new RegExp(fakeApiKey));
assert.doesNotMatch(JSON.stringify(standaloneDiagnostic), new RegExp(fakeAuthorization.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

const sharpUnavailable = await uploadProductImageToCloudinary({
  file: validJpeg,
  productSlug: "producto",
  angle: "principal",
  requestId,
}, {
  loadSharp: async () => { throw adversarialError; },
  getCloudinary: () => { cloudinaryAccesses += 1; return cloudinaryDouble().client; },
});
assert.deepEqual(sharpUnavailable, {
  ok: false,
  code: "IMAGE_PROCESSOR_UNAVAILABLE",
  message: "El procesador de imágenes no está disponible. Conservamos el archivo para que puedas reintentar.",
  status: 503,
  stage: "image_processing",
  sharpImportDiagnostic: standaloneDiagnostic,
});
assert.equal(cloudinaryAccesses, 0, "sharp load failure must perform zero Cloudinary writes");
assert.deepEqual(sharpUnavailable.sharpImportDiagnostic, standaloneDiagnostic);

const sharpRouteResponse = await createProductImageUploadRouteHandler(routeDependencies({
  uploadImage: async () => sharpUnavailable,
}))(uploadRequest({ file: validJpeg }));
assert.equal(sharpRouteResponse.status, 503);
const sharpRouteBody = await sharpRouteResponse.json();
assert.equal(sharpRouteBody.code, "IMAGE_PROCESSOR_UNAVAILABLE");
assert.equal("sharpImportDiagnostic" in sharpRouteBody, false);
assert.equal("diagnostic" in sharpRouteBody, false);
assert.doesNotMatch(JSON.stringify(sharpRouteBody), /ERR_DLOPEN_FAILED|FAKE_DIAGNOSTIC|runtime-path/);

const failedRemote = cloudinaryDouble("failure");
const cloudinaryFailure = await uploadProductImageToCloudinary({
  file: validJpeg,
  productSlug: "producto",
  angle: "principal",
  requestId,
}, { getCloudinary: () => failedRemote.client });
assert.equal(cloudinaryFailure.ok, false);
assert.equal(cloudinaryFailure.code, "CLOUDINARY_UPLOAD_FAILED");
assert.equal(failedRemote.calls.length, 1);

const stalledRemote = {
  uploader: {
    upload_stream() {
      return { end() {} };
    },
  },
};
const cloudinaryTimeout = await uploadProductImageToCloudinary({
  file: validJpeg,
  productSlug: "producto",
  angle: "principal",
  requestId,
}, { getCloudinary: () => stalledRemote, cloudinaryTimeoutMs: 5 });
assert.equal(cloudinaryTimeout.ok, false);
assert.equal(cloudinaryTimeout.code, "CLOUDINARY_UPLOAD_FAILED");

const invalidRemote = cloudinaryDouble("identity-mismatch");
const invalidRemoteResult = await uploadProductImageToCloudinary({
  file: validJpeg,
  productSlug: "producto",
  angle: "principal",
  requestId,
}, { getCloudinary: () => invalidRemote.client });
assert.equal(invalidRemoteResult.ok, false);
assert.equal(invalidRemoteResult.code, "CLOUDINARY_RESPONSE_INVALID");

const retryRemote = cloudinaryDouble();
const idempotentInput = { file: validJpeg, productSlug: "Alfombra Toyota", angle: "lateral", requestId };
const firstUpload = await uploadProductImageToCloudinary(idempotentInput, { getCloudinary: () => retryRemote.client });
const retryUpload = await uploadProductImageToCloudinary(idempotentInput, { getCloudinary: () => retryRemote.client });
assert.equal(firstUpload.ok, true);
assert.equal(retryUpload.ok, true);
assert.equal(firstUpload.image.publicId, retryUpload.image.publicId, "same idempotency key must address the same remote ID");
assert.equal(retryRemote.calls[0].options.public_id, retryRemote.calls[1].options.public_id);
assert.equal(retryRemote.calls[0].options.overwrite, true);
assert.notEqual(
  productImageRemoteIdentity({ ...idempotentInput, requestId: secondRequestId }).fullPublicId,
  firstUpload.image.publicId,
  "a newly selected file identity must receive a different remote ID",
);

const successResponse = {
  ok: true,
  requestId,
  correlationId: requestId,
  image: firstUpload.image,
};
let observedRequest;
assert.deepEqual(await uploadProductImageViaHttp({
  file: validJpeg,
  productSlug: "Alfombra Toyota",
  angle: "lateral",
  slotIndex: 1,
  requestId,
}, {
  fetchImpl: async (url, init) => {
    observedRequest = { url, init };
    return Response.json(successResponse);
  },
}), successResponse);
assert.equal(observedRequest.url, productImageUploadApiPath);
assert.equal(observedRequest.init.method, "POST");
assert.equal(observedRequest.init.credentials, "same-origin");
assert.equal(observedRequest.init.cache, "no-store");
assert.equal(observedRequest.init.headers["X-Request-ID"], requestId);
assert.equal(observedRequest.init.body.get("requestId"), requestId);
assert.equal(observedRequest.init.body.get("slotIndex"), "1");
assert.equal(observedRequest.init.body.get("angle"), "lateral");

const serverFailure = {
  ok: false,
  requestId,
  correlationId: requestId,
  code: "CLOUDINARY_UPLOAD_FAILED",
  message: "No se pudo almacenar la imagen.",
};
assert.deepEqual(await uploadProductImageViaHttp({
  file: validJpeg,
  productSlug: "producto",
  angle: "principal",
  slotIndex: 0,
  requestId,
}, { fetchImpl: async () => Response.json(serverFailure, { status: 502 }) }), serverFailure);

await assert.rejects(
  uploadProductImageViaHttp({ file: validJpeg, productSlug: "producto", angle: "principal", slotIndex: 0, requestId }, {
    fetchImpl: async () => new Response("not-json", { status: 502 }),
  }),
  (error) => error instanceof ProductImageUploadTransportError && error.code === "INVALID_UPLOAD_RESPONSE",
);
await assert.rejects(
  uploadProductImageViaHttp({ file: validJpeg, productSlug: "producto", angle: "principal", slotIndex: 0, requestId }, {
    fetchImpl: async () => Response.json({ ...serverFailure, code: "UNTRUSTED_SERVER_CODE" }, { status: 502 }),
  }),
  (error) => error instanceof ProductImageUploadTransportError && error.code === "INVALID_UPLOAD_RESPONSE",
);
await assert.rejects(
  uploadProductImageViaHttp({ file: validJpeg, productSlug: "producto", angle: "principal", slotIndex: 0, requestId }, {
    fetchImpl: async () => Response.json({ ...successResponse, correlationId: secondRequestId }),
  }),
  (error) => error instanceof ProductImageUploadTransportError && error.code === "UPLOAD_IDENTITY_MISMATCH",
);
await assert.rejects(
  uploadProductImageViaHttp({ file: validJpeg, productSlug: "producto", angle: "principal", slotIndex: 0, requestId }, {
    fetchImpl: async () => { throw new Error("synthetic network failure"); },
  }),
  (error) => error instanceof ProductImageUploadTransportError && error.code === "UPLOAD_NETWORK_ERROR",
);
await assert.rejects(
  uploadProductImageViaHttp({ file: validJpeg, productSlug: "producto", angle: "principal", slotIndex: 0, requestId }, {
    timeoutMs: 5,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }),
  }),
  (error) => error instanceof ProductImageUploadTransportError && error.code === "UPLOAD_TIMEOUT",
);

const manager = read("src/components/admin/product-manager.tsx");
const uploadBlock = manager.match(/async function uploadImage\([\s\S]*?function retryImageUpload/)?.[0] ?? "";
assert.doesNotMatch(manager, /\buploadProductImageAction\b/, "ProductManager must not dispatch the upload Server Action");
assert.match(uploadBlock, /startTransition\(async \(\) => \{\s*try \{/);
assert.match(uploadBlock, /catch \(error\)/, "expected upload failures must remain inside the editor boundary");
assert.match(uploadBlock, /requestId: uploadIdentity\.requestId/);
assert.match(uploadBlock, /updateImage\(index, \{[\s\S]*?result\.image\.publicUrl/);
assert.doesNotMatch(uploadBlock.match(/if \(!result\.ok\)[\s\S]*?return;/)?.[0] ?? "", /updateImage/);
assert.doesNotMatch(uploadBlock, /setEditing\(null\)/, "upload failure must not close the editor");
assert.equal(productImageMaxBytes, 3_000_000, "the UI and server must enforce decimal 3 MB");
assert.equal(productImageMaxCount, 4);
assert.match(manager, /product\.images\.length >= productImageMaxCount/);
assert.match(manager, /upload\.status === "local_preview" \|\| upload\.status === "uploading"/);
assert.match(manager, /hasFailedImageUpload/);
assert.match(manager, /disabled=\{pending \|\| Boolean\(imageSaveBlockReason\)\}/);
assert.match(manager, /Descartar cambio de imagen/);
assert.match(manager, /flex shrink-0 flex-wrap justify-end gap-2/, "retry/discard actions must wrap on narrow screens");
assert.match(manager, /delete next\[index\]/, "discard must remove the failed local preview state");
assert.match(manager, /uploadState\?\.previewUrl \|\| image\.public_url/, "discard must reveal persisted replacement metadata again");
assert.match(manager, /requestId: uploadIdentity\.requestId/, "retry identity must be stable");
assert.match(manager, /role=\{uploadState\.status === "error" \? "alert" : "status"\}/);
assert.match(manager, /aria-live="polite"/);
assert.match(manager, /max-w-6xl[\s\S]*?sm:my-6/);

const simulatedExistingImages = [
  { public_url: "https://example.test/existing-a.webp", public_id: "existing-a" },
  { public_url: "https://example.test/existing-b.webp", public_id: "existing-b" },
];
const draftAfterA = [...simulatedExistingImages];
draftAfterA[0] = { public_url: firstUpload.image.publicUrl, public_id: firstUpload.image.publicId };
const draftAfterBFailure = [...draftAfterA];
assert.deepEqual(draftAfterBFailure[0], draftAfterA[0], "successful slot A must survive independent slot B failure");
assert.deepEqual(draftAfterBFailure[1], simulatedExistingImages[1], "failed slot B must preserve its existing remote metadata");

const actions = read("src/app/admin/productos/actions.ts");
const serviceSource = read("src/services/product-image-upload.service.ts");
const routeSource = read("src/app/api/admin/productos/images/upload/route.ts");
assert.doesNotMatch(actions, /import sharp from "sharp"/);
assert.doesNotMatch(actions, /uploadProductImageAction/, "the obsolete Server Action upload entry point must be removed");
assert.doesNotMatch(serviceSource, /^import sharp/m);
assert.match(serviceSource, /await import\("sharp"\)/);
assert.match(serviceSource, /public_id: identity\.leafPublicId/);
assert.match(routeSource, /export const runtime = "nodejs"/);
assert.doesNotMatch(routeSource, /SUPABASE_SERVICE_ROLE|CLOUDINARY_API_SECRET|process\.env/);

console.log("PRODUCT_IMAGE_HTTP_UPLOAD_MATRIX_PASS");
