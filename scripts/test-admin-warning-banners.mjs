import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const [
  adminPage,
  ordersPage,
  ordersManager,
  reportsPage,
  fiscalAlertsPanel,
  fiscalRules,
  invoicesManager,
  productsManager,
  businessSettings,
  commerceSettings,
  portalLinkWorkspace,
  posCustomerWorkspace,
  usagePage,
  adminError,
] = await Promise.all([
  read("src/app/admin/page.tsx"),
  read("src/app/admin/pedidos/page.tsx"),
  read("src/components/admin/admin-orders-manager.tsx"),
  read("src/app/admin/reportes/page.tsx"),
  read("src/components/admin/fiscal-alerts-panel.tsx"),
  read("src/utils/fiscal.ts"),
  read("src/components/admin/admin-invoices-manager.tsx"),
  read("src/components/admin/product-manager.tsx"),
  read("src/components/admin/business-settings-center.tsx"),
  read("src/components/admin/commerce-settings-form.tsx"),
  read("src/components/admin/customer-portal-link-workspace.tsx"),
  read("src/components/admin/pos-customer-workspace.tsx"),
  read("src/app/admin/uso/page.tsx"),
  read("src/app/admin/error.tsx"),
]);

assert.equal(
  ordersManager.includes("Revisión de precio requerida"),
  false,
  "the non-blocking order price-review summary banner must stay hidden",
);
assert.equal(
  ordersManager.includes("pricingInconsistencies"),
  false,
  "the removed banner must not retain its list-building presentation calculation",
);
assert.ok(
  ordersManager.includes('order.price_review.status === "action_required"') &&
    ordersManager.includes('order.price_review.status !== "authorized_manual_override"') &&
    ordersPage.includes("orderPriceReviewEnabled="),
  "price-review evidence and operational behavior must remain available",
);
for (const hiddenOrderNotice of ["Acción recomendada", "Validar tratamiento fiscal de envío y comisión"]) {
  assert.equal(ordersManager.includes(hiddenOrderNotice), false, `orders must hide: ${hiddenOrderNotice}`);
}
assert.ok(
  ordersManager.includes("<ReservationReviewPanel") &&
    ordersManager.includes("Debes confirmar el cargo contra entrega antes de emitir la factura") &&
    ordersManager.includes("Esta acción será definitiva y quedará registrada en auditoría"),
  "blocking order warnings and destructive-operation confirmation must remain visible",
);

assert.equal(
  reportsPage.includes("Reportes paginados con filtros server-side"),
  false,
  "the reports information banner must stay hidden",
);
assert.ok(
  reportsPage.includes("<ReportsDashboard"),
  "removing the banner must not remove the reports dashboard",
);

assert.ok(
  fiscalRules.includes("facturas anuladas para revisión contable"),
  "the underlying fiscal signal must remain intact",
);
assert.ok(
  fiscalAlertsPanel.includes("getVisibleAdminFiscalAlerts"),
  "the shared admin fiscal panel must apply the visibility policy",
);
assert.ok(
  fiscalAlertsPanel.includes('if (alert.type === "danger") return true'),
  "critical fiscal alerts must always remain visible",
);
assert.ok(
  fiscalAlertsPanel.includes("cancelledInvoiceReviewMessage"),
  "the cancelled-invoice review signal must be hidden from visible banners",
);
assert.ok(
  adminPage.includes("visibleFiscalAlerts.forEach"),
  "the dashboard notification UI must use the same visibility policy",
);
assert.ok(
  adminPage.includes('value={`${visibleFiscalAlerts.length.toLocaleString("es-HN")} alertas`}'),
  "the dashboard status summary must not count a hidden non-critical banner",
);
assert.ok(
  reportsPage.includes("getVisibleAdminFiscalAlerts"),
  "reports must use the shared visibility policy",
);
assert.ok(
  invoicesManager.includes("<FiscalAlertsPanel alerts={fiscalAlerts}"),
  "invoice views must continue using the shared critical-alert component",
);
for (const hiddenInvoiceNotice of [
  "Antes de emitir facturas reales, valide CAI",
  "Validar tratamiento fiscal de envío y comisión",
]) {
  assert.equal(invoicesManager.includes(hiddenInvoiceNotice), false, `invoices must hide: ${hiddenInvoiceNotice}`);
}
assert.ok(
  invoicesManager.includes("No se pudo cargar la consulta solicitada") &&
    invoicesManager.includes("fiscalCorrectionWarning") &&
    invoicesManager.includes("Impacto de la operación:"),
  "invoice load errors, current-action validation, and destructive confirmation must remain visible",
);

assert.ok(
  productsManager.includes("preview.criticalErrors.length > 0"),
  "blocking product-import errors must remain visible",
);
assert.equal(
  productsManager.includes("preview.zipWarnings.length > 0") || productsManager.includes("hasModeWarning"),
  false,
  "non-blocking product import information must not render as a persistent warning banner",
);
assert.ok(
  productsManager.includes("zipWarnings: zipImages.warnings") &&
    productsManager.includes("pendingImportRows.length > 0") &&
    productsManager.includes("failedRows.length > 0"),
  "product import signals must remain internal and current-operation failures must remain visible",
);

for (const [label, source, hiddenText] of [
  ["technical settings", businessSettings, "Las variables de Vercel, Supabase, Cloudinary"],
  ["commerce settings", commerceSettings, "Valida el tratamiento fiscal del envío"],
  ["portal linking", portalLinkWorkspace, "Esto es informativo"],
  ["POS customer", posCustomerWorkspace, "Puedes crear el perfil solo con el nombre"],
]) {
  assert.equal(source.includes(hiddenText), false, `${label} must hide its non-blocking information banner`);
}
assert.ok(
  posCustomerWorkspace.includes("Hay cambios sin guardar") && posCustomerWorkspace.includes("Posibles clientes existentes"),
  "immediate data-loss and duplicate-customer warnings must remain visible",
);
assert.ok(
  usagePage.includes('usage.expiredReservationCount > 0 ? "bg-[#fff7ed]" : "bg-[#f4f4f5]"'),
  "healthy reservation metrics must be neutral while actual expired reservations remain actionable",
);
assert.ok(
  adminError.includes("Error en el panel administrativo"),
  "the critical admin error boundary must remain intact",
);
assert.ok(
  adminError.includes("No fue posible cargar esta sección"),
  "the production blocking-error message must remain intact",
);

console.log("Admin non-critical warning banner contracts: PASS", {
  routes: ["/admin", "/admin/pedidos", "/admin/reportes", "/admin/productos", "/admin/facturas"],
  hiddenBannerGroups: 12,
  criticalErrorsPreserved: true,
  businessRulesPreserved: true,
});
