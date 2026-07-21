import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { allPermissions, rolePermissions } from "../src/lib/auth/permissions.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("supabase/migrations/202607200004_secure_customer_identity_management.sql");
const seed = read("supabase/seed/seed.sql");
const actions = read("src/app/admin/crm/actions.ts");
const manager = read("src/components/admin/crm-manager.tsx");
const identityUi = read("src/components/admin/customer-identity-section.tsx");
const linkUi = read("src/components/admin/customer-portal-link-workspace.tsx");
const checkout = read("src/app/checkout/actions.ts");

for (const role of ["technical_owner", "business_owner", "admin"]) {
  const permissions = role === "technical_owner" ? allPermissions : rolePermissions[role];
  assert.equal(permissions.includes("customers:update_identity"), true, `${role} must edit customer identity`);
  assert.equal(permissions.includes("customers:link_portal_account"), true, `${role} must link portal accounts`);
}
for (const role of ["contadora", "vendedor", "soporte", "bodega", "cliente"]) {
  assert.equal(rolePermissions[role].includes("customers:update_identity"), false, `${role} must not edit customer identity`);
}
assert.equal(rolePermissions.contadora.includes("customers:link_portal_account"), true);
for (const role of ["vendedor", "soporte", "bodega", "cliente"]) {
  assert.equal(rolePermissions[role].includes("customers:link_portal_account"), false, `${role} must not link portal accounts`);
}

assert.match(migration, /where name in \('technical_owner', 'business_owner', 'admin'\)/i);
assert.match(migration, /not \(coalesce\(permissions, '\[\]'::jsonb\) \? 'customers:update_identity'\)/i);
assert.match(migration, /create or replace function public\.update_customer_identity_manual/i);
assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/i);
assert.match(migration, /actor_role_name not in \('technical_owner', 'business_owner', 'admin'\)/i);
assert.match(migration, /public\.has_permission\('customers:update_identity'\)/i);
assert.match(migration, /from public\.customers[\s\S]*for update/i);
assert.match(migration, /p_expected_updated_at/i);
assert.match(migration, /customer\.identity\.updated/i);
assert.match(migration, /perform public\.write_audit_log/i);
assert.match(migration, /portal_role_name is distinct from 'cliente'/i);
assert.match(migration, /actor_role_name not in \('technical_owner', 'business_owner', 'admin', 'contadora'\)/i);
assert.doesNotMatch(migration, /update public\.(orders|invoices|payments|accounts_receivable|crm_notes|journal_entries)/i);
const updateIdentitySql = migration.slice(migration.indexOf("create or replace function public.update_customer_identity_manual"), migration.indexOf("create or replace function public.link_customer_portal_account_manual"));
assert.doesNotMatch(updateIdentitySql, /set\s+(user_id|is_wholesale|wholesale_status|credit_limit)/i);
assert.match(seed, /customers:update_identity/);
assert.match(seed, /permissions = permissions - 'customers:update_identity'[\s\S]*'contadora'/i);

assert.match(actions, /customerIdentityRoles[^\n]*technical_owner[^\n]*business_owner[^\n]*admin/);
assert.match(actions, /portalLinkRoles[^\n]*technical_owner[^\n]*business_owner[^\n]*admin[^\n]*contadora/);
assert.match(actions, /updateCustomerIdentityAction[\s\S]*customers:update_identity[\s\S]*update_customer_identity_manual/);
assert.match(actions, /p_expected_updated_at: expected\.value/);
assert.match(actions, /eq\("roles\.name", "cliente"\)/);
assert.match(actions, /auth\.admin\.getUserById/);
assert.match(actions, /linkedCustomerId && linkedCustomerId !== customer\.value/);

assert.match(manager, /canEditCustomerIdentity/);
assert.match(manager, /CustomerIdentitySection/);
assert.match(identityUi, /Editar información/);
assert.match(identityUi, /Correo comercial/);
assert.match(identityUi, /Correo de acceso/);
assert.match(identityUi, /submittingRef/);
assert.match(identityUi, /expected_updated_at/);
assert.match(linkUi, /useDebouncedValue\(accountQuery, 350\)/);
assert.match(linkUi, /Confirmar vinculación de cuenta/);
assert.match(linkUi, /role="alertdialog"/);
assert.match(linkUi, /Sí, vincular cuenta/);
assert.match(linkUi, /confirmed: true/);
assert.doesNotMatch(linkUi, /type="checkbox"/);
assert.match(linkUi, /reemplazará|reemplazarán/i);
assert.doesNotMatch(checkout, /update_customer_identity_manual|customers:update_identity/);

console.log("Customer identity management structural checks passed.");
