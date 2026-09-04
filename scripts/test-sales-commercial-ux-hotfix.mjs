import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getActiveCommercialSection } from "../src/components/admin/commercial-nav-state.ts";

const routes = [
  ["/admin/vendedores", "sellers"],
  ["/admin/vendedores/historial", "sellers"],
  ["/admin/comisiones", "commissions"],
  ["/admin/comisiones/detalle", "commissions"],
  ["/admin/politicas-comision", "policies"],
  ["/admin/politicas-comision/historial", "policies"],
  ["/admin/reportes-comerciales", "analytics"],
  ["/admin/reportes-comerciales/vendedores/seller-1", "analytics"],
  ["/admin/centro-reportes", "report-center"],
  ["/admin/centro-reportes/historial", "report-center"],
];

for (const [pathname, expected] of routes) {
  assert.equal(getActiveCommercialSection(pathname), expected, pathname);
}
assert.equal(getActiveCommercialSection("/admin"), null);
assert.equal(getActiveCommercialSection("/admin/comisiones-archivo"), null);
assert.equal(getActiveCommercialSection("/admin/reportes"), null);

const nav = await readFile(
  new URL("../src/components/admin/phase4-commercial-nav.tsx", import.meta.url),
  "utf8",
);
assert.match(nav, /usePathname/);
assert.match(nav, /aria-current=\{active \? "page"/);
assert.match(nav, /focus-visible:ring-2/);
assert.match(nav, /hover:bg-red-50\/70/);
assert.match(nav, /activeItem/);
assert.match(nav, /grid-cols-2/);

const commissions = await readFile(
  new URL("../src/components/admin/commissions-manager.tsx", import.meta.url),
  "utf8",
);
assert.match(commissions, /aria-label="Filtros de comisiones"/);
assert.match(commissions, /lg:grid-cols-12/);
assert.match(commissions, /2xl:grid-cols-\[/);
assert.match(commissions, /aria-label="Buscar por venta o cliente"/);
assert.match(commissions, /aria-label="Ordenar movimientos"/);
assert.match(commissions, /className=\{filterControlClass\}/);
assert.match(commissions, /md:hidden/);
assert.match(commissions, /hidden overflow-x-auto/);
assert.match(commissions, /min-w-\[800px\]/);
assert.doesNotMatch(commissions, /min-w-\[1050px\]/);
assert.doesNotMatch(commissions, /xl:col-start-6/);

console.log("Sales & Commercial UX hotfix contracts: PASS");
