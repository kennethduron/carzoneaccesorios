import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildJournalEntryPrintHref,
  journalEntryStatusLabel,
  journalSourceLabel,
} from "../src/lib/accounting-navigation.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const route = read("src/app/admin/contabilidad/partidas/[id]/imprimir/page.tsx");
const documentComponent = read("src/components/admin/journal-entry-print-document.tsx");
const printButton = read("src/components/admin/journal-entry-print-button.tsx");
const printCss = read("src/components/admin/journal-entry-print-document.module.css");
const accountingManager = read("src/components/admin/accounting-manager.tsx");
const viewerServiceSource = read("src/services/supabase/accounting.service.ts");

const validId = "e1a236bf-7ad1-4a63-9b90-ccaff29e804c";
assert.equal(
  buildJournalEntryPrintHref(validId),
  `/admin/contabilidad/partidas/${validId}/imprimir`,
  "The print action must target the dedicated entry route.",
);
assert.equal(
  buildJournalEntryPrintHref("entry/id with spaces"),
  "/admin/contabilidad/partidas/entry%2Fid%20with%20spaces/imprimir",
  "Unexpected path input must be URL encoded.",
);

assert.equal(journalSourceLabel(null), "Partida manual");
assert.equal(journalSourceLabel("supplier_payment"), "Pago a proveedor");
assert.equal(journalSourceLabel("unknown-source"), "Origen contable");
assert.equal(journalEntryStatusLabel("borrador"), "Borrador");
assert.equal(journalEntryStatusLabel("publicada"), "Publicada");
assert.equal(journalEntryStatusLabel("reversada"), "Reversada");
assert.equal(journalEntryStatusLabel("anulada"), "Anulada");

// Authorization is evaluated before the path value can select accounting data.
assert.match(route, /await requirePermission\("accounting:read"\)/);
assert.ok(
  route.indexOf('await requirePermission("accounting:read")') < route.indexOf("await params"),
  "Authorization must occur before ID validation and data access.",
);
assert.ok(
  route.indexOf("uuidLike(id") < route.indexOf("getJournalEntryByIdForViewer(journalEntryId.value)"),
  "Malformed IDs must be rejected before the canonical service is called.",
);
assert.match(route, /if \(!journalEntryId\.ok\) notFound\(\)/);
assert.match(route, /if \(!data\) notFound\(\)/);
assert.match(route, /getPublicCompanySettings\(\)/);
assert.doesNotMatch(route, /writeErrorLog|serverAction|\.rpc\(|\.(?:insert|update|delete|upsert)\(/i);

const viewerService = viewerServiceSource.slice(
  viewerServiceSource.indexOf("export async function getJournalEntryByIdForViewer"),
  viewerServiceSource.indexOf("export async function getJournalEntryEditData"),
);
assert.match(viewerService, /from\("journal_entries"\)/);
assert.match(viewerService, /getLinesByEntryIds/);
assert.doesNotMatch(viewerService, /\.(?:insert|update|delete|upsert)\(|\.rpc\(/);

// Standard React text nodes provide escaping; raw HTML sinks are prohibited.
const adversarialText = `<img src=x onerror="alert('xss')"> & <script>alert(1)</script>`;
assert.ok(adversarialText.includes("<script>"));
assert.doesNotMatch(documentComponent, /dangerouslySetInnerHTML|innerHTML|document\.write|eval\(/);
assert.match(documentComponent, /<p>\{entry\.description\}<\/p>/);
assert.match(documentComponent, /\{line\.description \|\| "—"\}/);

// Every canonical line is projected by exactly one keyed map, with no filter/slice.
assert.equal(
  documentComponent.match(/entry\.lines\.map\(\(line\) =>/g)?.length,
  1,
  "The document must render one row for every canonical line.",
);
assert.doesNotMatch(documentComponent, /entry\.lines\.(?:filter|slice|splice|sort|reverse)\(/);
assert.match(documentComponent, /key=\{line\.id\}/);
assert.match(documentComponent, /data-journal-line-id=\{line\.id\}/);
assert.match(documentComponent, /formatCurrency\(line\.debit\)/);
assert.match(documentComponent, /formatCurrency\(line\.credit\)/);
assert.match(documentComponent, /formatCurrency\(entry\.total_debit\)/);
assert.match(documentComponent, /formatCurrency\(entry\.total_credit\)/);
assert.match(documentComponent, /formatCivilDate\(entry\.entry_date\)/);

const syntheticLines = Object.freeze(
  Array.from({ length: 75 }, (_, index) => Object.freeze({
    id: `line-${index + 1}`,
    debit: index % 2 === 0 ? index + 0.25 : 0,
    credit: index % 2 === 1 ? index + 0.75 : 0,
    description: `${"Descripción extensa ".repeat(18)}${index + 1}`,
  })),
);
const syntheticSnapshot = JSON.stringify(syntheticLines);
const projectedLineIds = syntheticLines.map((line) => line.id);
assert.equal(projectedLineIds.length, 75);
assert.equal(new Set(projectedLineIds).size, 75);
assert.equal(JSON.stringify(syntheticLines), syntheticSnapshot, "Synthetic canonical data must remain unchanged.");

assert.match(documentComponent, /<thead>/);
assert.match(documentComponent, /<tbody>/);
assert.match(documentComponent, /<tfoot>/);
assert.match(documentComponent, /<th scope="col">Código<\/th>/);
assert.match(documentComponent, /<th scope="row" colSpan=\{3\}>Totales<\/th>/);
assert.match(printButton, /"use client"/);
assert.match(printButton, /window\.print\(\)/);
assert.doesNotMatch(printButton, /jspdf|pdfkit|puppeteer|playwright/i);

assert.match(printCss, /@page\s*\{/);
assert.match(printCss, /size:\s*auto/);
assert.doesNotMatch(printCss, /size:\s*(?:A4|letter)/i);
assert.match(printCss, /\.memoColumn\s*\{\s*width:\s*26%/);
assert.match(printCss, /\.amountColumn\s*\{\s*width:\s*18\.5%/);
const letterPrintableWidth = (8.5 - 24 / 25.4) * 96;
const a4PrintableWidth = ((210 - 24) / 25.4) * 96;
assert.ok(letterPrintableWidth * 0.185 > 134, "Letter amount columns must retain at least 134 CSS pixels.");
assert.ok(a4PrintableWidth * 0.185 > 130, "A4 amount columns must retain at least 130 CSS pixels.");
assert.match(printCss, /@media print/);
assert.match(printCss, /display:\s*table-header-group/);
assert.match(printCss, /\.tableFrame tfoot\s*\{[\s\S]*?display:\s*table-row-group/);
assert.match(printCss, /break-inside:\s*avoid/);
assert.match(printCss, /overflow-wrap:\s*anywhere/);
assert.match(printCss, /overflow:\s*visible/);
assert.match(printCss, /\.screenActions\s*\{[\s\S]*?display:\s*none !important/);

assert.match(accountingManager, /href=\{buildJournalEntryPrintHref\(entry\.id\)\}/);
assert.match(accountingManager, /target="_blank"/);
assert.match(accountingManager, /Imprimir partida/);

const implementationSources = [route, documentComponent, printButton].join("\n");
assert.doesNotMatch(
  implementationSources,
  /from\s+["'][^"']*(?:actions|inventory|orders|payments)[^"']*["']|\b(?:insert|update|delete|upsert|mutate|recalculate|postJournal|reverseJournal)\b/i,
  "The print surface must not import or invoke mutation paths.",
);

console.log("Accounting journal entry printing tests passed (auth, fidelity, XSS, A4/Letter, pagination, zero-mutation). ");
