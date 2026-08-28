import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";

function findFiles(directory, suffix, matches = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) findFiles(path, suffix, matches);
    else if (path.replaceAll(sep, "/").endsWith(suffix)) matches.push(path);
  }
  return matches;
}

const traceSuffix = "/server/app/api/admin/productos/images/upload/route.js.nft.json";
const traces = findFiles(resolve(".next"), traceSuffix);
assert.equal(traces.length, 1, `expected one upload route trace, found ${traces.length}`);

const tracePath = traces[0];
const trace = JSON.parse(readFileSync(tracePath, "utf8"));
const files = Array.isArray(trace.files) ? trace.files : [];
const normalizedFiles = files.map((file) => String(file).replaceAll("\\", "/"));
const libvipsSuffix = "node_modules/@img/sharp-libvips-linux-x64/lib/libvips-cpp.so.8.18.3";
const libvipsEntry = normalizedFiles.find((file) => file.endsWith(libvipsSuffix));
assert.ok(libvipsEntry, `${libvipsSuffix} is missing from the upload route trace`);

const packageEntries = normalizedFiles.filter((file) => file.includes("node_modules/@img/sharp-libvips-linux-x64/"));
assert.ok(packageEntries.length >= 2, "the traced libvips package resources are incomplete");
for (const entry of packageEntries) {
  assert.ok(existsSync(normalize(resolve(dirname(tracePath), entry))), `traced resource is absent: ${entry}`);
}

const nativeEntry = normalizedFiles.find((file) =>
  /node_modules\/@img\/sharp-linux-x64\/lib\/sharp-linux-x64(?:-[^/]+)?\.node$/.test(file),
);
assert.ok(nativeEntry, "the Linux x64 Sharp native .node binary is missing from the upload route trace");
assert.ok(existsSync(resolve(dirname(tracePath), nativeEntry)));

console.log(JSON.stringify({
  result: "PRODUCT_IMAGE_ROUTE_TRACE_PASS",
  tracePath,
  libvips: libvipsEntry,
  libvipsPackageEntries: packageEntries.length,
  nativeBinary: nativeEntry,
}));
