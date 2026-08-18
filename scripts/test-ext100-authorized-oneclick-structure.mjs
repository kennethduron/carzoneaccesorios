import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [action, incident, page, ui, migration, invoiceService, invoiceDispatcher, invoiceAdapter, crmService, customerAccount] = await Promise.all([
  read("src/app/admin/facturas/actions.ts"),
  read("src/lib/incidents/auto-centro-ext100-commercial-reversal.ts"),
  read("src/app/admin/facturas/page.tsx"),
  read("src/components/admin/admin-invoices-manager.tsx"),
  read("supabase/migrations/202608170002_full_invoice_reversal_admin_recovery.sql"),
  read("src/services/supabase/admin-invoices.service.ts"),
  read("src/services/accounting/accounting-event-dispatcher.ts"),
  read("src/services/accounting/adapters/invoice-financial-events.ts"),
  read("src/services/supabase/admin-crm.service.ts"),
  read("src/services/supabase/customer-account.service.ts"),
]);

for (const role of ["technical_owner", "business_owner", "admin"]) {
  assert.ok(incident.includes(`"${role}"`), `missing authorized role ${role}`);
  assert.ok(migration.includes(`'${role}'`), `database gate missing ${role}`);
}
for (const role of ["vendedor", "bodega", "contadora", "soporte", "cliente"]) {
  assert.equal(incident.includes(`"${role}"`), false, `unauthorized role leaked into app whitelist: ${role}`);
}

assert.match(action, /completeAnnulledInvoiceCommercialReversalAction\(\s*invoiceId: string,\s*confirmation: string/);
assert.ok(action.includes("const profile = await getSessionProfile()"));
assert.ok(action.includes("isCommercialReversalRecoveryRole(profile.role)"));
assert.ok(action.includes('rpc("cancel_sale_invoice_v1"'));
assert.ok(action.includes("p_recovery_mode: true"));
assert.ok(action.includes("p_recovery_expected: {"));
assert.ok(action.includes("reversalAudit.data?.actor_id === profile.id"));
assert.ok(action.includes('effects.length === 2'));
assert.ok(action.includes('effect.status === "cancelled"'));
assert.ok(action.includes('"sale_recognized", "inventory_cogs"'));
assert.equal(/completeAnnulledInvoiceCommercialReversalAction\([^)]*(actor|role|userId)/s.test(action), false);
assert.equal(action.includes("service_role"), false);
assert.equal(action.includes("getSupabaseAdminClient"), false);
assert.equal(/\.from\("products"\)\.update/.test(action), false);

assert.ok(page.includes("getPendingAutoCentroExt100Recovery(profile.role)"));
assert.ok(page.includes("pendingCommercialReversal={pendingCommercialReversal}"));
assert.ok(ui.includes("pendingCommercialReversal?.invoiceId === invoice.id"));
assert.ok(ui.includes("Completar reversión comercial"));
assert.ok(ui.includes("Esta factura ya está anulada"));
assert.ok(ui.includes("Motivo registrado"));
assert.ok(ui.includes("commercialReversalSubmission.current"));
assert.ok(ui.includes("isPending || commercialReversalInFlight"));
assert.ok(ui.includes("router.refresh()"));
assert.ok(ui.includes("md:hidden"));
assert.ok(ui.includes("hidden overflow-x-auto md:block"));
assert.ok(ui.includes('className="mt-2 w-full justify-center'));

assert.ok(migration.includes("occurrence_count <> 1"));
assert.ok(migration.includes("pg_get_functiondef"));
assert.equal(/\b(insert|update|delete|truncate)\b\s+(into\s+|from\s+)?public\./i.test(migration), false);

for (const [label, source] of [
  ["admin invoices", invoiceService],
  ["invoice dispatcher", invoiceDispatcher],
  ["invoice adapter", invoiceAdapter],
  ["CRM invoices", crmService],
  ["customer invoices", customerAccount],
]) {
  assert.equal(/\.from\("invoices"\)[\s\S]{0,1800}?orders\(/.test(source), false, `${label} has an ambiguous invoices-to-orders embed`);
}
assert.ok(invoiceService.includes("orders!invoices_order_id_fkey("));

console.log("EXT-100 authenticated one-click bridge structural contracts: PASS", {
  normalSessionOnly: true,
  exactAuthorizedRoles: true,
  clientActorIgnored: true,
  serviceRoleImpersonation: false,
  exactIncidentBinding: true,
  explicitConfirmation: true,
  doubleSubmitGuard: true,
  directStockPatch: false,
});
