import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";

const envFile = await readFile(new URL("../.env.local", import.meta.url), "utf8");
const env = Object.fromEntries(
  envFile
    .split(/\r?\n/)
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(line))
    .map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
);

assert.ok(env.NEXT_PUBLIC_SUPABASE_URL, "Missing NEXT_PUBLIC_SUPABASE_URL");
assert.ok(env.SUPABASE_SERVICE_ROLE_KEY, "Missing SUPABASE_SERVICE_ROLE_KEY");

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const runId = `${Date.now()}`;
const customerIds = [];
const followupIds = [];
let phoneSeed = Number(runId.slice(-6));

function testEmail(label) {
  return `cz-public-form-${runId}-${label}@example.com`;
}

function nextPhone() {
  phoneSeed += 1;
  return `+5043${String(phoneSeed % 10_000_000).padStart(7, "0")}`;
}

async function createCustomer(label, wholesaleStatus, overrides = {}) {
  const input = {
    contact_name: `CZ Test ${label}`,
    email: testEmail(label),
    phone: nextPhone(),
    notes: `[CZ_PUBLIC_FORM_TEST:${runId}]`,
    lead_status: "prospecto",
    source: "test",
    estimated_value: 0,
    monthly_amount: 0,
    is_wholesale: false,
    wholesale_status: wholesaleStatus,
    status: wholesaleStatus === "pending" ? "pending_account" : "active",
    active: true,
    ...overrides,
  };
  const { data, error } = await supabase.from("customers").insert(input).select("id, email, phone").single();
  assert.ifError(error);
  customerIds.push(data.id);
  return data;
}

async function rpc(name, args) {
  const { data, error } = await supabase.rpc(name, args);
  assert.ifError(error);
  assert.equal(Array.isArray(data), true, `${name} must return a row array`);
  assert.ok(data[0], `${name} must return one result row`);
  if (data[0].followup_id) {
    followupIds.push(data[0].followup_id);
  }
  if (data[0].customer_id && !customerIds.includes(data[0].customer_id)) {
    customerIds.push(data[0].customer_id);
  }
  return data[0];
}

async function assertCustomerStatus(customerId, expected) {
  const { data, error } = await supabase.from("customers").select("wholesale_status").eq("id", customerId).single();
  assert.ifError(error);
  assert.equal(data.wholesale_status, expected);
}

async function assertTrackedFollowup(row, label) {
  assert.ok(row.followup_id, `${label} must create or retain a CRM followup`);
  assert.ok(row.due_at, `${label} must have due_at`);
  const dueAt = new Date(row.due_at).getTime();
  assert.ok(dueAt > Date.now() + 23 * 60 * 60 * 1000, `${label} due_at must be close to 24 hours`);
}

try {
  const { data: settings, error: settingsError } = await supabase
    .from("company_settings")
    .select("notify_general_contact, notify_wholesale_requests")
    .limit(1)
    .maybeSingle();
  assert.ifError(settingsError);
  assert.equal(typeof settings?.notify_general_contact, "boolean");
  assert.equal(typeof settings?.notify_wholesale_requests, "boolean");

  const generalNew = await rpc("submit_public_general_contact", {
    p_contact_name: "CZ Test general new",
    p_email: testEmail("general-new"),
    p_phone: nextPhone(),
    p_message: "Consulta general de prueba.",
    p_ip_address: "127.0.0.1",
    p_user_agent: "cz-public-form-test",
  });
  await assertTrackedFollowup(generalNew, "new general contact");

  for (const status of ["pending", "approved", "suspended", "rejected"]) {
    const customer = await createCustomer(`general-${status}`, status);
    const row = await rpc("submit_public_general_contact", {
      p_contact_name: `CZ Test general ${status}`,
      p_email: customer.email,
      p_phone: customer.phone,
      p_message: `Consulta general para ${status}.`,
      p_ip_address: "127.0.0.1",
      p_user_agent: "cz-public-form-test",
    });
    assert.equal(row.customer_id, customer.id);
    await assertTrackedFollowup(row, `general contact for ${status}`);
    await assertCustomerStatus(customer.id, status);
  }

  const wholesaleNew = await rpc("submit_public_wholesale_request", {
    p_business_name: "CZ Test new wholesale",
    p_contact_name: "CZ Test wholesale new",
    p_email: testEmail("wholesale-new"),
    p_phone: nextPhone(),
    p_city: "Tegucigalpa",
    p_tax_id: null,
    p_comment: "Solicitud nueva.",
    p_ip_address: "127.0.0.1",
    p_user_agent: "cz-public-form-test",
  });
  assert.equal(wholesaleNew.outcome, "created");
  await assertTrackedFollowup(wholesaleNew, "new wholesale request");
  await assertCustomerStatus(wholesaleNew.customer_id, "pending");

  for (const status of ["pending", "approved", "suspended", "rejected"]) {
    const customer = await createCustomer(`wholesale-${status}`, status);
    const row = await rpc("submit_public_wholesale_request", {
      p_business_name: `CZ Test wholesale ${status}`,
      p_contact_name: `CZ Test wholesale ${status}`,
      p_email: customer.email,
      p_phone: customer.phone,
      p_city: "San Pedro Sula",
      p_tax_id: null,
      p_comment: `Solicitud para ${status}.`,
      p_ip_address: "127.0.0.1",
      p_user_agent: "cz-public-form-test",
    });
    const expectedOutcome = status === "rejected" ? "rejected_review" : status;
    assert.equal(row.outcome, expectedOutcome, `${status} must produce ${expectedOutcome}`);
    await assertCustomerStatus(customer.id, status);
    if (status === "pending" || status === "rejected") {
      await assertTrackedFollowup(row, `wholesale request for ${status}`);
    } else {
      assert.equal(row.followup_id, null, `${status} must not create a new followup`);
    }
  }

  const { data: auditRows, error: auditError } = await supabase
    .from("audit_logs")
    .select("action")
    .in("record_id", [...customerIds, ...followupIds]);
  assert.ifError(auditError);
  const actions = new Set(auditRows.map((row) => row.action));
  assert.equal(actions.has("public_form.contact_general.submitted"), true);
  assert.equal(actions.has("public_form.wholesale.submitted"), true);
  assert.equal(actions.has("public_form.wholesale.duplicate_pending"), true);
  assert.equal(actions.has("public_form.wholesale.overwrite_blocked"), true);

  console.log("Remote public contact workflow checks passed.");
} finally {
  if (customerIds.length > 0 || followupIds.length > 0) {
    await supabase.from("audit_logs").delete().in("record_id", [...customerIds, ...followupIds]);
  }
  if (customerIds.length > 0) {
    await supabase.from("customers").delete().in("id", customerIds);
  }
}
