import assert from "node:assert/strict";
import sharp from "sharp";

assert.equal(process.platform, "linux", "this parity test must run on Linux");
assert.equal(process.arch, "x64", "this parity test must run on x64");

const source = sharp({
  create: {
    width: 120,
    height: 80,
    channels: 3,
    background: { r: 228, g: 37, b: 44 },
  },
});

for (const format of ["jpeg", "png", "webp"]) {
  const encoded = await source.clone()[format]().toBuffer();
  const metadata = await sharp(encoded).metadata();
  assert.equal(metadata.format, format);
  assert.equal(metadata.width, 120);
  assert.equal(metadata.height, 80);
}

const oriented = await source.clone().jpeg().withMetadata({ orientation: 6 }).toBuffer();
const transformed = await sharp(oriented, { limitInputPixels: 3_000_001 })
  .rotate()
  .resize({ width: 64, height: 64, fit: "inside", withoutEnlargement: true })
  .webp({ quality: 82, effort: 5 })
  .toBuffer();
const output = await sharp(transformed).metadata();
assert.equal(output.format, "webp");
assert.ok(output.width <= 64 && output.height <= 64);
assert.equal(output.orientation, undefined, "orientation must be normalized and metadata stripped");
assert.equal(output.exif, undefined, "EXIF metadata must not survive the processing contract");

console.log(JSON.stringify({
  result: "PRODUCT_SHARP_LINUX_PASS",
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  sharp: sharp.versions.sharp,
  vips: sharp.versions.vips,
}));
