import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!serviceKey || !anonKey) {
  throw new Error("Define SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY from `supabase status -o env` before running this local-only test.");
}
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const marker = `pos-stage3-${Date.now()}`;
const password = `Cz-${crypto.randomUUID()}!a9`;
const createdAuthIds = [];
const createdCustomerIds = [];

async function count(table) {
  const { count: value, error } = await admin.from(table).select("*", { count: "exact", head: true });
  assert.ifError(error);
  return value ?? 0;
}

async function createActor(role) {
  const email = `${marker}-${role}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: `POS ${role}`, phone: `+5049${String(createdAuthIds.length).padStart(7, "0")}` },
  });
  assert.ifError(error);
  const userId = data.user.id;
  createdAuthIds.push(userId);
  const allowed = ["technical_owner", "business_owner", "admin"].includes(role);
  const permissions = allowed ? [
    "pos:create_sale",
    "pos:apply_discount",
    "pos:access",
    "pos:customers:search",
    "pos:customers:create",
    "pos:customers:update",
    "customers:read_commercial",
    "customers:read_credit",
  ] : [];
  const { data: roleRow, error: roleError } = await admin
    .from("roles")
    .upsert({ name: role, description: `Local POS Stage 3 ${role}`, permissions }, { onConflict: "name" })
    .select("id")
    .single();
  assert.ifError(roleError);
  const { error: updateError } = await admin.from("users").update({ role_id: roleRow.id }).eq("id", userId);
  assert.ifError(updateError);
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);
  return { client, userId, email };
}

async function rpc(client, name, input) {
  const { data, error } = await client.rpc(name, input);
  return { data, error };
}

async function cleanup() {
  await admin.from("pos_idempotency_requests").delete().like("operation", "%pos_customer_v1");
  await admin.from("customer_credit_accounts").delete().in("customer_id", createdCustomerIds.length ? createdCustomerIds : [crypto.randomUUID()]);
  await admin.from("customers").delete().or(`email.like.${marker}%,source.eq.pos-stage3-fixture`);
  for (const userId of createdAuthIds) await admin.auth.admin.deleteUser(userId);
}

try {
  const before = {
    orders: await count("orders"),
    payments: await count("payments"),
    invoices: await count("invoices"),
    inventory: await count("inventory_movements"),
    receivables: await count("accounts_receivable"),
  };

  const adminActor = await createActor("admin");
  for (const role of ["contadora", "vendedor", "bodega", "soporte", "cliente"]) {
    const actor = await createActor(role);
    const denied = await rpc(actor.client, "search_pos_customers_v1", {
      p_query: marker,
      p_limit: 10,
      p_offset: 0,
      p_include_inactive: false,
    });
    assert.equal(denied.data, null, `${role} unexpectedly accessed POS customer search`);
    assert.equal(denied.error?.code, "42501");
  }

  const requestKey = crypto.randomUUID();
  const createInput = {
    p_request_key: requestKey,
    p_contact_name: "Cliente Etapa Tres",
    p_phone: "+504 9876-5432",
    p_email: `${marker}-customer@example.test`,
    p_business_name: "Comercial Etapa Tres",
    p_tax_id: "0801-2000-123456",
    p_address: "Dirección de prueba local",
    p_city: "Tegucigalpa",
    p_commercial_notes: "Nota operativa no sensible",
  };
  const created = await rpc(adminActor.client, "create_pos_customer_v1", createInput);
  assert.ifError(created.error);
  assert.equal(created.data.ok, true);
  assert.equal(created.data.status, "created");
  createdCustomerIds.push(created.data.customerId);

  const replay = await rpc(adminActor.client, "create_pos_customer_v1", createInput);
  assert.ifError(replay.error);
  assert.equal(replay.data.customerId, created.data.customerId);
  assert.equal(replay.data.idempotentReplay, true);

  const conflictingPayload = await rpc(adminActor.client, "create_pos_customer_v1", {
    ...createInput,
    p_contact_name: "Otro nombre",
  });
  assert.equal(conflictingPayload.data, null);
  assert.equal(conflictingPayload.error?.code, "22023");

  const duplicate = await rpc(adminActor.client, "create_pos_customer_v1", {
    ...createInput,
    p_request_key: crypto.randomUUID(),
    p_email: `${marker}-different@example.test`,
  });
  assert.ifError(duplicate.error);
  assert.equal(duplicate.data.status, "duplicate");
  assert.equal(duplicate.data.customerId, created.data.customerId);

  const concurrentPhone = "+1 202 555 0199";
  const concurrentCalls = await Promise.all([
    rpc(adminActor.client, "create_pos_customer_v1", { ...createInput, p_request_key: crypto.randomUUID(), p_email: `${marker}-race-a@example.test`, p_phone: concurrentPhone, p_tax_id: null }),
    rpc(adminActor.client, "create_pos_customer_v1", { ...createInput, p_request_key: crypto.randomUUID(), p_email: `${marker}-race-b@example.test`, p_phone: concurrentPhone, p_tax_id: null }),
  ]);
  concurrentCalls.forEach(({ error }) => assert.ifError(error));
  assert.deepEqual(concurrentCalls.map(({ data }) => data.status).sort(), ["created", "duplicate"]);
  const raceCustomer = concurrentCalls.find(({ data }) => data.status === "created").data.customerId;
  createdCustomerIds.push(raceCustomer);

  const searched = await rpc(adminActor.client, "search_pos_customers_v1", {
    p_query: "Cliente Etapa",
    p_limit: 10,
    p_offset: 0,
    p_include_inactive: false,
  });
  assert.ifError(searched.error);
  assert.ok(searched.data.some((row) => row.customer_id === created.data.customerId));
  assert.ok(searched.data.every((row) => !("tax_id" in row) && !("user_id" in row) && !("address" in row)));

  const context = await rpc(adminActor.client, "get_pos_customer_context_v1", { target_customer_id: created.data.customerId });
  assert.ifError(context.error);
  assert.equal(context.data[0].pricing_mode, "retail");
  assert.equal(context.data[0].credit_status, "not_enabled");
  assert.equal(context.data[0].has_portal_account, false);

  const below = await rpc(adminActor.client, "evaluate_wholesale_eligibility_v1", {
    target_customer_id: created.data.customerId,
    merchandise_final: 9999.99,
  });
  assert.ifError(below.error);
  assert.equal(below.data[0].eligible, false);
  assert.equal(Number(below.data[0].missing_amount), 0.01);
  const threshold = await rpc(adminActor.client, "evaluate_wholesale_eligibility_v1", {
    target_customer_id: created.data.customerId,
    merchandise_final: 10000,
  });
  assert.ifError(threshold.error);
  assert.equal(threshold.data[0].eligible, true);
  assert.equal(threshold.data[0].pricing_mode, "retail");

  const updated = await rpc(adminActor.client, "update_pos_customer_v1", {
    p_request_key: crypto.randomUUID(),
    p_customer_id: created.data.customerId,
    p_expected_commercial_version: created.data.commercialVersion,
    p_contact_name: "Cliente Etapa Tres Editado",
    p_phone: "+504 9876-5432",
    p_email: `${marker}-customer@example.test`,
    p_business_name: "Comercial Etapa Tres",
    p_tax_id: "0801-2000-123456",
    p_address: "Dirección local actualizada",
    p_city: "Tegucigalpa",
    p_commercial_notes: "Actualización controlada",
  });
  assert.ifError(updated.error);
  assert.equal(updated.data.status, "updated");
  assert.ok(updated.data.commercialVersion > created.data.commercialVersion);

  const stale = await rpc(adminActor.client, "update_pos_customer_v1", {
    p_request_key: crypto.randomUUID(),
    p_customer_id: created.data.customerId,
    p_expected_commercial_version: created.data.commercialVersion,
    p_contact_name: "Sobrescritura obsoleta",
    p_phone: "+504 9876-5432",
    p_email: `${marker}-customer@example.test`,
    p_business_name: null,
    p_tax_id: null,
    p_address: null,
    p_city: null,
    p_commercial_notes: null,
  });
  assert.ifError(stale.error);
  assert.equal(stale.data.status, "version_conflict");

  let { data: actorCustomer } = await admin.from("customers").select("id").eq("user_id", adminActor.userId).maybeSingle();
  if (!actorCustomer) {
    const { data, error } = await admin.from("customers").insert({
      user_id: adminActor.userId,
      contact_name: "Mayorista local existente",
      phone: "+504 9900-0001",
      email: adminActor.email,
      business_name: "Mayorista local",
      company_name: "Mayorista local",
      source: "pos-stage3-fixture",
      lead_status: "cliente",
      active: true,
      status: "active",
    }).select("id").single();
    assert.ifError(error);
    actorCustomer = data;
  }
  const { error: wholesaleError } = await admin.from("customers").update({ is_wholesale: true, wholesale_status: "approved" }).eq("id", actorCustomer.id);
  assert.ifError(wholesaleError);
  const approved = await rpc(adminActor.client, "evaluate_wholesale_eligibility_v1", {
    target_customer_id: actorCustomer.id,
    merchandise_final: 500,
  });
  assert.ifError(approved.error);
  assert.equal(approved.data[0].pricing_mode, "wholesale");
  assert.equal(Number(approved.data[0].missing_amount), 0);
  const { error: suspendedError } = await admin.from("customers").update({ wholesale_status: "suspended" }).eq("id", actorCustomer.id);
  assert.ifError(suspendedError);
  const suspended = await rpc(adminActor.client, "resolve_customer_pricing_mode_v1", { target_customer_id: actorCustomer.id });
  assert.ifError(suspended.error);
  assert.equal(suspended.data[0].pricing_mode, "retail");
  assert.equal(suspended.data[0].customer_type, "wholesale");

  const { error: creditError } = await admin.from("customer_credit_accounts").insert({
    customer_id: created.data.customerId,
    is_credit_enabled: true,
    credit_limit: 25000,
    terms_days: 30,
    status: "suspended",
  });
  assert.ifError(creditError);
  const creditContext = await rpc(adminActor.client, "get_pos_customer_context_v1", { target_customer_id: created.data.customerId });
  assert.ifError(creditContext.error);
  assert.equal(creditContext.data[0].credit_status, "suspended");
  assert.equal(creditContext.data[0].can_use_credit, false);

  const volumeRows = Array.from({ length: 3000 }, (_, index) => ({
    contact_name: `${marker} Volumen ${String(index).padStart(4, "0")}`,
    phone: `+120255${String(index).padStart(5, "0")}`,
    email: `${marker}-volume-${index}@example.test`,
    business_name: index === 2999 ? `${marker} Objetivo Especial` : `${marker} Empresa ${index}`,
    company_name: index === 2999 ? `${marker} Objetivo Especial` : `${marker} Empresa ${index}`,
    source: "pos-stage3-fixture",
    lead_status: "cliente",
    active: true,
    status: "active",
  }));
  for (let index = 0; index < volumeRows.length; index += 500) {
    const { error } = await admin.from("customers").insert(volumeRows.slice(index, index + 500));
    assert.ifError(error);
  }
  const volumeSearch = await rpc(adminActor.client, "search_pos_customers_v1", {
    p_query: "Objetivo Especial",
    p_limit: 25,
    p_offset: 0,
    p_include_inactive: false,
  });
  assert.ifError(volumeSearch.error);
  assert.equal(volumeSearch.data.length, 1);
  assert.match(volumeSearch.data[0].business_name, /Objetivo Especial/);

  const after = {
    orders: await count("orders"),
    payments: await count("payments"),
    invoices: await count("invoices"),
    inventory: await count("inventory_movements"),
    receivables: await count("accounts_receivable"),
  };
  assert.deepEqual(after, before, "Stage 3 changed a forbidden transactional table");
  console.log("POS Stage 3 local DB contract, security, concurrency, and 3,000-row search: OK");
} finally {
  await cleanup();
}
