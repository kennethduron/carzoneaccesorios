import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const officialLogo = await readFile(path.join(projectRoot, "public/brand/car-zone-logo-nav.png"));
const originalFetch = globalThis.fetch;
const failedLogoUrl = "https://assets.example.test/unavailable-logo.png";

globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url === "/brand/car-zone-logo-nav.png" || url === "https://assets.example.test/official-logo.png") {
    return new Response(officialLogo, { status: 200, headers: { "content-type": "image/png" } });
  }
  if (url === failedLogoUrl) return new Response("missing", { status: 404 });
  return originalFetch(input, init);
};

const { generateAdminReportPdf, ReportsPdfBrandingError } = await import("../src/utils/admin-reports-pdf.ts");
const generatedAt = "2026-08-02T16:30:00.000Z";
const columns = [
  "Cliente",
  "Pedido",
  "Total original",
  "Total abonado",
  "Saldo pendiente",
  "Estado",
  "Fecha de vencimiento",
  "Método de abono",
  "Referencia",
  "Fecha de abono",
  "Monto de abono",
];

function modernRow(index = 1) {
  return [
    `Cliente moderno ${index}`,
    `CZ-260802-${String(index).padStart(4, "0")}`,
    "L 1,000.00",
    "L 400.00",
    "L 600.00",
    "Pago parcial",
    "31/8/2026",
    "Efectivo",
    `REC-${index}`,
    "2/8/2026",
    "L 400.00",
  ];
}

function historicalRow(index = 1) {
  return [
    `Cliente histórico ${index}`,
    "Cuenta histórica",
    "L 2,500.00",
    "L 500.00",
    "L 2,000.00",
    "Pago parcial",
    "31/8/2026",
    "Transferencia",
    `CXC-HIST-${index}`,
    "2/8/2026",
    "L 500.00",
  ];
}

function input(rows, overrides = {}) {
  return {
    reportKey: "creditReceivablePayments",
    reportLabel: "Cobranza de crédito comercial",
    columns,
    rows,
    startDate: "2026-08-01",
    endDate: "2026-08-02",
    logoUrl: null,
    generatedAt,
    ...overrides,
  };
}

function pageContent(doc, pageNumber) {
  return doc.internal.pages[pageNumber].join("\n");
}

function assertPageBranding(doc, pageNumber, pageCount) {
  const content = pageContent(doc, pageNumber);
  assert.match(content, /Car Zone Accesorios/, `página ${pageNumber}: falta nombre comercial`);
  assert.match(content, /Reporte de abonos de cuentas por cobrar/, `página ${pageNumber}: falta título`);
  assert.match(content, /Generado:/, `página ${pageNumber}: falta fecha de generación`);
  assert.match(content, new RegExp(`P.gina ${pageNumber} de ${pageCount}`), `página ${pageNumber}: pie incorrecto`);
  const logoDraws = content.match(/\/I\d+ Do/g) ?? [];
  assert.equal(logoDraws.length, 1, `página ${pageNumber}: debe contener exactamente un logo`);
}

function pdfBuffer(doc) {
  return Buffer.from(doc.output("arraybuffer"));
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

const onePage = await generateAdminReportPdf(input([modernRow(), historicalRow()]));
assert.equal(onePage.metadata.pageCount, 1);
assert.equal(onePage.metadata.rowCount, 2);
assert.equal(onePage.metadata.orientation, "landscape");
assert.equal(onePage.metadata.logoSource, "/brand/car-zone-logo-nav.png");
assertPageBranding(onePage.doc, 1, 1);
assert.match(pageContent(onePage.doc, 1), /CZ-260802-0001/);
assert.match(pageContent(onePage.doc, 1), /Cuenta hist/);
assert.match(pageContent(onePage.doc, 1), /L 1,000.00/);
assert.match(pageContent(onePage.doc, 1), /L 2,500.00/);

const manyRows = Array.from({ length: 72 }, (_, index) =>
  index % 2 === 0 ? modernRow(index + 1) : historicalRow(index + 1),
);
const multiplePages = await generateAdminReportPdf(
  input(manyRows, { logoUrl: "https://assets.example.test/official-logo.png" }),
);
assert.ok(multiplePages.metadata.pageCount >= 2, "el fixture debe producir varias páginas");
assert.equal(multiplePages.metadata.rowCount, manyRows.length);
assert.equal(multiplePages.metadata.logoSource, "https://assets.example.test/official-logo.png");
for (let page = 1; page <= multiplePages.metadata.pageCount; page += 1) {
  assertPageBranding(multiplePages.doc, page, multiplePages.metadata.pageCount);
  assert.match(pageContent(multiplePages.doc, page), /Cliente/, `página ${page}: falta encabezado de tabla`);
}
assert.match(pageContent(multiplePages.doc, multiplePages.metadata.pageCount), /CXC-HIST-72/);

await assert.rejects(
  generateAdminReportPdf(input([modernRow()], { logoUrl: failedLogoUrl })),
  (error) => error instanceof ReportsPdfBrandingError && /logo oficial/.test(error.message),
);

const outputDirectory = process.env.REPORTS_PDF_EVIDENCE_DIR?.trim();
const artifacts = [];
if (outputDirectory) {
  await mkdir(outputDirectory, { recursive: true });
  for (const [name, result] of [["reports-one-page", onePage], ["reports-multiple-pages", multiplePages]]) {
    const buffer = pdfBuffer(result.doc);
    const filePath = path.join(outputDirectory, `${name}.pdf`);
    await writeFile(filePath, buffer);
    artifacts.push({
      file: filePath,
      sha256: sha256(buffer),
      size: buffer.length,
      pages: result.metadata.pageCount,
      rows: result.metadata.rowCount,
      orientation: result.metadata.orientation,
      logoSource: result.metadata.logoSource,
    });
  }
  await writeFile(path.join(outputDirectory, "manifest.json"), JSON.stringify(artifacts, null, 2), "utf8");
}

console.log(JSON.stringify({ ok: true, onePage: onePage.metadata, multiplePages: multiplePages.metadata, artifacts }));
