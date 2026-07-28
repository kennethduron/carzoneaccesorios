import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  FiscalLogoNormalizationError,
  normalizeFiscalLogo,
} from "../src/utils/fiscal-logo-normalization.ts";
import {
  officialInvoiceLogoFallbackPath,
  officialInvoiceLogoLayout,
  resolveOfficialInvoiceLogoSrc,
} from "../src/utils/official-invoice-logo.ts";

const options = { maxInputPixels: 5_000_000, maxOutputWidth: 800 };
const opaqueWhite = { r: 255, g: 255, b: 255, alpha: 1 };
const transparent = { r: 255, g: 255, b: 255, alpha: 0 };

async function solid(width, height, background) {
  return sharp({ create: { width, height, channels: 4, background } }).png().toBuffer();
}

async function fixture({ width, height, background, layers, format }) {
  let pipeline = sharp({ create: { width, height, channels: 4, background } }).composite(layers);
  if (format === "jpeg") pipeline = pipeline.jpeg({ quality: 96 });
  if (format === "webp") pipeline = pipeline.webp({ quality: 96 });
  if (format === "png") pipeline = pipeline.png();
  return pipeline.toBuffer();
}

async function coloredMark(width, height) {
  const dark = await solid(width, height, { r: 15, g: 15, b: 15, alpha: 1 });
  const red = await solid(Math.round(width * 0.34), Math.max(8, Math.round(height * 0.22)), {
    r: 218,
    g: 37,
    b: 29,
    alpha: 1,
  });
  return { dark, red };
}

function assertPreservedAspect(result) {
  const expected = result.croppedWidth / result.croppedHeight;
  const actual = result.finalWidth / result.finalHeight;
  assert.ok(Math.abs(expected - actual) < 0.02, `Relacion alterada: ${expected} vs ${actual}`);
}

async function assertNormalizationError(input, expectedCode) {
  await assert.rejects(
    () => normalizeFiscalLogo(input, options),
    (error) => error instanceof FiscalLogoNormalizationError && error.code === expectedCode,
  );
}

const panoramicMark = await coloredMark(420, 88);
const panoramicTransparent = await fixture({
  width: 620,
  height: 220,
  background: transparent,
  layers: [
    { input: panoramicMark.dark, left: 100, top: 66 },
    { input: panoramicMark.red, left: 125, top: 98 },
  ],
  format: "png",
});
const panoramicResult = await normalizeFiscalLogo(panoramicTransparent, options);
assert.equal(panoramicResult.backgroundDetection, "alpha");
assert.deepEqual(panoramicResult.boundingBox, { left: 100, top: 66, width: 420, height: 88 });
assert.ok(panoramicResult.padding >= 2);
assertPreservedAspect(panoramicResult);

const squareTransparentMark = await coloredMark(430, 120);
const squareTransparent = await fixture({
  width: 640,
  height: 640,
  background: transparent,
  layers: [
    { input: squareTransparentMark.dark, left: 105, top: 260 },
    { input: squareTransparentMark.red, left: 135, top: 304 },
  ],
  format: "png",
});
const squareTransparentResult = await normalizeFiscalLogo(squareTransparent, options);
assert.deepEqual(squareTransparentResult.boundingBox, { left: 105, top: 260, width: 430, height: 120 });
assert.ok(squareTransparentResult.croppedWidth < 500);
assertPreservedAspect(squareTransparentResult);

const opaqueResults = [];
for (const format of ["webp", "jpeg"]) {
  const mark = await coloredMark(420, 112);
  const squareWhite = await fixture({
    width: 640,
    height: 640,
    background: opaqueWhite,
    layers: [
      { input: mark.dark, left: 110, top: 264 },
      { input: mark.red, left: 142, top: 306 },
    ],
    format,
  });
  const result = await normalizeFiscalLogo(squareWhite, options);
  assert.equal(result.backgroundDetection, "edge_connected_near_white");
  assert.ok(result.boundingBox.left >= 104 && result.boundingBox.left <= 114);
  assert.ok(result.boundingBox.top >= 258 && result.boundingBox.top <= 270);
  assert.ok(result.boundingBox.width >= 416 && result.boundingBox.width <= 428);
  assert.ok(result.boundingBox.height >= 108 && result.boundingBox.height <= 120);
  assertPreservedAspect(result);
  opaqueResults.push({ format, result });
}

const croppedMark = await coloredMark(500, 130);
const alreadyCropped = await fixture({
  width: 510,
  height: 140,
  background: transparent,
  layers: [
    { input: croppedMark.dark, left: 5, top: 5 },
    { input: croppedMark.red, left: 25, top: 60 },
  ],
  format: "png",
});
const alreadyCroppedResult = await normalizeFiscalLogo(alreadyCropped, options);
assert.deepEqual(alreadyCroppedResult.boundingBox, { left: 5, top: 5, width: 500, height: 130 });
assert.ok(alreadyCroppedResult.finalWidth > 500);
assertPreservedAspect(alreadyCroppedResult);

const allWhite = await fixture({ width: 320, height: 320, background: opaqueWhite, layers: [], format: "png" });
await assertNormalizationError(allWhite, "empty_image");
const allTransparent = await fixture({ width: 320, height: 320, background: transparent, layers: [], format: "png" });
await assertNormalizationError(allTransparent, "empty_image");

const outer = await solid(360, 120, { r: 12, g: 12, b: 12, alpha: 1 });
const innerWhite = await solid(130, 54, opaqueWhite);
const internalWhiteFixture = await fixture({
  width: 600,
  height: 300,
  background: opaqueWhite,
  layers: [
    { input: outer, left: 120, top: 90 },
    { input: innerWhite, left: 235, top: 123 },
  ],
  format: "png",
});
const internalWhiteResult = await normalizeFiscalLogo(internalWhiteFixture, options);
assert.deepEqual(internalWhiteResult.boundingBox, { left: 120, top: 90, width: 360, height: 120 });
const internalRaw = await sharp(internalWhiteResult.buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const internalX = internalWhiteResult.padding + (250 - internalWhiteResult.boundingBox.left);
const internalY = internalWhiteResult.padding + (140 - internalWhiteResult.boundingBox.top);
const internalOffset = (internalY * internalRaw.info.width + internalX) * internalRaw.info.channels;
assert.ok(internalRaw.data[internalOffset] > 235 && internalRaw.data[internalOffset + 1] > 235 && internalRaw.data[internalOffset + 2] > 235);

const lightBorder = await solid(280, 100, { r: 242, g: 242, b: 242, alpha: 1 });
const redCore = await solid(220, 52, { r: 210, g: 30, b: 28, alpha: 1 });
const lightBorderFixture = await fixture({
  width: 500,
  height: 300,
  background: opaqueWhite,
  layers: [
    { input: lightBorder, left: 110, top: 100 },
    { input: redCore, left: 140, top: 124 },
  ],
  format: "png",
});
const lightBorderResult = await normalizeFiscalLogo(lightBorderFixture, options);
assert.deepEqual(lightBorderResult.boundingBox, { left: 110, top: 100, width: 280, height: 100 });

await assertNormalizationError(Buffer.from("archivo-corrupto"), "invalid_format");

const productSquare = await readFile(new URL("../public/brand/car-zone-logo.jpeg", import.meta.url));
const productSquareResult = await normalizeFiscalLogo(productSquare, options);
assert.equal(productSquareResult.originalWidth, 640);
assert.equal(productSquareResult.originalHeight, 640);
assert.ok(productSquareResult.boundingBox.left >= 70 && productSquareResult.boundingBox.left <= 76);
assert.ok(productSquareResult.boundingBox.top >= 252 && productSquareResult.boundingBox.top <= 260);
assert.ok(productSquareResult.boundingBox.width >= 495 && productSquareResult.boundingBox.width <= 506);
assert.ok(productSquareResult.boundingBox.height >= 136 && productSquareResult.boundingBox.height <= 146);
assert.ok(productSquareResult.finalWidth > productSquareResult.finalHeight * 3);
assertPreservedAspect(productSquareResult);

const productionLegacyUrl = "https://res.cloudinary.com/dobhntpan/image/upload/v1781961845/car-zone/logos/fiscal-logo-1781961845119-5c650659.webp";
assert.equal(resolveOfficialInvoiceLogoSrc(productionLegacyUrl), officialInvoiceLogoFallbackPath);
assert.equal(
  resolveOfficialInvoiceLogoSrc("https://res.cloudinary.com/dobhntpan/image/upload/v1779667712/car-zone/logos/fiscal-logo-1779667712816-e5d6974a.webp"),
  officialInvoiceLogoFallbackPath,
);
assert.equal(resolveOfficialInvoiceLogoSrc("/brand/car-zone-logo.jpeg"), officialInvoiceLogoFallbackPath);
assert.equal(resolveOfficialInvoiceLogoSrc(null), officialInvoiceLogoFallbackPath);
assert.equal(resolveOfficialInvoiceLogoSrc("  "), officialInvoiceLogoFallbackPath);
const newPanoramicUrl = "https://res.cloudinary.com/dobhntpan/image/upload/v2000000000/car-zone/logos/fiscal-logo-new.webp";
const customLogoUrl = "https://cdn.example.com/company/custom-logo.webp";
assert.equal(resolveOfficialInvoiceLogoSrc(newPanoramicUrl), newPanoramicUrl);
assert.equal(resolveOfficialInvoiceLogoSrc(customLogoUrl), customLogoUrl);

assert.equal(officialInvoiceLogoLayout.maxWidthMm, 100);
assert.equal(officialInvoiceLogoLayout.maxHeightMm, 32);
const localLogoMetadata = await sharp(fileURLToPath(new URL("../public/brand/car-zone-logo-nav.png", import.meta.url))).metadata();
const fittedRatio = Math.min(
  officialInvoiceLogoLayout.maxWidthMm / localLogoMetadata.width,
  officialInvoiceLogoLayout.maxHeightMm / localLogoMetadata.height,
);
const fittedWidth = localLogoMetadata.width * fittedRatio;
const fittedHeight = localLogoMetadata.height * fittedRatio;
assert.ok(fittedWidth >= 99.9 && fittedWidth <= 100);
assert.ok(fittedHeight >= 28 && fittedHeight <= 30);
assert.ok(officialInvoiceLogoLayout.pdfX + fittedWidth <= officialInvoiceLogoLayout.pdfInvoiceBoxX - officialInvoiceLogoLayout.pdfMinimumGap);

const htmlSource = await readFile(new URL("../src/utils/official-invoice-document.ts", import.meta.url), "utf8");
assert.match(htmlSource, /cz-official-logo-container/);
assert.match(htmlSource, /object-fit: contain/);
assert.doesNotMatch(htmlSource, /width: 128px/);
const pdfSource = await readFile(new URL("../src/utils/fiscal-invoice-pdf.ts", import.meta.url), "utf8");
assert.match(pdfSource, /containSize\(logoSize\.width, logoSize\.height, logoMaxWidth, logoMaxHeight\)/);
assert.doesNotMatch(pdfSource, /const logoMaxWidth = 68/);

const normalizationEvidenceDirectory = process.env.INVOICE_LOGO_NORMALIZATION_EVIDENCE_DIR?.trim();
if (normalizationEvidenceDirectory) {
  await mkdir(normalizationEvidenceDirectory, { recursive: true });
  const evidenceCases = [
    ["png-panoramico-transparente", panoramicResult],
    ["png-cuadrado-transparente", squareTransparentResult],
    ["webp-cuadrado-blanco", opaqueResults.find((entry) => entry.format === "webp").result],
    ["jpg-cuadrado-blanco", opaqueResults.find((entry) => entry.format === "jpeg").result],
    ["logo-ya-panoramico", alreadyCroppedResult],
    ["logo-productivo-controlado", productSquareResult],
  ];
  for (const [name, result] of evidenceCases) {
    await writeFile(new URL(`file:///${normalizationEvidenceDirectory.replaceAll("\\", "/")}/${name}.webp`), result.buffer);
  }
  const cards = evidenceCases.map(([name, result]) => `<figure><div><img src="${name}.webp" alt="${name}"></div><figcaption>${name}<br>${result.finalWidth} × ${result.finalHeight}; padding ${result.padding}px</figcaption></figure>`).join("");
  await writeFile(
    new URL(`file:///${normalizationEvidenceDirectory.replaceAll("\\", "/")}/index.html`),
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Arial,sans-serif;margin:24px;background:#eee}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px}figure{margin:0;background:#fff;padding:16px;border-radius:12px}figure div{height:180px;display:flex;align-items:center;justify-content:center;border:1px solid #ccc;background:#fff}img{display:block;max-width:100%;max-height:100%;object-fit:contain}figcaption{margin-top:10px;font-size:14px;line-height:1.4}</style></head><body><h1>Normalización de logos fiscales</h1><main>${cards}</main></body></html>`,
    "utf8",
  );
}

console.log(JSON.stringify({
  ok: true,
  productSquare: {
    original: `${productSquareResult.originalWidth}x${productSquareResult.originalHeight}`,
    boundingBox: productSquareResult.boundingBox,
    padding: productSquareResult.padding,
    normalized: `${productSquareResult.finalWidth}x${productSquareResult.finalHeight}`,
  },
  renderedLogoMm: { width: fittedWidth, height: fittedHeight },
  normalizationEvidenceDirectory: normalizationEvidenceDirectory ?? null,
}));
