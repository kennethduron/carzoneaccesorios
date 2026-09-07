import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const has = (path, pattern, message) => assert.match(read(path), pattern, message);

has("src/components/ui/button.tsx", /disabled=\{disabled \|\| pending\}/, "pending buttons must be disabled");
has("src/components/ui/button.tsx", /aria-busy=\{pending \|\| undefined\}/, "pending buttons must expose aria-busy");
has("src/components/ui/button.tsx", /motion-reduce:animate-none/, "spinner must honor reduced motion");
has("src/components/ui/async-download-link.tsx", /if \(disabled \|\| inFlight\.current\) return/, "downloads must reject duplicate activation synchronously");
has("src/components/ui/async-download-link.tsx", /finally[\s\S]*inFlight\.current = false[\s\S]*setPending\(false\)/, "downloads must always clear pending state");

const actionContracts = [
  ["src/components/admin/pos-confirmation-panel.tsx", /Confirmando venta…/],
  ["src/components/admin/pos-confirmation-panel.tsx", /if \(submitting\.current \|\| pending/],
  ["src/components/admin/accounts-receivable-manager.tsx", /Registrando abono…/],
  ["src/components/admin/accounts-receivable-manager.tsx", /Marcando como pagado…/],
  ["src/components/admin/product-manager.tsx", /Guardando producto…/],
  ["src/components/admin/product-manager.tsx", /aria-busy=\{isUploadPending \|\| undefined\}/],
  ["src/components/admin/purchase-confirmation-dialog.tsx", /Confirmando compra…/],
  ["src/components/admin/purchases-responsive-ui.tsx", /Guardando compra…/],
  ["src/components/admin/accounts-payable-manager.tsx", /Registrando pago…/],
  ["src/components/admin/supplier-multi-payment-wizard.tsx", /Registrando pago…/],
  ["src/components/admin/commission-policies-manager.tsx", /Asignando política…/],
  ["src/components/admin/commercial-reports-dashboard-v2.tsx", /Actualizando reporte comercial…/],
  ["src/components/admin/report-center-v2.tsx", /Generando \$\{format\}…/],
  ["src/components/admin/accounting-manager.tsx", /Publicando partida…/],
  ["src/components/admin/accounting-manager.tsx", /pending=\{recalculatingEntryId === entry\.id\}/],
  ["src/components/admin/accounting-manager.tsx", /Reversando partida…/],
  ["src/components/admin/accounting-periods-manager.tsx", /Cerrando período…/],
  ["src/components/admin/accounting-periods-manager.tsx", /pending=\{closing\}/],
  ["src/components/admin/accounting-periods-manager.tsx", /Reabriendo período…/],
  ["src/components/admin/accounting-reports.tsx", /Generando PDF…/],
  ["src/components/admin/accounts-receivable-import-manager.tsx", /Analizando archivo…/],
  ["src/components/admin/accounts-receivable-import-manager.tsx", /Importando cuentas…/],
];
for (const [path, pattern] of actionContracts) has(path, pattern, `${path} is missing its specific pending feedback`);

for (const route of [
  "pos", "cuentas-por-cobrar", "cuentas-por-pagar", "compras", "proveedores",
  "contabilidad", "reportes-comerciales", "centro-reportes", "politicas-comision",
]) {
  has(`src/app/admin/${route}/loading.tsx`, /AdminRouteLoading/, `${route} must have a route fallback`);
}

has("src/components/navigation-loading-overlay.tsx", /setTimeout\([\s\S]*220\)/, "quick navigations should not flash the global overlay");
has("src/components/navigation-loading-overlay.tsx", /isDownloadHref/, "downloads must not trigger the navigation overlay");

console.log("Global loading and async feedback contract: PASS");
