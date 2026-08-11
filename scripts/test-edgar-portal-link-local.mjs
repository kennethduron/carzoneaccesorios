import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { assertStage6LocalEnvironment, readStage6LocalStatus } from "./pos-stage-6-local-guard.mjs";

const guard = assertStage6LocalEnvironment();
const status = readStage6LocalStatus();
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const marker = `PORTAL-LINK-EDGAR-${Date.now()}-LOCAL-ONLY`;
const password = "Portal-Link-Local-Only!2026";

async function role(name, permissions) {
  const result = await admin.from("roles").upsert({ name, description: `${marker} ${name}`, permissions }, { onConflict: "name" })
    .select("id").single();
  assert.ifError(result.error);
  return result.data.id;
}
const adminRoleId = await role("admin", ["customers:link_portal_account", "customers:read_commercial"]);
const sellerRoleId = await role("vendedor", ["customers:read_commercial"]);
const customerRoleId = await role("cliente", []);

async function account(suffix, roleId) {
  const email = `${marker.toLowerCase()}-${suffix.toLowerCase()}@example.test`;
  const created = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
    user_metadata: { full_name: `${marker} ${suffix}`, phone: "99990000" },
  });
  assert.ifError(created.error);
  assert.ifError((await admin.from("users").update({ role_id: roleId, active: true, phone: "99990000" })
    .eq("id", created.data.user.id)).error);
  return { id: created.data.user.id, email };
}

const operatorAccount = await account("OPERATOR", adminRoleId);
const sellerAccount = await account("SELLER", sellerRoleId);
const portalOne = await account("PORTAL-ONE", customerRoleId);
const portalTwo = await account("PORTAL-TWO", customerRoleId);
const operator = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const seller = createClient(status.API_URL, status.ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
assert.ifError((await operator.auth.signInWithPassword({ email: operatorAccount.email, password })).error);
assert.ifError((await seller.auth.signInWithPassword({ email: sellerAccount.email, password })).error);

async function customer(suffix, email) {
  const result = await admin.from("customers").insert({
    contact_name: `${marker} ${suffix}`,
    email,
    phone: "99990000",
    source: "pos",
    lead_status: "cliente",
    status: "active",
    active: true,
  }).select("id,user_id,commercial_version").single();
  assert.ifError(result.error);
  return result.data;
}

const customerOne = await customer("CUSTOMER-ONE", "different-one@example.test");
const customerTwo = await customer("CUSTOMER-TWO", "different-two@example.test");
const matchingButUnlinked = await customer("MATCHING-NO-AUTO-LINK", portalTwo.email);
assert.equal(matchingButUnlinked.user_id, null, "matching email does not auto-link");

const economicTables = ["orders", "invoices", "payments", "accounts_receivable", "inventory_movements", "journal_entries"];
async function counts() {
  return Object.fromEntries(await Promise.all(economicTables.map(async (table) => {
    const result = await admin.from(table).select("id", { count: "exact", head: true });
    assert.ifError(result.error);
    return [table, result.count];
  })));
}
const economicsBefore = await counts();
const authBefore = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
assert.ifError(authBefore.error);

function linkArgs(customerRow, portal, requestKey = crypto.randomUUID()) {
  return {
    p_request_key: requestKey,
    p_customer_id: customerRow.id,
    p_portal_user_id: portal.id,
    p_expected_commercial_version: customerRow.commercial_version,
    p_evidence_source: "manual_verified_identity",
    p_evidence_reference: `manual:${customerRow.id}:${portal.id}`,
    p_reason: `${marker} identidad verificada manualmente por documento local`,
  };
}

const requestKey = crypto.randomUUID();
const firstLinkArgs = linkArgs(customerOne, portalOne, requestKey);
const firstLink = await operator.rpc("link_customer_portal_account_v2", firstLinkArgs);
assert.ifError(firstLink.error);
assert.equal(firstLink.data.code, "PORTAL_LINK_COMPLETED");
assert.equal(firstLink.data.idempotentReplay, false);
const replay = await operator.rpc("link_customer_portal_account_v2", firstLinkArgs);
assert.ifError(replay.error);
assert.equal(replay.data.idempotentReplay, true);

const linkedCustomer = await admin.from("customers").select("user_id,commercial_version")
  .eq("id", customerOne.id).single();
assert.ifError(linkedCustomer.error);
assert.equal(linkedCustomer.data.user_id, portalOne.id);
assert.equal(linkedCustomer.data.commercial_version, customerOne.commercial_version + 1);

const accountConflict = await operator.rpc("link_customer_portal_account_v2", linkArgs(customerTwo, portalOne));
assert.equal(accountConflict.error?.message, "PORTAL_LINK_ACCOUNT_CONFLICT");
const customerConflict = await operator.rpc("link_customer_portal_account_v2", linkArgs(customerOne, portalTwo));
assert.equal(customerConflict.error?.message, "PORTAL_LINK_CUSTOMER_CONFLICT");
const forbidden = await seller.rpc("link_customer_portal_account_v2", linkArgs(matchingButUnlinked, portalTwo));
assert.equal(forbidden.error?.message, "PORTAL_LINK_FORBIDDEN");

const explicitSecondLink = await operator.rpc("link_customer_portal_account_v2", linkArgs(matchingButUnlinked, portalTwo));
assert.ifError(explicitSecondLink.error);
assert.equal(explicitSecondLink.data.code, "PORTAL_LINK_COMPLETED");

const [history, audit, linkedProfiles, authAfter] = await Promise.all([
  admin.from("customer_portal_link_history").select("id,contact_evidence")
    .eq("customer_id", customerOne.id).eq("portal_user_id", portalOne.id),
  admin.from("audit_logs").select("id,new_data")
    .eq("record_id", customerOne.id).eq("action", "customer_portal_link.linked_v2"),
  admin.from("customers").select("id", { count: "exact", head: true }).eq("user_id", portalOne.id),
  admin.auth.admin.listUsers({ page: 1, perPage: 1000 }),
]);
assert.ifError(history.error);
assert.ifError(audit.error);
assert.ifError(linkedProfiles.error);
assert.ifError(authAfter.error);
assert.equal(history.data.length, 1, "replay keeps append-only history singular");
assert.equal(history.data[0].contact_evidence.usedAsAuthority, false, "email/phone match is informational only");
assert.equal(audit.data.length, 1, "replay keeps audit singular");
assert.equal(linkedProfiles.count, 1, "portal account remains one-to-one");
assert.equal(authAfter.data.users.length, authBefore.data.users.length, "link RPC creates no Auth users");
assert.deepEqual(await counts(), economicsBefore, "portal linking creates no economic rows");

console.log("Edgar visitor portal link local certification: PASS", {
  guard,
  marker,
  noAutoLink: true,
  explicitEligibleCandidate: true,
  accountConflict: true,
  customerConflict: true,
  wrongRoleDenied: true,
  replay: true,
  historyAndAudit: true,
  authAutoCreate: false,
  economicsStable: true,
});
