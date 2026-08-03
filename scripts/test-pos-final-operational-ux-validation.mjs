import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const dialog = read("src/components/admin/pos-confirmation-dialog.tsx");
const workspace = read("src/components/admin/pos-workspace.tsx");
const customer = read("src/components/admin/pos-customer-workspace.tsx");
const cart = read("src/components/admin/pos-cart.tsx");
const productSearch = read("src/components/admin/pos-product-search.tsx");
const confirmation = read("src/components/admin/pos-confirmation-panel.tsx");
const summary = read("src/components/admin/pos-draft-summary.tsx");
const delivery = read("src/components/admin/pos-delivery-fields.tsx");
const customerService = read("src/services/supabase/pos-customer.service.ts");
const draftService = read("src/services/supabase/pos-draft.service.ts");
const searchRoute = read("src/app/api/admin/pos/customers/search/route.ts");
const migration = read("supabase/migrations/202608030002_pos_final_operational_ux_guards.sql");

const posUi = [workspace, customer, cart, productSearch, confirmation, summary, delivery].join("\n");
assert.doesNotMatch(posUi, /window\.(confirm|alert)\s*\(/);
for (const technicalCopy of [
  /POS\s*[·-]\s*Etapa\s*[456]/i,
  /Venta at[oó]mica/i,
  /operaci[oó]n at[oó]mica/i,
  /Precio del servidor/i,
  /Versi[oó]n\s*\{?context\.commercialVersion/i,
  /abandonado l[oó]gicamente/i,
  /La API tambi[eé]n/i,
  /El servidor (lo|la|volver[aá]|fijar[aá]|revalidar[aá])/i,
  /borradores contables/i,
]) assert.doesNotMatch(posUi, technicalCopy);

for (const contract of [
  "role=\"alertdialog\"", "aria-modal=\"true\"", "aria-labelledby", "aria-describedby",
  "event.key === \"Escape\"", "event.key !== \"Tab\"", "cancelRef.current?.focus()",
  "returnFocusRef.current?.focus()", "document.body.style.overflow = \"hidden\"",
]) assert.ok(dialog.includes(contract), `Missing dialog contract: ${contract}`);

for (const copy of [
  "Descartar cambios", "Continuar editando", "Abandonar borrador", "Cambiar cliente",
  "Abandonar borrador y quitar cliente", "La venta en preparación fue descartada.",
  "Nueva venta", "Prepare y facture una venta",
]) assert.ok(`${workspace}\n${customer}`.includes(copy), `Missing operational copy: ${copy}`);

for (const contract of [
  "Productos agregados", "Aún no hay productos agregados", "data-testid=\"pos-cart-lines\"",
  "data-testid=\"pos-cart-line\"", "<Minus", "<Plus", "<Trash2", "QuantityInput",
  "onBlur={commit}", "event.key === \"Enter\"", "Precio al detalle", "Precio mayorista",
  "Precio autorizado", "Existencia disponible", "Subtotal", "Sin control de inventario",
  "Eliminar producto", "Deshacer",
]) assert.ok(cart.includes(contract), `Missing cart contract: ${contract}`);
assert.match(workspace, /lg:min-h-72 lg:max-h-\[85vh\] lg:overflow-y-auto/);
assert.doesNotMatch(workspace, /lg:flex lg:max-h-\[calc\(100vh-2rem\)\]/);
assert.match(workspace, /changeRevisionRef\.current === savingRevision/);
assert.match(workspace, /operationLockRef\.current/);
assert.match(workspace, /draftRequestRevisionRef\.current/);
assert.match(workspace, /setCustomer\(\(current\) => next\.customerId === current\?\.customerId/);
assert.match(customer, /contextRevisionRef\.current/);
assert.match(customer, /aria-label="Quitar cliente seleccionado"/);
assert.match(customer, /title="Quitar cliente"/);
assert.match(customer, /onCustomerContextChange\?\.\(null\)/);

assert.doesNotMatch(searchRoute, /includeInactive/);
assert.match(customerService, /p_include_inactive: false/);
assert.match(customerService, /get_selectable_pos_customer_context_v1/);
assert.match(draftService, /create_selectable_pos_sale_draft_v1/);
assert.match(customerService, /POS_CUSTOMER_SUSPENDED/);
assert.match(draftService, /POS_CUSTOMER_SUSPENDED/);

for (const contract of [
  "customer.active", "customer.status = 'active'", "customer.wholesale_status <> 'suspended'",
  "customer.merged_into_customer_id is null", "get_selectable_pos_customer_context_v1",
  "create_selectable_pos_sale_draft_v1", "POS_CUSTOMER_SUSPENDED",
  "confirm_selectable_pos_sale_v1",
  "enforce_pos_draft_customer_selectable_trigger", "enforce_pos_confirmation_customer_selectable_trigger",
  "revoke execute on function public.get_pos_customer_context_v1", "revoke execute on function public.create_pos_sale_draft_v1",
]) assert.ok(migration.includes(contract), `Missing database guard: ${contract}`);
assert.doesNotMatch(migration, /\b(insert|update|delete)\s+(into\s+|from\s+)?public\.(customers|orders|invoices|payments|accounts_receivable|products|inventory_movements|journal_entries)\b/i);

assert.match(productSearch, /Precios actualizados/);
assert.ok(delivery.includes("Los cargos adicionales no están disponibles para esta venta."));
assert.doesNotMatch(delivery, /capabilities\?\.disabledReason/);
assert.match(confirmation, /Revise la información antes de confirmar/);
assert.match(confirmation, /El crédito disponible se verificará nuevamente al confirmar/);
assert.match(summary, /La venta todavía no ha sido confirmada/);

console.log("POS final operational UX structural validation: PASS");
