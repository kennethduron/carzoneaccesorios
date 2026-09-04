import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assertStage6LocalEnvironment, readStage6LocalStatus } from "./pos-stage-6-local-guard.mjs";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required.");
const environment = assertStage6LocalEnvironment();
const status = readStage6LocalStatus();
const service = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const marker = `PHASE4-RACE-${Date.now()}`;
const password = `Cz-${randomUUID()}!a9`;
const userIds = [];
let policyId = null;

function sql(query) {
  return execFileSync("docker", ["exec", environment.container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", query], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function hnDate(days = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
async function createUser(label, roleId) {
  const result = await service.auth.admin.createUser({ email: `${marker}-${label}@example.test`, password, email_confirm: true, user_metadata: { full_name: `${marker} ${label}` } });
  assert.ifError(result.error);
  userIds.push(result.data.user.id);
  const update = await service.from("users").update({ role_id: roleId, active: true }).eq("id", result.data.user.id);
  assert.ifError(update.error);
  return result.data.user;
}

try {
  const roles = await service.from("roles").select("id,name").in("name", ["admin", "vendedor"]);
  assert.ifError(roles.error);
  const adminRole = roles.data.find((role) => role.name === "admin");
  const sellerRole = roles.data.find((role) => role.name === "vendedor");
  assert.ok(adminRole && sellerRole, "Phase 4 roles must exist after migration.");
  const adminUser = await createUser("admin", adminRole.id);
  const sellers = [await createUser("seller-a", sellerRole.id), await createUser("seller-b", sellerRole.id)];
  const actor = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  assert.ifError((await actor.auth.signInWithPassword({ email: adminUser.email, password })).error);

  const policy = await actor.rpc("create_commission_policy_v1", { p_request_key: randomUUID(), p_name: `${marker} policy`, p_rule_type: "PERCENTAGE", p_rule_value: 5, p_description: "Concurrent bulk assignment certification policy." });
  assert.ifError(policy.error);
  policyId = policy.data.policyId;
  const sellerIds = sellers.map((seller) => seller.id);
  const effectiveDate = hnDate(7);
  const preview = await actor.rpc("preview_commission_policy_assignment_v1", { p_policy_id: policyId, p_seller_ids: sellerIds, p_effective_date: effectiveDate });
  assert.ifError(preview.error);
  assert.equal(preview.data.willCreate, 2);

  const requestKey = randomUUID();
  const input = { p_request_key: requestKey, p_policy_id: policyId, p_seller_ids: sellerIds, p_effective_date: effectiveDate, p_reason: "Concurrent double-submit certification for Phase 4.", p_preview_token: preview.data.previewToken };
  const race = await Promise.all([actor.rpc("apply_commission_policy_assignment_v1", input), actor.rpc("apply_commission_policy_assignment_v1", input)]);
  race.forEach((result) => assert.ifError(result.error));
  assert.equal(race.filter((result) => result.data.idempotentReplay === true).length, 1, "Exactly one concurrent request replays the committed operation.");
  assert.equal(race.filter((result) => result.data.idempotentReplay === false).length, 1, "Exactly one concurrent request creates the operation.");

  const operations = await service.from("sales_commission_assignment_operations").select("id,created_count").eq("request_key", requestKey);
  assert.ifError(operations.error);
  assert.equal(operations.data.length, 1, "Concurrent submit creates one operation.");
  assert.equal(operations.data[0].created_count, 2, "The single operation creates both seller versions.");
  const rules = await service.from("sales_commission_rules").select("seller_user_id").eq("assignment_operation_id", operations.data[0].id);
  assert.ifError(rules.error);
  assert.equal(rules.data.length, 2, "No duplicate or partial seller rule versions are created.");
  assert.equal(new Set(rules.data.map((row) => row.seller_user_id)).size, 2, "Each selected seller receives one immutable rule.");
  console.log("Phase 4 concurrency: atomic bulk double-submit creates one operation and one rule per seller");
} finally {
  if (policyId) sql(`begin; select set_config('app.phase4_internal','on',true); select set_config('app.commission_internal','on',true); delete from public.sales_commission_assignment_items where operation_id in (select id from public.sales_commission_assignment_operations where policy_id='${policyId}'::uuid); delete from public.sales_commission_rules where policy_id='${policyId}'::uuid; delete from public.sales_commission_assignment_operations where policy_id='${policyId}'::uuid; delete from public.sales_commission_policy_events where policy_id='${policyId}'::uuid; alter table public.sales_commission_policies disable trigger sales_commission_policies_immutable; delete from public.sales_commission_policies where id='${policyId}'::uuid; alter table public.sales_commission_policies enable trigger sales_commission_policies_immutable; commit;`);
  for (const userId of userIds) await service.auth.admin.deleteUser(userId);
}
