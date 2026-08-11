import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildCustomerDuplicateGroups,
  isSafeCustomerDiscoveryName,
  normalizeCustomerDiscoveryName,
} from "../src/lib/customers/customer-duplicate-discovery.ts";

const base = {
  user_id: null,
  email: null,
  phone: null,
  tax_id: null,
  status: "active",
  active: true,
  is_wholesale: false,
  created_at: "2026-08-01T00:00:00.000Z",
};
const counts = { orders: new Map(), invoices: new Map() };

assert.equal(normalizeCustomerDiscoveryName(" Carrocería   Rapalo "), "carroceria rapalo");
assert.equal(normalizeCustomerDiscoveryName("CARROCERIA-RAPALO"), "carroceria rapalo");
assert.equal(isSafeCustomerDiscoveryName("Auto"), false);
assert.equal(isSafeCustomerDiscoveryName("Taller"), false);
assert.equal(isSafeCustomerDiscoveryName("Carrocería Rapalo"), true);

const rapaloGroups = buildCustomerDuplicateGroups([
  { ...base, id: "00000000-0000-4000-8000-000000000001", business_name: "Carrocería Rapalo", contact_name: "Carlos David Rapalo" },
  { ...base, id: "00000000-0000-4000-8000-000000000002", business_name: "CARROCERIA RAPALO", contact_name: "CARROCERIA RAPALO" },
], counts);
assert.equal(rapaloGroups.length, 1);
assert.equal(rapaloGroups[0].classification, "probable");
assert.deepEqual(rapaloGroups[0].match_reasons, ["business_name"]);

const deduplicatedPair = buildCustomerDuplicateGroups([
  { ...base, id: "00000000-0000-4000-8000-000000000003", business_name: "Auto Centro Norte", contact_name: "Auto Centro Norte", email: "ventas@centro.test", phone: "99990000" },
  { ...base, id: "00000000-0000-4000-8000-000000000004", business_name: "AUTO CENTRO NORTE", contact_name: "AUTO CENTRO NORTE", email: "VENTAS@CENTRO.TEST", phone: "+504 9999-0000" },
], counts);
assert.equal(deduplicatedPair.length, 1);
assert.deepEqual(deduplicatedPair[0].match_reasons, ["email", "phone", "business_name", "contact_name"]);
assert.equal(deduplicatedPair[0].classification, "strong");

const contactOnly = buildCustomerDuplicateGroups([
  { ...base, id: "00000000-0000-4000-8000-000000000005", business_name: null, contact_name: "Carlos Rodríguez" },
  { ...base, id: "00000000-0000-4000-8000-000000000006", business_name: null, contact_name: "CARLOS RODRIGUEZ" },
], counts);
assert.equal(contactOnly.length, 1);
assert.equal(contactOnly[0].classification, "weak");

const taxPair = buildCustomerDuplicateGroups([
  { ...base, id: "00000000-0000-4000-8000-000000000009", business_name: "Comercial Rivera Norte", contact_name: "Mario Rivera", tax_id: "0801-1990-123456" },
  { ...base, id: "00000000-0000-4000-8000-000000000010", business_name: "Repuestos Rivera Sur", contact_name: "Marta Rivera", tax_id: "08011990123456" },
], counts);
assert.equal(taxPair.length, 1);
assert.deepEqual(taxPair[0].match_reasons, ["tax_id"]);
assert.equal(taxPair[0].classification, "strong");

const crossFieldMatch = buildCustomerDuplicateGroups([
  { ...base, id: "00000000-0000-4000-8000-000000000007", business_name: "Repuestos La Ceiba", contact_name: "María López" },
  { ...base, id: "00000000-0000-4000-8000-000000000008", business_name: null, contact_name: "REPUESTOS LA CEIBA" },
], counts);
assert.equal(crossFieldMatch.length, 1);
assert.deepEqual(crossFieldMatch[0].match_reasons, ["business_name"]);

const [serviceSource, actionSource, managerSource, wizardSource, pickerSource, customersPageSource] = await Promise.all([
  readFile(new URL("../src/services/supabase/admin-crm.service.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/app/admin/crm/customer-merge-actions.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/crm-manager.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/customer-merge-wizard.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/components/admin/customer-manual-merge-picker.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src/app/admin/clientes/page.tsx", import.meta.url), "utf8"),
]);

assert.match(serviceSource, /\.is\("merged_into_customer_id", null\)/, "automatic discovery excludes merged aliases");
assert.match(serviceSource, /search_admin_crm_customer_ids_v1/, "manual search reuses normalized server-side search");
assert.match(serviceSource, /resolve_customer_root_v1/, "manual search resolves canonical family");
assert.match(actionSource, /requireCustomerMergeActor/, "search, preview and execute share server authorization");
assert.match(actionSource, /technical_owner.*business_owner.*admin/s, "only privileged roles can merge");
assert.match(actionSource, /preview_customer_merge_v1/, "preview remains canonical");
assert.match(actionSource, /merge_customers_v1/, "execution remains canonical");
assert.match(managerSource, /Unificar con otro cliente/, "customer actions expose manual merge");
assert.match(managerSource, /CustomerMergeWizard/, "automatic and manual selections share the wizard");
assert.match(wizardSource, /requireBusinessConfirmation/, "manual flow requires business confirmation");
assert.match(wizardSource, /previewHash/, "wizard executes with preview hash");
assert.match(wizardSource, /expectedPrimaryCommercialVersion/, "wizard executes with fresh versions");
assert.match(pickerSource, /nombre, empresa, correo, teléfono o RTN/i, "manual search documents all supported fields");
assert.match(pickerSource, /¿Cuál registro debe permanecer como principal\?/, "principal selection is explicit");
assert.match(pickerSource, /same_family/, "same-family result cannot be executed");
assert.match(customersPageSource, /technical_owner.*business_owner.*admin/s, "frontend role gate is explicit");

console.log("customer manual merge and name discovery tests: PASS");
