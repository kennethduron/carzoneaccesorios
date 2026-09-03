import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assertStage6LocalEnvironment, readStage6LocalStatus } from "./pos-stage-6-local-guard.mjs";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required.");
const password = process.env.PHASE3_BROWSER_TEST_PASSWORD;
if (!password || password.length < 12) throw new Error("PHASE3_BROWSER_TEST_PASSWORD with at least 12 characters is required.");
const mode = process.argv[2] ?? "setup";
assert.ok(["setup", "cleanup"].includes(mode));
const environment = assertStage6LocalEnvironment();
const status = readStage6LocalStatus();
const service = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const adminEmail = "phase3-browser-admin@example.test";
const sellerEmail = "phase3-browser-seller@example.test";

function sql(query) {
  return execFileSync("docker", ["exec", environment.container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", query], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function usersByEmail() {
  const result = await service.from("users").select("id,email").in("email", [adminEmail, sellerEmail]);
  assert.ifError(result.error);
  return result.data;
}

if (mode === "cleanup") {
  const users = await usersByEmail();
  if (users.length) {
    sql(`begin; select set_config('app.commission_internal','on',true); delete from public.sales_commission_rules where seller_user_id in (${users.map((user) => `'${user.id}'::uuid`).join(",")}); commit;`);
    for (const user of users) assert.ifError((await service.auth.admin.deleteUser(user.id)).error);
  }
  console.log("Phase 3 browser fixtures removed.");
  process.exit(0);
}

await (async () => {
  const existing = await usersByEmail();
  for (const user of existing) {
    sql(`begin; select set_config('app.commission_internal','on',true); delete from public.sales_commission_rules where seller_user_id='${user.id}'::uuid; commit;`);
    assert.ifError((await service.auth.admin.deleteUser(user.id)).error);
  }
  const roles = await service.from("roles").select("id,name").in("name", ["admin", "vendedor"]);
  assert.ifError(roles.error);
  const adminRole = roles.data.find((role) => role.name === "admin");
  const sellerRole = roles.data.find((role) => role.name === "vendedor");
  assert.ok(adminRole && sellerRole);
  const created = [];
  for (const [email, fullName, roleId] of [[adminEmail, "María Rodríguez", adminRole.id], [sellerEmail, "Carlos Martínez", sellerRole.id]]) {
    const user = await service.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
    assert.ifError(user.error);
    assert.ifError((await service.from("users").update({ role_id: roleId, full_name: fullName, active: true }).eq("id", user.data.user.id)).error);
    created.push(user.data.user);
  }
  const actor = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  assert.ifError((await actor.auth.signInWithPassword({ email: adminEmail, password })).error);
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Tegucigalpa", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const rule = await actor.rpc("create_sales_commission_rule_v1", { p_request_key: randomUUID(), p_seller_user_id: created[1].id, p_rule_type: "PERCENTAGE", p_rule_value: 5, p_effective_date: date, p_reason: "Regla local para certificación visual de Phase 3." });
  assert.ifError(rule.error);
  console.log("Phase 3 browser fixtures ready.");
})();
