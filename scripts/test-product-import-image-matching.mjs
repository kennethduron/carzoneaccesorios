import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import {
  createProductImportImageCandidate,
  createProductImportImageIndex,
  matchProductImportImage,
  validateProductImportZipPath,
} from "../src/utils/product-import-image-matching.ts";

function candidate(path) {
  const result = createProductImportImageCandidate(path, { path }, 128, "image/test");
  assert.equal(result.ok, true, `Expected safe image path: ${path}`);
  return result.image;
}

function match({ imageName = "", sku = "SKU-NO-MATCH", paths }) {
  return matchProductImportImage(imageName, sku, createProductImportImageIndex(paths.map(candidate)));
}

const cases = [
  ["nombre sin extensión + jpg", match({ imageName: "toyota yaris 14-17", paths: ["toyota yaris 14-17.jpg"] })?.image.path, "toyota yaris 14-17.jpg"],
  ["nombre sin extensión + png", match({ imageName: "toyota yaris 14-17", paths: ["toyota yaris 14-17.png"] })?.image.path, "toyota yaris 14-17.png"],
  ["extensión exacta", match({ imageName: "toyota yaris 14-17.jpg", paths: ["toyota yaris 14-17.jpg"] })?.method, "nombre exacto con extensión"],
  ["mayúsculas diferentes", match({ imageName: "TOYOTA YARIS 14-17", paths: ["toyota-yaris-14-17.JPG"] })?.image.path, "toyota-yaris-14-17.JPG"],
  ["acento equivalente", match({ imageName: "Cámara Reversa Universal", paths: ["Camara Reversa Universal.jpeg"] })?.image.path, "Camara Reversa Universal.jpeg"],
  ["espacio y guion equivalentes", match({ imageName: "carro blanco", paths: ["carro-blanco.webp"] })?.image.path, "carro-blanco.webp"],
  ["espacio y underscore equivalentes", match({ imageName: "carro blanco", paths: ["carro_blanco.webp"] })?.image.path, "carro_blanco.webp"],
  ["subcarpeta", match({ imageName: "toyota yaris 14-17", paths: ["imagenes/toyota yaris 14-17.jpg"] })?.method, "nombre exacto sin extensión + subcarpeta"],
  ["doble subcarpeta", match({ imageName: "toyota yaris 14-17", paths: ["test/test/toyota yaris 14-17.png"] })?.image.path, "test/test/toyota yaris 14-17.png"],
  ["fallback por SKU", match({ sku: "ACCU075066", paths: ["imagenes/accu075066.webp"] })?.method, "SKU exacto + subcarpeta"],
  ["imagen faltante", match({ imageName: "imagen ausente", paths: ["otra-imagen.jpg"] }), null],
];

for (const [label, actual, expected] of cases) {
  assert.equal(actual, expected, label);
}

const ambiguous = match({
  imageName: "toyota yaris",
  paths: ["carpeta/toyota yaris.png", "toyota yaris.jpg"],
});
assert.equal(ambiguous?.image.path, "toyota yaris.jpg", "ambigua usa coincidencia más cercana");
assert.match(ambiguous?.warning ?? "", /más de una imagen posible/, "ambigua muestra advertencia");

assert.equal(validateProductImportZipPath("imagenes/producto.svg").ok, false, "rechaza formato no permitido");
assert.equal(validateProductImportZipPath("../producto.jpg").ok, false, "bloquea path traversal");
assert.equal(validateProductImportZipPath("imagenes/!!!.jpg").ok, false, "bloquea nombre peligroso");

const workbook = new ExcelJS.Workbook();
const worksheet = workbook.addWorksheet("Productos");
worksheet.addRow(["SKU", "Nombre de imagen"]);
worksheet.addRow(["ACCU075066", "Luz de día Toyota Yaris 2015-2018"]);
const excelBuffer = await workbook.xlsx.writeBuffer();
const loadedWorkbook = new ExcelJS.Workbook();
await loadedWorkbook.xlsx.load(excelBuffer);

const zip = new JSZip();
zip.file("productos/luces/Luz-de-dia_Toyota-Yaris-2015-2018.PNG", Buffer.from("imagen"));
const loadedZip = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer" }));
const zipCandidates = [];
for (const entry of Object.values(loadedZip.files)) {
  if (entry.dir) continue;
  const fileBuffer = await entry.async("nodebuffer");
  const result = createProductImportImageCandidate(entry.name, fileBuffer, fileBuffer.length, "image/png");
  assert.equal(result.ok, true, "ZIP real indexado");
  zipCandidates.push(result.image);
}

const excelImageName = loadedWorkbook.worksheets[0].getCell(2, 2).text;
const integrationMatch = matchProductImportImage(excelImageName, "ACCU075066", createProductImportImageIndex(zipCandidates));
assert.equal(integrationMatch?.image.path, "productos/luces/Luz-de-dia_Toyota-Yaris-2015-2018.PNG", "Excel + ZIP real");

console.log("Product import image matching: 14 casos correctos.");
