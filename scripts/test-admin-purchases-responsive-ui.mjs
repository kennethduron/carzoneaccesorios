import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  filterAdminPurchases,
  isPurchaseReturnEligible,
  resolveInitialPurchaseSelection,
} from "../src/components/admin/purchases-responsive-state.ts";

const [page, manager, responsiveUi, responsiveState, responsiveCss, confirmationDialog, browserFixture] = await Promise.all([
  readFile(new URL("../src/app/admin/compras/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/purchases-manager.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/purchases-responsive-ui.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/purchases-responsive-state.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/admin-purchases-responsive.module.css", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/purchase-confirmation-dialog.tsx", import.meta.url), "utf8"),
  readFile(new URL("./fixtures/admin-purchases-responsive-certification.html", import.meta.url), "utf8"),
]);

function purchase(overrides) {
  return {
    id: overrides.id,
    supplier_id: overrides.supplier_id ?? "supplier-a",
    purchase_number: overrides.purchase_number ?? `COMPRA-${overrides.id}`,
    supplier_name: overrides.supplier_name ?? "Proveedor Uno",
    status: overrides.status ?? "draft",
    notes: overrides.notes ?? null,
    items: overrides.items ?? [],
    returns: [],
    payable: null,
    ...overrides,
  };
}

const syntheticPurchases = [
  purchase({ id: "draft-1", status: "draft", purchase_number: "BOR-100", supplier_name: "Proveedor Águila", notes: "Entrega urgente" }),
  purchase({ id: "confirmed-1", status: "confirmed", purchase_number: "CON-200", supplier_id: "supplier-b", supplier_name: "Proveedor Beta" }),
  purchase({ id: "received-1", status: "received", purchase_number: "REC-300" }),
  purchase({ id: "cancelled-1", status: "cancelled", purchase_number: "CAN-400" }),
  purchase({ id: "returned-1", status: "returned", purchase_number: "DEV-500" }),
];

assert.deepEqual(
  filterAdminPurchases(syntheticPurchases, { query: "", supplierId: "all", status: "active" }).map((item) => item.id),
  ["draft-1", "confirmed-1", "received-1"],
  "Activas debe conservar la semántica que excluye canceladas y devueltas",
);
assert.deepEqual(
  filterAdminPurchases(syntheticPurchases, { query: "proveedor aguila", supplierId: "all", status: "all" }).map((item) => item.id),
  ["draft-1"],
  "La búsqueda debe conservar normalización de acentos y proveedor",
);
assert.deepEqual(
  filterAdminPurchases(syntheticPurchases, { query: "confirmada", supplierId: "all", status: "all" }).map((item) => item.id),
  ["confirmed-1"],
  "La búsqueda debe conservar etiquetas de estado localizadas",
);
assert.deepEqual(
  filterAdminPurchases(syntheticPurchases, { query: "", supplierId: "supplier-b", status: "all" }).map((item) => item.id),
  ["confirmed-1"],
  "El filtro de proveedor debe conservar coincidencia exacta por ID",
);

assert.deepEqual(resolveInitialPurchaseSelection(syntheticPurchases, "confirmed-1"), { selectedId: "confirmed-1", notice: null });
assert.deepEqual(resolveInitialPurchaseSelection(syntheticPurchases, "missing"), { selectedId: null, notice: "invalid" });
assert.deepEqual(resolveInitialPurchaseSelection(syntheticPurchases, null), { selectedId: "draft-1", notice: null });
assert.deepEqual(resolveInitialPurchaseSelection(syntheticPurchases, "cancelled-1"), { selectedId: null, notice: "hidden" });
assert.deepEqual(resolveInitialPurchaseSelection([syntheticPurchases[3], syntheticPurchases[0]], null), { selectedId: "draft-1", notice: null });
assert.equal(isPurchaseReturnEligible(syntheticPurchases[1]), true);
assert.equal(isPurchaseReturnEligible(syntheticPurchases[2]), true);
assert.equal(isPurchaseReturnEligible(syntheticPurchases[4]), true);
assert.equal(isPurchaseReturnEligible(syntheticPurchases[0]), false);

assert.match(page, /variant="wide"/);
assert.match(manager, /xl:grid-cols-\[minmax\(0,1\.35fr\)_minmax\(420px,1fr\)\]/);
assert.match(manager, /matchMedia\("\(max-width: 1279px\)"\)/);
assert.match(manager, /window\.history\.pushState\(\{ carZonePurchasesDetail: true \}/);
assert.match(manager, /window\.history\.replaceState/);
assert.match(manager, /window\.addEventListener\("popstate"/);
assert.match(manager, /window\.addEventListener\("beforeunload"/);
assert.match(manager, /document\.addEventListener\("click", handleDocumentNavigation, true\)/);
assert.match(manager, /savedListScrollRef\.current = window\.scrollY/);
assert.match(manager, /originTriggerRef\.current\?\.focus\(\{ preventScroll: true \}\)/);
assert.match(manager, /detailHeadingRef\.current\?\.focus\(\)/);
assert.match(manager, /setSelectionNotice\("hidden"\)/);
assert.match(manager, /compactDetailOpen \? "hidden xl:flex" : "flex"/);
assert.match(manager, /compactDetailOpen \? "hidden xl:grid" : "grid"/);
assert.match(manager, /draftSignature\(draft\)/);
assert.match(manager, /returnSignature\(returnDraft\)/);
assert.match(manager, /title: "Cambios sin guardar"/);

for (const action of ["savePurchaseAction", "confirmPurchaseAction", "cancelPurchaseAction", "registerPurchaseReturnAction"]) {
  assert.ok(manager.includes(action), `debe conservarse el action canónico ${action}`);
}
assert.ok(manager.indexOf("await toast.confirm({\n      title: \"Cancelar compra\"") < manager.indexOf("cancelPurchaseAction(purchase.id, requestKey)"), "la confirmación destructiva debe ocurrir antes del action canónico");
assert.match(manager, /PurchaseConfirmationDialog/);
assert.match(confirmationDialog, /payment_condition/);
assert.match(confirmationDialog, /request_key: requestKey/);

assert.match(responsiveUi, /variant: "desktop" \| "cards"/);
assert.match(responsiveUi, /aria-pressed=\{statusFilter === status\}/);
assert.match(responsiveUi, /aria-selected=\{selected\}/);
assert.match(responsiveUi, /aria-current=\{selected \? "true" : undefined\}/);
assert.match(responsiveUi, /htmlFor=\{`\$\{idPrefix\}-search`\}/);
assert.match(responsiveUi, /htmlFor=\{`\$\{idPrefix\}-supplier`\}/);
assert.match(responsiveUi, /Volver a compras/);
assert.match(responsiveUi, /Registrar devolución/);
assert.match(responsiveUi, /Información adicional/);
assert.match(responsiveUi, /styles\.lineCards/);
assert.match(responsiveUi, /styles\.lineTable/);
assert.doesNotMatch(responsiveUi, /min-w-\[(?:620|700|900)px\]/);
assert.doesNotMatch(responsiveUi, /Pagination|Paginaci[oó]n|Siguiente página/);
assert.ok((responsiveUi.match(/min-h-11/g) ?? []).length >= 20, "los controles operativos deben mantener objetivos táctiles de 44px");

assert.match(responsiveState, /\["cancelled", "returned"\]\.includes\(purchase\.status\)/);
assert.match(responsiveCss, /max-height: calc\(100dvh - 21rem\)/);
assert.match(responsiveCss, /position: sticky/);
assert.match(responsiveCss, /@media \(max-width: 1279px\)/);
assert.match(responsiveCss, /@media \(min-width: 1280px\)[\s\S]*@container \(min-width: 720px\)/);
assert.match(browserFixture, /data-testid="master-layout"/);
assert.match(browserFixture, /body\[data-state="detail"\] \.notice/);
assert.match(browserFixture, /Array\.from\(\{ length: 49 \}/);
assert.match(browserFixture, /window\.fixtureScroll = scrollY/);
assert.match(browserFixture, /window\.fixtureTrigger\?\.focus\(\{ preventScroll: true \}\)/);

const frozenServerFiles = [
  "src/app/admin/compras/actions.ts",
  "src/services/supabase/purchases.service.ts",
  "src/types/purchases.ts",
  "supabase/migrations",
];
execFileSync("git", ["diff", "--exit-code", "origin/main", "--", ...frozenServerFiles], { cwd: new URL("..", import.meta.url), stdio: "pipe" });

const addedProductionRoutes = execFileSync("git", ["diff", "--name-only", "--diff-filter=A", "origin/main", "--", "src/app"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).trim();
assert.equal(addedProductionRoutes, "", "no debe crearse una ruta de producción para pruebas");

console.log("Admin purchases responsive UI and frozen business contracts: PASS");
