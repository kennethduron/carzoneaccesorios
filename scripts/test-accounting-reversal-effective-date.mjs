import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const migration = read("supabase/migrations/202608040003_accounting_reversal_effective_date_v2.sql");
const repair = read("supabase/migrations/202608040004_repair_technical_duplicate_reversal_dates.sql");
const retirement = read("supabase/migrations/202608040005_retire_legacy_accounting_reversal_rpc.sql");
const action = read("src/app/admin/contabilidad/actions.ts");
const service = read("src/services/supabase/accounting-reversal.service.ts");
const validation = read("src/lib/validation/accounting-reversal.ts");
const ui = read("src/components/admin/accounting-manager.tsx");
const civilDate = read("src/lib/civil-date.ts");

assert.match(migration, /reverse_journal_entry_v2\s*\(/);
assert.match(migration, /p_effective_date date/);
assert.match(migration, /p_request_key uuid/);
assert.match(migration, /p_expected_version bigint/);
assert.match(migration, /accounting_reversal_requests/);
assert.match(migration, /REVERSAL_EFFECTIVE_DATE_REQUIRED/);
assert.match(migration, /REVERSAL_ACCOUNTING_PERIOD_CLOSED/);
assert.match(migration, /REVERSAL_VERSION_CONFLICT/);
assert.match(migration, /reversal_effective_date/);
assert.match(migration, /reversal_technical_created_at/);
assert.match(migration, /grant execute on function public\.reverse_journal_entry_v2[^;]+to authenticated/s);
assert.doesNotMatch(migration, /reversal_entry_date\s+date\s*:=\s*\(now\(\)/);

assert.match(action, /requirePermission\("accounting:reverse"\)/);
assert.match(action, /accountingReversalSchema\.safeParse\(input\)/);
assert.match(action, /reverseJournalEntryWithEffectiveDate/);
assert.doesNotMatch(action, /rpc\("reverse_journal_entry"/);
assert.match(service, /import "server-only"/);
assert.match(service, /rpc\("reverse_journal_entry_v2"/);
assert.match(service, /p_effective_date: input\.effectiveDate/);
assert.match(validation, /effectiveDate: z\.string\(\)\.refine\(isCivilDate/);
assert.match(validation, /requestKey: z\.string\(\)\.uuid/);

assert.match(ui, /Fecha efectiva de la reversión/);
assert.match(ui, /Fecha contable original/);
assert.match(ui, /Esta reversión se registrará contablemente el/);
assert.match(ui, /La fecha técnica de creación quedará registrada/);
assert.match(ui, /crypto\.randomUUID\(\)/);
assert.match(ui, /reversalReviewConfirmed/);
assert.match(ui, /data\.closedPeriods/);
assert.doesNotMatch(ui, /new Date\(reversalEffectiveDate\)/);
assert.match(civilDate, /Date\.UTC/);

for (const id of [
  "dcf4d9ef-3d2c-4182-b525-bdfc329fa362",
  "2be246f3-458a-45bf-bb28-04abfc293d52",
  "717b01ae-2c84-4d65-8a31-b08094f83256",
  "90d8668c-fd9b-4bcb-baa9-9382f32393f1",
  "32c7e93e-6a5b-4105-9c04-5047489df945",
  "a0994cc6-90f9-4d0e-8711-adbdde18049e",
]) assert.match(repair, new RegExp(id));

assert.match(repair, /authorization_reference constant text := 'ACCOUNTING_AND_OWNER_AUTHORIZATION_CONFIRMED_2026-08-04'/);
assert.doesNotMatch(repair, /ACCOUNTING_WRITTEN_AUTHORIZATION_REQUIRED/);
assert.match(repair, /get diagnostics affected_rows = row_count/);
assert.match(repair, /if affected_rows <> 2/);
assert.match(repair, /guard_hash_after <> guard_hash_before/);
assert.match(repair, /ACCOUNTING_TECHNICAL_DUPLICATE_REVERSAL_DATE_REPAIR/);
assert.match(repair, /TECHNICAL_DUPLICATE_REVERSED_IN_WRONG_PERIOD/);
assert.match(repair, /2026-08-03/);
assert.match(repair, /2026-07-31/);
assert.doesNotMatch(repair, /disable trigger all/i);

assert.match(retirement, /REVERSAL_EFFECTIVE_DATE_REQUIRED: use reverse_journal_entry_v2/);
assert.doesNotMatch(retirement, /now\(\).*America\/Tegucigalpa/s);

console.log("Accounting reversal effective-date structural contract: PASS");
