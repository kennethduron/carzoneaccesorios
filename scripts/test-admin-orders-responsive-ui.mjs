import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [page, manager, commercialTerms, responsiveCss, contactActions] = await Promise.all([
  readFile(new URL("../src/app/admin/pedidos/page.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/admin-orders-manager.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/order-commercial-terms.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/admin-orders-responsive.module.css", import.meta.url), "utf8"),
  readFile(new URL("../src/components/contact-actions.tsx", import.meta.url), "utf8"),
]);

assert.match(page, /variant="wide"/);
assert.match(page, /initialOrderId=\{focusOrderId\}/);

assert.match(manager, /matchMedia\("\(max-width: 1023px\)"\)/);
assert.match(manager, /compactDetailOpen \? "hidden lg:block" : "block"/);
assert.match(manager, /compactDetailOpen \? "block" : "hidden lg:block"/);
assert.match(manager, /Volver a pedidos/);
assert.match(manager, /detailHeadingRef\.current\?\.focus\(\)/);
assert.match(manager, /aria-current=\{selectedOrder\?\.id === order\.id \? "true" : undefined\}/);
assert.match(manager, /Hay cambios comerciales sin guardar/);
assert.match(manager, /window\.addEventListener\("beforeunload"/);

for (const group of ["Comunicación", "Acción principal y documentos", "Otros / admin", "Acciones de control"]) {
  assert.ok(manager.includes(group), `falta el grupo de acciones: ${group}`);
}

assert.match(manager, /function OrderProductsSection/);
assert.match(manager, /Precio unitario/);
assert.match(manager, /function CustomerDeliverySummary/);
assert.match(manager, /styles\.historyCards/);
assert.match(manager, /nextStatusActions\.slice\(0, 1\)/);
assert.match(manager, /action\.status !== normalizedStatus/);
assert.match(manager, /unsavedChangesRef\.current = false/);
assert.ok((manager.match(/role="dialog" aria-modal="true"/g) ?? []).length >= 4, "los modales afectados deben exponer semántica de diálogo");

assert.match(commercialTerms, /styles\.commercialContainer/);
assert.match(commercialTerms, /styles\.commercialCards/);
assert.match(commercialTerms, /styles\.commercialTable/);

for (const width of [719, 759, 679, 1023, 1024]) {
  assert.ok(responsiveCss.includes(`${width}px`), `falta umbral responsive ${width}px`);
}

assert.equal((contactActions.match(/min-h-11/g) ?? []).length, 2, "WhatsApp y llamada deben conservar 44px mínimos");

console.log("Admin orders responsive UI contracts: PASS");
