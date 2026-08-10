import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { jsPDF } from "jspdf";

globalThis.fetch = async () => new Response(null, { status: 404 });

const [
  { generateFiscalInvoicePdf, getFiscalInvoiceCustomerLayout },
  { getOfficialInvoiceTotals, summaryRows },
] = await Promise.all([
  import("../src/utils/fiscal-invoice-pdf.ts"),
  import("../src/utils/official-invoice-document.ts"),
]);

function item(index) {
  const quantity = index % 3 === 0 ? 2 : 1;
  const unitPrice = 100 + index * 7;
  return {
    sku: `PDF-${String(index).padStart(3, "0")}`,
    name: `Producto sintético local ${index}`,
    quantity,
    unitPrice,
    lineTotal: quantity * unitPrice,
  };
}

function exactLength(seed, length) {
  const repeated = `${seed} `.repeat(Math.ceil(length / (seed.length + 1)) + 1);
  return repeated.slice(0, length).trimEnd().padEnd(length, "X");
}

function invoice(overrides = {}) {
  const items = overrides.items ?? [item(1)];
  const subtotal = items.reduce((sum, current) => sum + current.lineTotal, 0);
  const tax = Math.round(subtotal * 0.15 * 100) / 100;
  return {
    invoiceNumber: "INVOICE-PDF-LONG-ADDRESS-LOCAL-ONLY",
    orderNumber: "ORDER-PDF-LONG-ADDRESS-LOCAL-ONLY",
    status: "emitida",
    issuedAt: "2026-08-09T12:00:00.000Z",
    invoiceDate: "2026-08-09",
    dueAt: null,
    createdAt: "2026-08-09T12:00:00.000Z",
    companyLegalName: "CAR ZONE ACCESORIOS S. DE R.L. DE C.V.",
    companyRtn: "08019000000000",
    companyAddress: "Tegucigalpa, Francisco Morazán, Honduras",
    companyPhone: "+504 0000-0000",
    companyEmail: "facturacion@example.test",
    companyLogoUrl: null,
    cai: "000000-000000-000000-000000-00",
    fiscalRangeStart: "000-001-01-00000001",
    fiscalRangeEnd: "000-001-01-00000999",
    caiAuthorizationDate: "2026-01-01",
    fiscalDeadline: "2026-12-31",
    customerName: "Cliente PDF sintético local",
    customerRtn: "08011999000000",
    customerEmail: "cliente@example.test",
    customerPhone: "+504 9999-9999",
    customerAddress: "Col. Trejo, casa 15",
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
    notes: "Fixture local aislado; no corresponde a una factura real.",
    ...overrides,
  };
}

const specialSeed = "Residencial Peña Blanca, 3.ª avenida, bloque #4, casa 27, San Pedro Sula, Cortés, frente al portón principal, km 12.5, sector norte-sur";
const cases = [
  ["short", invoice()],
  ["address-130", invoice({ customerAddress: exactLength(specialSeed, 130) })],
  ["address-250", invoice({ customerAddress: exactLength(specialSeed, 250) })],
  ["address-500", invoice({ customerAddress: exactLength(specialSeed, 500) })],
  ["address-word-break-500", invoice({ customerAddress: `INICIO${"A".repeat(487)}FIN-500` })],
  ["empty", invoice({ customerAddress: null })],
  ["no-rtn", invoice({ customerRtn: null })],
  ["many-products", invoice({ customerAddress: exactLength(specialSeed, 500), items: Array.from({ length: 45 }, (_, index) => item(index + 1)) })],
];

const outputDirectory = path.resolve(process.env.INVOICE_LONG_ADDRESS_EVIDENCE_DIR || "tmp/pdfs/invoice-long-address/current");
await mkdir(outputDirectory, { recursive: true });

const results = [];
for (const [name, fixture] of cases) {
  const measurementDocument = new jsPDF();
  measurementDocument.setFont("helvetica", "normal");
  measurementDocument.setFontSize(7.5);
  const layout = getFiscalInvoiceCustomerLayout(measurementDocument, fixture.customerAddress, 126);
  assert.equal(layout.addressWidth, 165, `${name}: debe usar el ancho real disponible del template`);
  assert.ok(layout.addressLines.every((line) => measurementDocument.getTextWidth(line) <= layout.addressWidth + 0.01), `${name}: ninguna línea puede exceder el margen derecho`);
  assert.equal(layout.nextY, 134 + (layout.addressLines.length - 1) * layout.lineHeight, `${name}: el cursor debe crecer con cada línea`);
  if (name === "short" || name === "empty") assert.equal(layout.addressLines.length, 1, `${name}: no debe agregar líneas innecesarias`);
  if (name === "address-250") assert.ok(layout.addressLines.length >= 2, "250 caracteres deben envolver en varias líneas");
  if (name === "address-500" || name === "address-word-break-500" || name === "many-products") assert.ok(layout.addressLines.length >= 3, `${name}: 500 caracteres deben envolver en varias líneas`);
  if (name === "empty") assert.deepEqual(layout.addressLines, ["-"], "una dirección vacía conserva el placeholder vigente");

  const before = structuredClone(fixture);
  const pdfDocument = await generateFiscalInvoicePdf(fixture);
  assert.deepEqual(fixture, before, `${name}: generar el PDF no debe mutar los datos documentales`);
  const pageCommands = pdfDocument.internal.pages.flat().join("\n");
  assert.match(pageCommands, new RegExp(fixture.customerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${name}: conserva el nombre del cliente`);
  assert.match(pageCommands, new RegExp((fixture.customerRtn || "-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${name}: conserva el RTN`);
  for (const product of fixture.items) {
    assert.match(pageCommands, new RegExp(product.sku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${name}: conserva el SKU ${product.sku}`);
    assert.match(pageCommands, new RegExp(product.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${name}: conserva el producto ${product.name}`);
  }
  for (const row of summaryRows(getOfficialInvoiceTotals(fixture))) {
    assert.match(pageCommands, new RegExp(row.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${name}: conserva ${row.label}`);
    const numericValue = row.value.replace(/[^0-9.,-]/g, "");
    assert.match(pageCommands, new RegExp(numericValue.replace(/[.,-]/g, "\\$&")), `${name}: conserva el valor de ${row.label}`);
  }
  const pdf = Buffer.from(pdfDocument.output("arraybuffer"));
  assert.equal(pdf.subarray(0, 4).toString("ascii"), "%PDF");
  assert.ok(pdf.length > 5_000, `${name}: PDF inesperadamente pequeño`);
  await writeFile(path.join(outputDirectory, `${name}.pdf`), pdf);
  if (name === "many-products") assert.ok(pdfDocument.getNumberOfPages() >= 2, "la factura con muchos productos debe conservar paginación");
  else assert.equal(pdfDocument.getNumberOfPages(), 1, `${name}: debe caber en una página`);
  results.push({ name, pageCount: pdfDocument.getNumberOfPages(), bytes: pdf.length, addressLines: layout.addressLines.length, tableStartY: layout.nextY });
}

const [mapperSource, pdfSource, adminRoute, customerRoute] = await Promise.all([
  readFile(new URL("../src/utils/invoice-document-mappers.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/utils/fiscal-invoice-pdf.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/app/api/admin/facturas/[invoiceId]/pdf/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/app/api/cuenta/facturas/[invoiceId]/pdf/route.ts", import.meta.url), "utf8"),
]);
assert.match(mapperSource, /customerAddress: invoice\.customer_address/, "admin conserva invoices.customer_address");
assert.match(mapperSource, /customerAddress: invoice\.customerAddress/, "portal conserva su snapshot documental mapeado");
assert.match(pdfSource, /startY: itemsStartY/, "la tabla usa el cursor dinámico del bloque del cliente");
assert.doesNotMatch(pdfSource, /customerAddress[^\n]*\.slice\(/, "la dirección no se trunca");
assert.match(adminRoute, /buildInvoicePdfResponse\(adminInvoiceToOfficialInvoice\(invoice\), disposition\)/, "PDF admin conserva el generador canónico");
assert.match(customerRoute, /buildInvoicePdfResponse\(storeInvoiceToOfficialInvoice\(invoice\), disposition\)/, "PDF de cuenta conserva el generador canónico");

console.log(JSON.stringify({ ok: true, outputDirectory, results }));
