import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!serviceKey || !anonKey) {
  throw new Error("Define SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY from `supabase status -o env`.");
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const marker = `set-once-${Date.now()}`;
const email = `${marker}@example.test`;
const password = `Cz-${crypto.randomUUID()}!a9`;
let userId;
let customerId;
let registrationUserId;
let registrationCustomerId;

async function signedInClient() {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  assert.ifError(error);
  return client;
}

async function count(table) {
  const { count: value, error } = await admin.from(table).select("*", { count: "exact", head: true });
  assert.ifError(error);
  return value ?? 0;
}

try {
  const immutableBefore = {
    orders: await count("orders"),
    reservations: await count("inventory_reservations"),
    movements: await count("inventory_movements"),
  };

  const { data: role, error: roleError } = await admin
    .from("roles")
    .upsert({ name: "cliente", description: "Cliente de portal", permissions: ["store:buy"] }, { onConflict: "name" })
    .select("id")
    .single();
  assert.ifError(roleError);

  const registrationEmail = `${marker}-registration@example.test`;
  const { data: registrationUser, error: registrationUserError } = await admin.auth.admin.createUser({
    email: registrationEmail,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: "Cliente Registro Parcial",
      username: `${marker.slice(0, 20)}-reg`,
      phone: "+504 9999-8877",
      business_name: "Taller Registro",
      tax_id: "0801-1999-123456",
      city: "Comayagua",
    },
  });
  assert.ifError(registrationUserError);
  registrationUserId = registrationUser.user.id;
  assert.ifError((await admin.from("users").update({ role_id: role.id, active: true }).eq("id", registrationUserId)).error);
  const registrationRequestKey = crypto.randomUUID();
  const { data: registrationSync, error: registrationSyncError } = await admin.rpc("ensure_portal_customer_profile_internal_v1", {
    p_portal_user_id: registrationUserId,
    p_source: "registration",
    p_request_key: registrationRequestKey,
  });
  assert.ifError(registrationSyncError);
  assert.equal(registrationSync.code, "PROFILE_CREATED");
  registrationCustomerId = registrationSync.customerId;
  const { data: finalized, error: finalizerError } = await admin.rpc("finalize_portal_registration_commercial_fields_v1", {
    p_portal_user_id: registrationUserId,
    p_request_key: registrationRequestKey,
  });
  assert.ifError(finalizerError);
  assert.equal(finalized.code, "REGISTRATION_COMMERCIAL_FIELDS_FINALIZED");
  const { data: registeredCustomer, error: registeredCustomerError } = await admin
    .from("customers")
    .select("business_name, tax_id, city, source, active")
    .eq("id", registrationCustomerId)
    .single();
  assert.ifError(registeredCustomerError);
  assert.deepEqual(registeredCustomer, {
    business_name: "Taller Registro",
    tax_id: "08011999123456",
    city: "Comayagua",
    source: "portal_registration",
    active: true,
  });

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: "Cliente Set Once Local", username: marker.slice(0, 30), phone: "+504 9999-8899" },
  });
  assert.ifError(createError);
  userId = created.user.id;
  const { error: userError } = await admin.from("users").update({ role_id: role.id, active: true }).eq("id", userId);
  assert.ifError(userError);
  const { data: customer, error: customerError } = await admin
    .from("customers")
    .insert({
      user_id: userId,
      contact_name: "Cliente Set Once Local",
      email,
      status: "active",
      active: true,
      source: "local_set_once_test",
      lead_status: "cliente",
    })
    .select("id")
    .single();
  assert.ifError(customerError);
  customerId = customer.id;

  const [clientA, clientB] = await Promise.all([signedInClient(), signedInClient()]);
  const [attemptA, attemptB] = await Promise.all([
    clientA.rpc("set_my_customer_profile_fields_once_v1", {
      p_request_key: crypto.randomUUID(), p_tax_id: null, p_city: "La Ceiba", p_business_name: null,
    }),
    clientB.rpc("set_my_customer_profile_fields_once_v1", {
      p_request_key: crypto.randomUUID(), p_tax_id: null, p_city: "Comayagua", p_business_name: null,
    }),
  ]);
  assert.ifError(attemptA.error);
  assert.ifError(attemptB.error);
  assert.deepEqual([attemptA.data.code, attemptB.data.code].sort(), ["FIELDS_SET", "FIELD_ALREADY_SET"]);

  const winner = attemptA.data.code === "FIELDS_SET" ? "La Ceiba" : "Comayagua";
  const { data: stored, error: storedError } = await admin.from("customers").select("city").eq("id", customerId).single();
  assert.ifError(storedError);
  assert.equal(stored.city, winner);

  const { data: retry, error: retryError } = await clientA.rpc("set_my_customer_profile_fields_once_v1", {
    p_request_key: crypto.randomUUID(), p_tax_id: null, p_city: winner, p_business_name: null,
  });
  assert.ifError(retryError);
  assert.equal(retry.code, "IDEMPOTENT_REPLAY");

  const { count: audits, error: auditError } = await admin
    .from("audit_logs")
    .select("*", { count: "exact", head: true })
    .eq("record_id", customerId)
    .eq("action", "customer.profile.field_set_once");
  assert.ifError(auditError);
  assert.equal(audits, 1);

  const { error: bypassError } = await clientA.from("customers").update({ city: "Bypass" }).eq("id", customerId);
  assert.ok(bypassError, "Direct authenticated update unexpectedly succeeded");

  const immutableAfter = {
    orders: await count("orders"),
    reservations: await count("inventory_reservations"),
    movements: await count("inventory_movements"),
  };
  assert.deepEqual(immutableAfter, immutableBefore);
  console.log("Customer registration metadata, set-once concurrency, idempotency, audit, direct-bypass, and operational isolation: OK");
} finally {
  const customerIds = [customerId, registrationCustomerId].filter(Boolean);
  const userIds = [userId, registrationUserId].filter(Boolean);
  if (userIds.length) {
    await admin.from("portal_customer_link_reviews").delete().in("portal_user_id", userIds);
    await admin.from("portal_customer_profile_sync_requests").delete().in("portal_user_id", userIds);
    await admin.from("portal_customer_profile_syncs").delete().in("portal_user_id", userIds);
  }
  if (customerIds.length) {
    await admin.from("audit_logs").delete().in("record_id", customerIds);
    await admin.from("internal_notifications").delete().in("customer_id", customerIds);
    await admin.from("customers").delete().in("id", customerIds);
  }
  if (userIds.length) {
    for (const fixtureUserId of userIds) await admin.auth.admin.deleteUser(fixtureUserId);
  }
}
