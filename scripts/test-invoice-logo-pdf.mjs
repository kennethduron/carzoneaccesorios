import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const panoramicLogo = await readFile(path.join(projectRoot, "public/brand/car-zone-logo-nav.png"));
const squareLogo = await readFile(path.join(projectRoot, "public/brand/car-zone-logo.jpeg"));
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.endsWith("/brand/car-zone-logo-nav.png")) {
    return new Response(panoramicLogo, { status: 200, headers: { "content-type": "image/png" } });
  }
  if (url.endsWith("/brand/car-zone-logo.jpeg")) {
    return new Response(squareLogo, { status: 200, headers: { "content-type": "image/jpeg" } });
  }
  return originalFetch(input, init);
};

const [{ generateFiscalInvoicePdf }, { buildOfficialInvoiceHtml, officialInvoiceCss }] = await Promise.all([
  import("../src/utils/fiscal-invoice-pdf.ts"),
  import("../src/utils/official-invoice-document.ts"),
]);

const legacyLogoUrl = "https://res.cloudinary.com/dobhntpan/image/upload/v1781961845/car-zone/logos/fiscal-logo-1781961845119-5c650659.webp";
const customLogoDataUrl = `data:image/png;base64,${panoramicLogo.toString("base64")}`;
const pointsPerMm = 72 / 25.4;

function imagePlacement(pdf) {
  const content = pdf.toString("latin1");
  const match = /([0-9.-]+) 0 0 ([0-9.-]+) ([0-9.-]+) ([0-9.-]+) cm\s*\/I\d+ Do/.exec(content);
  assert.ok(match, "El PDF debe contener el logo como imagen");
  const width = Number(match[1]) / pointsPerMm;
  const height = Number(match[2]) / pointsPerMm;
  const x = Number(match[3]) / pointsPerMm;
  const y = 297 - Number(match[4]) / pointsPerMm - height;
  return { x, y, width, height };
}

function item(index) {
  const quantity = index % 3 === 0 ? 2 : 1;
  const unitPrice = 295 + index * 17;
  return {
    sku: `CZ-${String(index).padStart(4, "0")}`,
    name: `Accesorio automotriz de prueba controlada ${index}`,
    quantity,
    unitPrice,
    lineTotal: quantity * unitPrice,
  };
}

function invoice(overrides = {}) {
  const items = overrides.items ?? [item(1)];
  const subtotal = items.reduce((sum, current) => sum + current.lineTotal, 0);
  const tax = Math.round(subtotal * 0.15 * 100) / 100;
  return {
    invoiceNumber: "000-001-01-00000001",
    orderNumber: "PED-LOGO-READONLY",
    status: "emitida",
    issuedAt: "2026-07-27T12:00:00.000Z",
    invoiceDate: "2026-07-27",
    dueAt: null,
    createdAt: "2026-07-27T12:00:00.000Z",
    companyLegalName: "CAR ZONE ACCESORIOS S. DE R.L. DE C.V.",
    companyRtn: "08019000000000",
    companyAddress: "Tegucigalpa, Francisco Morazan, Honduras",
    companyPhone: "+504 0000-0000",
    companyEmail: "facturacion@example.test",
    companyLogoUrl: legacyLogoUrl,
    cai: "000000-000000-000000-000000-00",
    fiscalRangeStart: "000-001-01-00000001",
    fiscalRangeEnd: "000-001-01-00000100",
    caiAuthorizationDate: "2026-01-01",
    fiscalDeadline: "2026-12-31",
    customerName: "Cliente de prueba local",
    customerRtn: "08011999000000",
    customerEmail: "cliente@example.test",
    customerPhone: "+504 9999-9999",
    customerAddress: "Colonia de prueba, Tegucigalpa",
    paymentMethod: "cash",
    paymentStatus: "paid",
    paymentReference: null,
    subtotal,
    tax,
    shippingFee: 0,
    cashOnDeliveryFee: 0,
    smallOrderFee: 0,
    discountTotal: 0,
    additionalFees: [],
    total: subtotal + tax,
    items,
    notes: "Documento local controlado; no corresponde a una factura real.",
    ...overrides,
  };
}

function fullHtml(documentHtml, title, extraCss = "") {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>${title}</title><style>html,body{margin:0}${officialInvoiceCss}${extraCss}</style></head><body><main class="cz-official-invoice-host">${documentHtml}</main></body></html>`;
}

const cases = [
  ["invoice-one-legacy", invoice()],
  ["invoice-many-legacy", invoice({ items: Array.from({ length: 14 }, (_, index) => item(index + 1)) })],
  ["invoice-long-address", invoice({ customerAddress: "Residencial de prueba, bloque 123, avenida extremadamente larga para validar saltos de linea, Tegucigalpa, Francisco Morazan, Honduras" })],
  ["invoice-long-fiscal", invoice({ companyLegalName: "CAR ZONE ACCESORIOS SOCIEDAD DE RESPONSABILIDAD LIMITADA DE CAPITAL VARIABLE", companyAddress: "Boulevard de prueba, edificio corporativo, local 123, Tegucigalpa, Francisco Morazan, Honduras" })],
  ["invoice-no-rtn", invoice({ customerRtn: null })],
  ["invoice-no-logo-fallback", invoice({ companyLogoUrl: null })],
  ["invoice-custom-panorama", invoice({ companyLogoUrl: customLogoDataUrl })],
];

const outputDirectory = process.env.INVOICE_LOGO_EVIDENCE_DIR?.trim();
if (outputDirectory) await mkdir(outputDirectory, { recursive: true });
const caseResults = [];

for (const [name, currentInvoice] of cases) {
  const pdfDocument = await generateFiscalInvoicePdf(currentInvoice);
  const pageCount = pdfDocument.getNumberOfPages();
  const pdf = Buffer.from(pdfDocument.output("arraybuffer"));
  assert.equal(pdf.subarray(0, 4).toString("ascii"), "%PDF");
  assert.ok(pdf.length > 10_000, `${name}: PDF inesperadamente pequeno`);
  if (name !== "invoice-many-legacy") assert.equal(pageCount, 1, `${name}: debe conservar una pagina`);
  assert.ok(pageCount >= 1 && pageCount <= 2, `${name}: numero de paginas inesperado`);
  const placement = imagePlacement(pdf);
  assert.ok(Math.abs(placement.x - 12) < 0.01);
  assert.ok(Math.abs(placement.y - 14) < 0.01);
  assert.ok(placement.width >= 99.9 && placement.width <= 100.01);
  assert.ok(placement.height >= 28 && placement.height <= 30);
  assert.ok(placement.x + placement.width <= 120);
  caseResults.push({ name, pageCount, placement });

  const html = fullHtml(buildOfficialInvoiceHtml(currentInvoice), name);
  assert.match(html, /cz-official-logo-container/);
  assert.match(html, /\/brand\/car-zone-logo-nav\.png|data:image\/png/);

  if (outputDirectory) {
    await writeFile(path.join(outputDirectory, `${name}.pdf`), pdf);
    await writeFile(path.join(outputDirectory, `${name}.html`), html, "utf8");
  }
}

const beforeInvoice = invoice();
const afterDocument = buildOfficialInvoiceHtml(beforeInvoice);
const beforeDocument = afterDocument.replace("/brand/car-zone-logo-nav.png", "/brand/car-zone-logo.jpeg");
const beforeCss = `
  .cz-official-logo-container { width: 68mm; max-width: 68mm; height: 30mm; max-height: 30mm; margin: 5mm 0 17mm 7mm; }
  @media screen and (max-width: 820px) {
    .cz-official-logo-container { width: 128px; max-width: 128px; height: 64px; max-height: 64px; margin: 0 0 12px; }
  }
`;
const modalCss = `body { background: #202124; padding: 24px; } .test-modal { max-height: calc(100vh - 48px); overflow: auto; background: white; border-radius: 12px; }`;

if (outputDirectory) {
  await writeFile(path.join(outputDirectory, "invoice-before.html"), fullHtml(beforeDocument, "Antes", beforeCss), "utf8");
  await writeFile(path.join(outputDirectory, "invoice-after.html"), fullHtml(afterDocument, "Despues"), "utf8");
  await writeFile(
    path.join(outputDirectory, "invoice-modal.html"),
    fullHtml(`<div class="test-modal">${afterDocument}</div>`, "Modal", modalCss),
    "utf8",
  );
  await writeFile(path.join(outputDirectory, "invoice-portal.html"), fullHtml(afterDocument, "Portal del cliente"), "utf8");
}

console.log(JSON.stringify({ ok: true, cases: caseResults, outputDirectory: outputDirectory ?? null }));
