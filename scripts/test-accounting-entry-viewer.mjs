import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildJournalEntryViewerHref, normalizeFinancialCenterTab } from "../src/lib/accounting-navigation.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const page = read("src/app/admin/contabilidad/page.tsx");
const center = read("src/components/admin/financial-center-manager.tsx");
const manager = read("src/components/admin/accounting-manager.tsx");
const overlay = read("src/components/navigation-loading-overlay.tsx");
const service = read("src/services/supabase/accounting.service.ts");
const traceability = read("src/services/supabase/accounting-traceability.service.ts");

const journalEntryId = "e1a236bf-7ad1-4a63-9b90-ccaff29e804c";
assert.equal(
  buildJournalEntryViewerHref(journalEntryId),
  `/admin/contabilidad?tab=journal&partida=${journalEntryId}`,
);
assert.equal(normalizeFinancialCenterTab("journal"), "journal");
assert.equal(normalizeFinancialCenterTab("mappings"), "mappings");
assert.equal(normalizeFinancialCenterTab("invalid"), "summary");

assert.doesNotMatch(center, /#partida-/);
assert.doesNotMatch(traceability, /#partida-/);
assert.match(center, /buildJournalEntryViewerHref\(linkedDraft\.id\)/);
assert.match(traceability, /buildJournalEntryViewerHref\(entry\.id\)/);

assert.ok(page.indexOf("uuidLike(requestedEntryId") < page.indexOf("getFocusedJournalEntry(validatedEntryId.value)"));
assert.match(page, /requestedEntryId \? "journal" : requestedTab/);
assert.match(page, /status: "invalid" as const/);
assert.match(page, /status: data \? "loaded" : "not_found"/);
assert.match(page, /status: "load_error"/);
assert.match(page, /requirePermission\("accounting:read"\)/);

const viewerService = service.slice(
  service.indexOf("export async function getJournalEntryByIdForViewer"),
  service.indexOf("export async function getJournalEntryEditData"),
);
assert.match(viewerService, /from\("journal_entries"\)/);
assert.match(viewerService, /getLinesByEntryIds\(\[entryRow\.id\]\)/);
assert.match(viewerService, /maybeSingle<JournalEntryRow>/);
assert.match(viewerService, /normalizeEntry\(entryRow/);
assert.doesNotMatch(viewerService, /\.(?:insert|update|delete|upsert)\(/);
assert.doesNotMatch(viewerService, /service.role|service_role|createClient|\.rpc\(/i);

assert.match(center, /const activeTab = selectedEntryId\s*\? "journal"/);
assert.match(center, /params\.set\("tab", "journal"\)/);
assert.match(center, /params\.delete\("partida"\)/);
assert.match(center, /window\.history\.pushState/);
assert.match(center, /Identificador de partida contable inválido\./);
assert.match(center, /No se encontró la partida contable solicitada\./);
assert.match(center, /No fue posible cargar la partida contable\. Intente nuevamente\./);

assert.match(manager, /some\(\(entry\) => entry\.id === focusedEntryData\.entry\.id\)/);
assert.match(manager, /focusedEntryData && !focusedEntryInPage/);
assert.match(manager, /setExpandedEntryId\(focusedEntryId\)/);
assert.match(manager, /scrollIntoView/);
assert.match(manager, /prefers-reduced-motion/);
assert.match(manager, /tabIndex=\{-1\}/);
assert.match(manager, /id=\{`partida-mobile-\$\{entry\.id\}`\}/);
assert.match(manager, /id=\{`partida-desktop-\$\{entry\.id\}`\}/);
assert.doesNotMatch(manager, /id=\{`partida-\$\{entry\.id\}`\}/);
assert.match(manager, /params=\{\{ tab: "journal", partida: focusedEntryId/);
assert.match(manager, /Cerrar detalle/);

assert.match(overlay, /nextUrl\.pathname === currentUrl\.pathname && nextUrl\.search === currentUrl\.search/);
assert.match(overlay, /window\.addEventListener\("hashchange", finishNavigation\)/);
assert.match(overlay, /window\.addEventListener\("pageshow", finishNavigation\)/);
assert.match(overlay, /window\.addEventListener\("popstate", finishNavigation\)/);
assert.match(overlay, /clearTimeout\(timeoutRef\.current\)/);

console.log("Accounting journal entry viewer tests passed.");
