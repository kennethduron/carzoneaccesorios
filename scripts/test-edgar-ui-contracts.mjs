import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const paths = {
  rollout: "supabase/migrations/202608100001_edgar_invoice_cart_pos_closeout.sql",
  permissions: "src/lib/auth/permissions.ts",
  mergeActions: "src/app/admin/crm/customer-merge-actions.ts",
  mergeWizard: "src/components/admin/customer-merge-wizard.tsx",
  crmActions: "src/app/admin/crm/actions.ts",
  portalLink: "src/components/admin/customer-portal-link-workspace.tsx",
  posWorkspace: "src/components/admin/pos-workspace.tsx",
  posValidation: "src/lib/validation/pos-draft.ts",
  invoiceMapper: "src/utils/invoice-document-mappers.ts",
  adminInvoices: "src/services/supabase/admin-invoices.service.ts",
  customerInvoices: "src/services/supabase/customer-account.service.ts",
};
const source = Object.fromEntries(await Promise.all(
  Object.entries(paths).map(async ([key, path]) => [key, await readFile(path, "utf8")]),
));

assert.match(source.rollout, /where role\.name = 'admin'/);
assert.match(source.rollout, /\["customers:merge"\]/);
assert.doesNotMatch(source.rollout, /where role\.name in \([^)]*(?:contadora|vendedor|bodega|soporte|cliente)/);
assert.match(source.permissions, /admin:[\s\S]*?"customers:merge"/);
assert.match(source.mergeActions, /customer_merge_execution_v1/);
assert.match(source.mergeWizard, /disabled=\{!executionEnabled \|\| !preview\.allowed/);
assert.match(source.mergeWizard, /La unificación de clientes está desactivada por configuración/);

assert.match(source.crmActions, /const linkedElsewhere = Boolean\(linkedCustomerId && linkedCustomerId !== customer\.value\)/);
assert.match(source.crmActions, /email: linkedElsewhere \? null : row\.email/);
assert.doesNotMatch(source.crmActions, /linkedCustomerId && linkedCustomerId !== customer\.value\)\) return \[\]/);
assert.doesNotMatch(source.crmActions, /auth\.admin\.(?:createUser|generateLink)/);
assert.match(source.crmActions, /link_customer_portal_account_v2/);
assert.match(source.portalLink, /no crea usuarios, no envía correos y no vincula por coincidencia automática/);
assert.match(source.portalLink, /account\.linkedToAnotherCustomer/);
assert.match(source.portalLink, /Conflicto: esta cuenta ya pertenece a otro cliente/);
assert.match(source.portalLink, /El cliente puede seguir operando como visitante/);

assert.match(source.rollout, /jsonb_array_elements\(p_items\) with ordinality/i);
assert.match(source.rollout, /order by line\.line_position, line\.id/);
assert.match(source.posWorkspace, /items\.map\(\(item, index\) => \(\{ linePosition: index \+ 1/);
assert.match(source.posWorkspace, /linePosition: items\.length \+ 1/);
assert.match(source.posValidation, /linePosition: z\.number\(\)\.int\(\)\.positive\(\)/);

assert.match(source.invoiceMapper, /customerCity: invoice\.customer_city/);
assert.match(source.invoiceMapper, /customerBusinessName: invoice\.customer_business_name/);
assert.match(source.adminInvoices, /customer_city: row\.customer_city \?\? row\.orders\?\.fiscal_customer_city/);
assert.match(source.customerInvoices, /customerCity: row\.customer_city \?\? row\.orders\?\.fiscal_customer_city/);
assert.doesNotMatch(source.adminInvoices, /customers\(/, "admin invoice documents do not join the live customer");

console.log("Edgar UI and read-model structural contracts: PASS");
