import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { customerCommercialProfileSchema } from "../src/lib/validation/customer-commercial-profile.ts";

const migration = await readFile("supabase/migrations/202608080005_customer_profile_set_once_guards.sql", "utf8");
const registration = await readFile("src/lib/auth/registration-schema.ts", "utf8");
const authAction = await readFile("src/app/auth/actions.ts", "utf8");
const accountAction = await readFile("src/app/cuenta/actions.ts", "utf8");
const accountUi = await readFile("src/components/store/customer-commercial-profile.tsx", "utf8");
const portalSync = await readFile("src/lib/auth/portal-customer-sync.ts", "utf8");

assert.match(migration, /set_my_customer_profile_fields_once_v1/);
assert.match(migration, /security definer[\s\S]*pg_advisory_xact_lock[\s\S]*for update/i);
assert.match(migration, /drop policy if exists "Users can update own customer record"/);
assert.match(migration, /revoke update on public\.customers from authenticated/);
for (const column of ["tax_id", "city", "business_name", "company_name"]) {
  assert.doesNotMatch(migration, new RegExp(`grant update \\([^)]*${column}`, "i"), `${column} must not be directly granted`);
}
assert.match(migration, /customer\.profile\.field_set_once/);
assert.match(migration, /values_included', false/);
assert.match(migration, /normalize_customer_tax_id_hn_v1/);
assert.doesNotMatch(migration, /unique\s*\([^)]*tax_id/i);
assert.doesNotMatch(migration, /update public\.customers\s+set[\s\S]*where[\s\S]*;\s*-- backfill/i);
assert.match(registration, /businessName:[\s\S]*taxId:[\s\S]*city:/);
assert.match(authAction, /\.\.\.\(businessName \? \{ business_name: businessName \} : \{\}\)/);
assert.match(authAction, /\.\.\.\(taxId \? \{ tax_id: taxId \} : \{\}\)/);
assert.match(authAction, /\.\.\.\(city \? \{ city \} : \{\}\)/);
assert.match(portalSync, /finalize_portal_registration_commercial_fields_v1/);
assert.match(accountAction, /requireSession\(\)/);
assert.match(accountAction, /set_my_customer_profile_fields_once_v1/);
assert.match(accountUi, /Después de guardar este dato no podrás editarlo desde tu cuenta/);
assert.match(accountUi, /aria-invalid/);
assert.match(accountUi, /toast\.confirm/);

assert.deepEqual(
  customerCommercialProfileSchema.parse({ businessName: "   ", taxId: "", city: undefined }),
  { businessName: null, taxId: null, city: null },
  "commercial fields remain optional and whitespace normalizes to null",
);
assert.deepEqual(
  customerCommercialProfileSchema.parse({ businessName: "", taxId: "0801-1999-123456", city: "" }),
  { businessName: null, taxId: "08011999123456", city: null },
  "partial registration is valid and RTN is canonical",
);
assert.equal(
  customerCommercialProfileSchema.safeParse({ businessName: "", taxId: "0801199912345", city: "" }).success,
  false,
  "invalid RTN is rejected",
);

console.log("Customer commercial profile structural regression: OK");
