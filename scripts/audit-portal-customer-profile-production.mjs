import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const mode = process.argv[2] ?? "pre";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(url && serviceKey, "Missing production Supabase environment.");

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const digest = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
const accountTargets = new Map([
  ["1d2e1e7c79b5", "create"],
  ["29910216059c", "create"],
  ["5623f2b268b8", "review"],
]);
const reviewCustomerHash = "8c2e714515ac";
const protectedCustomerHash = "6301180d309c";
const protectedAccountHash = "1a83977788b2";

const normalizeEmail = (value) => String(value ?? "").trim().toLowerCase() || null;
const normalizePhone = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits || /^0+$/.test(digits)) return null;
  if (digits.length === 8) return digits;
  if (digits.length === 11 && digits.startsWith("504")) return digits.slice(-8);
  return null;
};
const normalizeTaxId = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length === 14 ? digits : null;
};

async function rows(query, label) {
  const { data, error } = await query;
  assert.ifError(error, label);
  return data ?? [];
}

async function optionalRows(query, label) {
  const { data, error } = await query;
  if (error && ["42P01", "PGRST204", "PGRST205"].includes(error.code)) return [];
  assert.ifError(error, label);
  return data ?? [];
}

async function count(table, configure = (query) => query) {
  const { count: value, error } = await configure(admin.from(table).select("*", { count: "exact", head: true }));
  assert.ifError(error, `count ${table}`);
  return value ?? 0;
}

async function authUsers() {
  const users = [];
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
    assert.ifError(error);
    users.push(...data.users);
    if (data.users.length < 100) break;
  }
  return users;
}

const [profiles, customers, authAccounts] = await Promise.all([
  rows(admin.from("users").select("id,email,phone,full_name,active,roles(name)"), "profiles"),
  rows(
    admin
      .from("customers")
      .select(
        "id,user_id,email,phone,tax_id,source,status,active,is_wholesale,wholesale_status,wholesale_customer_type,commercial_version",
      ),
    "customers",
  ),
  authUsers(),
]);

const authById = new Map(authAccounts.map((account) => [account.id, account]));
const targetAccounts = profiles.filter((profile) => accountTargets.has(digest(profile.id)));
assert.equal(targetAccounts.length, accountTargets.size, "One or more target account fingerprints are not unique.");

const protectedCustomers = customers.filter((customer) => digest(customer.id) === protectedCustomerHash);
const protectedAccounts = profiles.filter((profile) => digest(profile.id) === protectedAccountHash);
assert.equal(protectedCustomers.length, 1, "Protected Polarizados customer fingerprint mismatch.");
assert.equal(protectedAccounts.length, 1, "Protected Polarizados account fingerprint mismatch.");

const protectedCustomer = protectedCustomers[0];
const protectedAccount = protectedAccounts[0];
const protectedCredit = await rows(
  admin
    .from("customer_credit_accounts")
    .select("customer_id,is_credit_enabled,credit_limit,terms_days,status")
    .eq("customer_id", protectedCustomer.id),
  "protected credit",
);
assert.equal(protectedCustomer.user_id, protectedAccount.id, "Protected Polarizados link changed.");
assert.equal(protectedCustomer.commercial_version, 5, "Protected Polarizados commercial version changed.");
assert.equal(protectedCustomer.is_wholesale, true, "Protected Polarizados wholesale flag changed.");
assert.equal(protectedCustomer.wholesale_status, "approved", "Protected Polarizados wholesale status changed.");
assert.equal(protectedCustomer.wholesale_customer_type, "existing", "Protected Polarizados wholesale type changed.");
assert.equal(protectedCredit.length, 1, "Protected Polarizados credit account count changed.");
assert.equal(protectedCredit[0].is_credit_enabled, true);
assert.equal(protectedCredit[0].status, "active");
assert.equal(Number(protectedCredit[0].credit_limit), 20000);
assert.equal(protectedCredit[0].terms_days, 30);

const targetReport = [];
for (const profile of targetAccounts) {
  const accountHash = digest(profile.id);
  const expected = accountTargets.get(accountHash);
  const authAccount = authById.get(profile.id);
  assert.ok(authAccount, `Auth account missing for acct#${accountHash}`);
  const linked = customers.filter((customer) => customer.user_id === profile.id);
  const email = normalizeEmail(authAccount.email ?? profile.email);
  const phone = normalizePhone(profile.phone ?? authAccount.user_metadata?.phone);
  const taxId = normalizeTaxId(authAccount.user_metadata?.tax_id ?? authAccount.user_metadata?.rtn);
  const candidates = customers.filter(
    (customer) =>
      (email && normalizeEmail(customer.email) === email) ||
      (phone && normalizePhone(customer.phone) === phone) ||
      (taxId && normalizeTaxId(customer.tax_id) === taxId),
  );
  const syncRows = await optionalRows(
    admin
      .from("portal_customer_profile_syncs")
      .select("state,customer_id,candidate_customer_id,candidate_count,matched_fields")
      .eq("portal_user_id", profile.id),
    "target sync",
  );
  const reviewRows = await optionalRows(
    admin
      .from("portal_customer_link_reviews")
      .select("status,candidate_customer_id,candidate_count,matched_fields")
      .eq("portal_user_id", profile.id),
    "target review",
  );

  if (mode === "post" && expected === "create") {
    assert.equal(linked.length, 1, `acct#${accountHash} was not linked to exactly one customer.`);
    assert.equal(linked[0].source, "portal_registration");
    assert.equal(linked[0].is_wholesale, false);
    assert.equal(linked[0].wholesale_status, "none");
    const creditCount = await count("customer_credit_accounts", (query) => query.eq("customer_id", linked[0].id));
    assert.equal(creditCount, 0, `acct#${accountHash} received credit unexpectedly.`);
  }

  if (expected === "review") {
    assert.equal(linked.length, 0, `acct#${accountHash} must remain unlinked.`);
    assert.ok(candidates.some((candidate) => digest(candidate.id) === reviewCustomerHash));
    if (mode === "post") {
      assert.equal(reviewRows.filter((review) => review.status === "pending").length, 1);
    }
  }

  targetReport.push({
    account: `acct#${accountHash}`,
    expected,
    role: profile.roles?.name ?? null,
    active: profile.active,
    emailConfirmed: Boolean(authAccount.email_confirmed_at || authAccount.confirmed_at),
    linkedCustomers: linked.map((customer) => `cust#${digest(customer.id)}`),
    candidates: candidates.map((candidate) => `cust#${digest(candidate.id)}`),
    syncState: syncRows[0]?.state ?? null,
    pendingReview: reviewRows.some((review) => review.status === "pending"),
  });
}

const clientProfiles = profiles.filter((profile) => profile.roles?.name === "cliente");
const linkedClientAccounts = clientProfiles.filter((profile) => customers.some((customer) => customer.user_id === profile.id));
const orphanedClientAccounts = clientProfiles.filter((profile) => !customers.some((customer) => customer.user_id === profile.id));
const orphanSummary = orphanedClientAccounts.map((profile) => {
  const authAccount = authById.get(profile.id);
  const email = normalizeEmail(authAccount?.email ?? profile.email);
  const phone = normalizePhone(profile.phone ?? authAccount?.user_metadata?.phone);
  const taxId = normalizeTaxId(authAccount?.user_metadata?.tax_id ?? authAccount?.user_metadata?.rtn);
  const candidates = customers.filter(
    (customer) =>
      (email && normalizeEmail(customer.email) === email) ||
      (phone && normalizePhone(customer.phone) === phone) ||
      (taxId && normalizeTaxId(customer.tax_id) === taxId),
  );
  return {
    account: `acct#${digest(profile.id)}`,
    active: profile.active,
    emailConfirmed: Boolean(authAccount?.email_confirmed_at || authAccount?.confirmed_at),
    candidateCount: candidates.length,
    candidates: candidates.map((candidate) => `cust#${digest(candidate.id)}`),
    inAuthorizedRecovery: accountTargets.has(digest(profile.id)),
  };
});
const operationalCounts = {};
for (const table of [
  "orders",
  "payments",
  "invoices",
  "accounts_receivable",
  "inventory_movements",
  "financial_events",
  "journal_entries",
  "pos_sale_drafts",
]) {
  operationalCounts[table] = await count(table);
}

console.log(
  JSON.stringify(
    {
      mode,
      generatedAt: new Date().toISOString(),
      accounts: {
        clients: clientProfiles.length,
        linked: linkedClientAccounts.length,
        orphaned: clientProfiles.length - linkedClientAccounts.length,
        orphanSummary,
      },
      targets: targetReport,
      protected: {
        customer: `cust#${protectedCustomerHash}`,
        account: `acct#${protectedAccountHash}`,
        commercialVersion: protectedCustomer.commercial_version,
        wholesale: `${protectedCustomer.wholesale_status}/${protectedCustomer.wholesale_customer_type}`,
        credit: `${Number(protectedCredit[0].credit_limit).toFixed(2)}/${protectedCredit[0].terms_days}`,
      },
      operationalCounts,
    },
    null,
    2,
  ),
);
