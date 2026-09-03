import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { assertStage6LocalEnvironment, readStage6LocalStatus } from "./pos-stage-6-local-guard.mjs";

if (process.env.ALLOW_LOCAL_MUTATING_TESTS !== "true") throw new Error("ALLOW_LOCAL_MUTATING_TESTS=true is required.");
const environment = assertStage6LocalEnvironment();
const status = readStage6LocalStatus();
const service = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const marker = `PHASE3-RACE-${Date.now()}`;
const password = `Cz-${randomUUID()}!a9`;
const userIds = [];
let orderId = null;

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
  assert.ok(adminRole && sellerRole, "Phase 3 roles must exist after migration.");
  const adminUser = await createUser("admin", adminRole.id);
  const sellerA = await createUser("seller-a", sellerRole.id);
  const sellerB = await createUser("seller-b", sellerRole.id);

  const actor = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  assert.ifError((await actor.auth.signInWithPassword({ email: adminUser.email, password })).error);
  for (const [seller, value] of [[sellerA, 5], [sellerB, 7]]) {
    const created = await actor.rpc("create_sales_commission_rule_v1", { p_request_key: randomUUID(), p_seller_user_id: seller.id, p_rule_type: "PERCENTAGE", p_rule_value: value, p_effective_date: hnDate(), p_reason: `${marker} regla inicial auditada.` });
    assert.ifError(created.error);
  }

  const futureDate = hnDate(5);
  const ruleRace = await Promise.all([
    actor.rpc("create_sales_commission_rule_v1", { p_request_key: randomUUID(), p_seller_user_id: sellerA.id, p_rule_type: "PERCENTAGE", p_rule_value: 6, p_effective_date: futureDate, p_reason: `${marker} carrera futura uno.` }),
    actor.rpc("create_sales_commission_rule_v1", { p_request_key: randomUUID(), p_seller_user_id: sellerA.id, p_rule_type: "PERCENTAGE", p_rule_value: 6.5, p_effective_date: futureDate, p_reason: `${marker} carrera futura dos.` }),
  ]);
  assert.equal(ruleRace.filter((result) => !result.error).length, 1, "Exactly one concurrent future rule must win.");
  assert.equal(ruleRace.filter((result) => result.error?.message.includes("COMMISSION_RULE_FUTURE_ALREADY_EXISTS")).length, 1, "The losing concurrent rule must fail closed.");

  orderId = randomUUID();
  sql(`begin; select set_config('request.jwt.claim.sub','${sellerA.id}',true); select set_config('request.jwt.claims','{"sub":"${sellerA.id}","role":"authenticated"}',true); insert into public.orders(id,order_number,customer_name,phone,customer_phone,delivery_address,payment_method,price_mode,subtotal,tax,total,status,source,channel,created_by,confirmed_at) values('${orderId}'::uuid,'${marker}-ORDER','${marker}','99990000','99990000','Local','cash','retail',10000,1500,11500,'confirmed','pos','store','${sellerA.id}'::uuid,now()); commit;`);
  const item = await service.from("order_items").insert({ order_id: orderId, sku: `${marker}-SKU`, product_name: marker, quantity: 1, applied_price_mode: "retail", unit_price: 10000, line_total: 10000, retail_price_snapshot: 10000, wholesale_price_snapshot: 9000, tax_category_snapshot: "standard", tax_rate_snapshot: 0.15, taxable_base_snapshot: 10000, tax_amount_snapshot: 1500, exempt_amount_snapshot: 0, tracks_inventory_snapshot: false });
  assert.ifError(item.error);
  const entryId = sql(`select public.create_commission_for_confirmed_order_v1('${orderId}'::uuid);`);
  assert.match(entryId, /^[0-9a-f-]{36}$/i);

  const paymentIds = [randomUUID(), randomUUID()];
  const paymentRace = await Promise.all(paymentIds.map((id) => service.from("payments").insert({ id, order_id: orderId, method: "cash", payment_method: "cash", status: "approved", payment_status: "approved", amount: 5750, paid_at: new Date().toISOString() })));
  paymentRace.forEach((result) => assert.ifError(result.error));
  let entry = await service.from("sales_commission_entries").select("potential_amount,earned_amount,status").eq("id", entryId).single();
  assert.ifError(entry.error);
  assert.deepEqual(entry.data, { potential_amount: 500, earned_amount: 500, status: "EARNED" }, "Concurrent half-payments converge to the full commission.");

  const replayRace = await Promise.all(paymentIds.map((id) => service.from("payments").update({ payment_status: "approved", status: "approved" }).eq("id", id)));
  replayRace.forEach((result) => assert.ifError(result.error));
  entry = await service.from("sales_commission_entries").select("earned_amount,status").eq("id", entryId).single();
  assert.ifError(entry.error);
  assert.deepEqual(entry.data, { earned_amount: 500, status: "EARNED" }, "Concurrent retries do not double earn.");

  const reversalRace = await Promise.all([
    service.from("payments").update({ payment_status: "refunded", status: "refunded" }).eq("id", paymentIds[0]),
    service.from("payments").update({ payment_status: "approved", status: "approved" }).eq("id", paymentIds[1]),
  ]);
  reversalRace.forEach((result) => assert.ifError(result.error));
  entry = await service.from("sales_commission_entries").select("earned_amount,status").eq("id", entryId).single();
  assert.ifError(entry.error);
  assert.deepEqual(entry.data, { earned_amount: 250, status: "PARTIALLY_EARNED" }, "Payment reversal race converges to the canonical net collection.");

  const correctionRace = await Promise.all([
    actor.rpc("correct_pos_order_seller_v1", { p_order_id: orderId, p_seller_user_id: sellerB.id, p_reason: `${marker} reasignación uno auditada.` }),
    actor.rpc("correct_pos_order_seller_v1", { p_order_id: orderId, p_seller_user_id: sellerA.id, p_reason: `${marker} reasignación dos auditada.` }),
  ]);
  correctionRace.forEach((result) => assert.ifError(result.error));
  const activeEntries = await service.from("sales_commission_entries").select("id,seller_id").eq("order_id", orderId).is("superseded_at", null);
  assert.ifError(activeEntries.error);
  assert.equal(activeEntries.data.length, 1, "Concurrent seller corrections leave exactly one active attribution.");
  const orderAfterCorrection = await service.from("orders").select("seller_id").eq("id", orderId).single();
  assert.ifError(orderAfterCorrection.error);
  assert.equal(activeEntries.data[0].seller_id, orderAfterCorrection.data.seller_id, "Active commission always matches the canonical order seller.");
  console.log("Phase 3 concurrency: rule, payment, retry, reversal, and seller-reassignment races OK");
} finally {
  if (orderId) {
    sql(`begin; select set_config('app.commission_internal','on',true); delete from public.sales_commission_events where commission_entry_id in (select id from public.sales_commission_entries where order_id='${orderId}'::uuid); delete from public.sales_commission_entries where order_id='${orderId}'::uuid; delete from public.payments where order_id='${orderId}'::uuid; delete from public.order_items where order_id='${orderId}'::uuid; alter table public.pos_seller_attribution_events disable trigger pos_seller_attribution_events_append_only; delete from public.pos_seller_attribution_events where order_id='${orderId}'::uuid; alter table public.pos_seller_attribution_events enable trigger pos_seller_attribution_events_append_only; delete from public.orders where id='${orderId}'::uuid; commit;`);
  }
  if (userIds.length) sql(`begin; select set_config('app.commission_internal','on',true); delete from public.sales_commission_rules where seller_user_id in (${userIds.map((id) => `'${id}'::uuid`).join(",")}); commit;`);
  for (const userId of userIds) await service.auth.admin.deleteUser(userId);
}
