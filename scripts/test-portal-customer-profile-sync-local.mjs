import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!serviceKey || !anonKey) {
  throw new Error("Define SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY from `supabase status -o env`.");
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const marker = `portal-sync-${Date.now()}`;
const password = `Cz-${crypto.randomUUID()}!a9`;
const createdAuthIds = [];
const createdCustomerIds = [];
const roleIds = new Map();

async function count(table) {
  const { count: value, error } = await admin.from(table).select("*", { count: "exact", head: true });
  assert.ifError(error);
  return value ?? 0;
}

async function createAccount(suffix, { confirmed = true, name = `Portal ${suffix}`, phone } = {}) {
  const email = `${marker}-${suffix}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: confirmed,
    user_metadata: {
      full_name: name,
      username: `${marker.slice(-8)}-${suffix}`.slice(0, 30),
      phone: phone ?? `+5049${String(createdAuthIds.length + 1000000).slice(-7)}`,
    },
  });
  assert.ifError(error);
  createdAuthIds.push(data.user.id);
  const { error: roleUpdateError } = await admin.from("users").update({ role_id: roleIds.get("cliente") }).eq("id", data.user.id);
  assert.ifError(roleUpdateError);
  const { data: profile, error: profileError } = await admin
    .from("users")
    .select("id, roles(name)")
    .eq("id", data.user.id)
    .maybeSingle();
  assert.ifError(profileError);
  assert.ok(profile?.roles?.name, `Missing public profile role for ${suffix}: ${JSON.stringify(profile)}`);
  return { id: data.user.id, email, phone: data.user.user_metadata.phone };
}

async function createSignedInClient(email) {
  const client = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await client.auth.signInWithPassword({ email, password });
  assert.ifError(error);
  return client;
}

async function internalSync(accountId, source, requestKey = crypto.randomUUID()) {
  const { data, error } = await admin.rpc("ensure_portal_customer_profile_internal_v1", {
    p_portal_user_id: accountId,
    p_source: source,
    p_request_key: requestKey,
  });
  assert.ifError(error);
  return data;
}

async function cleanup() {
  if (createdAuthIds.length) {
    await admin.from("internal_notifications").delete().in("customer_id", createdCustomerIds.length ? createdCustomerIds : [crypto.randomUUID()]);
    await admin.from("portal_customer_link_reviews").delete().in("portal_user_id", createdAuthIds);
    await admin.from("portal_customer_profile_sync_requests").delete().in("portal_user_id", createdAuthIds);
    await admin.from("portal_customer_profile_syncs").delete().in("portal_user_id", createdAuthIds);
  }
  await admin.from("customers").delete().like("email", `${marker}%`);
  for (const userId of createdAuthIds) {
    await admin.auth.admin.deleteUser(userId);
  }
}

try {
  const { data: testRoles, error: testRolesError } = await admin
    .from("roles")
    .upsert(
      [
        { name: "cliente", description: "Cliente de portal", permissions: [] },
        {
          name: "admin",
          description: "Administrador local",
          permissions: ["admin:access", "crm:manage", "customers:manage", "customers:link_portal_account", "notifications:read"],
        },
      ],
      { onConflict: "name" },
    )
    .select("id, name");
  assert.ifError(testRolesError);
  testRoles.forEach((role) => roleIds.set(role.name, role.id));

  const forbiddenBefore = {
    orders: await count("orders"),
    payments: await count("payments"),
    invoices: await count("invoices"),
    inventory: await count("inventory_movements"),
    receivables: await count("accounts_receivable"),
    credit: await count("customer_credit_accounts"),
    journals: await count("journal_entries"),
  };

  const pending = await createAccount("pending", { confirmed: false, name: "Cliente Cuenta Pendiente" });
  const registrationKey = crypto.randomUUID();
  const created = await internalSync(pending.id, "registration", registrationKey);
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.code, "PROFILE_CREATED");
  createdCustomerIds.push(created.customerId);

  const { data: pendingCustomer, error: pendingCustomerError } = await admin
    .from("customers")
    .select("id, user_id, status, active, is_wholesale, wholesale_status, wholesale_customer_type, source")
    .eq("id", created.customerId)
    .single();
  assert.ifError(pendingCustomerError);
  assert.equal(pendingCustomer.user_id, pending.id);
  assert.equal(pendingCustomer.status, "pending_account");
  assert.equal(pendingCustomer.active, false);
  assert.equal(pendingCustomer.is_wholesale, false);
  assert.equal(pendingCustomer.wholesale_status, "none");
  assert.equal(pendingCustomer.wholesale_customer_type, "new");
  assert.equal(pendingCustomer.source, "portal_registration");

  const replay = await internalSync(pending.id, "registration", registrationKey);
  assert.equal(replay.customerId, created.customerId);
  assert.equal(replay.idempotentReplay, true);

  await admin.from("users").update({ phone: "+504 9999-1111" }).eq("id", pending.id);
  const conflict = await internalSync(pending.id, "registration", registrationKey);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "IDEMPOTENCY_CONFLICT");

  const { data: updatedAuth, error: confirmError } = await admin.auth.admin.updateUserById(pending.id, {
    email_confirm: true,
  });
  assert.ifError(confirmError);
  const confirmed = await internalSync(pending.id, "callback", crypto.randomUUID());
  assert.equal(confirmed.code, "ALREADY_LINKED");
  assert.equal(updatedAuth.user.email_confirmed_at !== null, true);
  const { data: activeCustomer } = await admin.from("customers").select("status, active").eq("id", created.customerId).single();
  assert.equal(activeCustomer.status, "active");
  assert.equal(activeCustomer.active, true);

  const signedInCustomer = await createSignedInClient(pending.email);
  const { data: selfRecovery, error: selfRecoveryError } = await signedInCustomer.rpc("ensure_my_portal_customer_profile_v1", {
    p_source: "login",
    p_request_key: crypto.randomUUID(),
  });
  assert.ifError(selfRecoveryError);
  assert.equal(selfRecovery.code, "ALREADY_LINKED");

  const concurrent = await createAccount("concurrent", { name: "Cliente Concurrente" });
  const concurrentResults = await Promise.all([
    internalSync(concurrent.id, "registration", crypto.randomUUID()),
    internalSync(concurrent.id, "callback", crypto.randomUUID()),
  ]);
  assert.deepEqual(concurrentResults.map((item) => item.code).sort(), ["ALREADY_LINKED", "PROFILE_CREATED"]);
  const { data: concurrentCustomers } = await admin.from("customers").select("id").eq("user_id", concurrent.id);
  assert.equal(concurrentCustomers.length, 1);
  createdCustomerIds.push(concurrentCustomers[0].id);

  const matchEmail = `${marker}-existing@example.test`;
  const matchPhone = "+504 9888-7766";
  const { data: existingCandidate, error: existingCandidateError } = await admin
    .from("customers")
    .insert({
      contact_name: "Cliente CRM Existente",
      email: matchEmail,
      phone: matchPhone,
      status: "active",
      active: true,
      source: "local-test",
      lead_status: "cliente",
    })
    .select("id")
    .single();
  assert.ifError(existingCandidateError);
  createdCustomerIds.push(existingCandidate.id);

  const candidateAccount = await createAccount("candidate", {
    name: "Nombre Diferente",
    phone: matchPhone,
  });
  const { error: candidateEmailError } = await admin.auth.admin.updateUserById(candidateAccount.id, {
    email: matchEmail,
    email_confirm: true,
  });
  assert.ifError(candidateEmailError);
  await admin.from("users").update({ email: matchEmail }).eq("id", candidateAccount.id);
  const review = await internalSync(candidateAccount.id, "registration");
  assert.equal(review.ok, false);
  assert.equal(review.code, "REVIEW_REQUIRED");
  assert.equal(review.candidateCount, 1);
  const { count: candidateLinkedCount } = await admin
    .from("customers")
    .select("*", { count: "exact", head: true })
    .eq("user_id", candidateAccount.id);
  assert.equal(candidateLinkedCount, 0);
  const { data: untouchedCandidate } = await admin.from("customers").select("user_id").eq("id", existingCandidate.id).single();
  assert.equal(untouchedCandidate.user_id, null);

  const { data: reviewRows } = await admin
    .from("portal_customer_link_reviews")
    .select("id, candidate_customer_id, status")
    .eq("portal_user_id", candidateAccount.id);
  assert.equal(reviewRows.length, 1);
  assert.equal(reviewRows[0].candidate_customer_id, existingCandidate.id);
  assert.equal(reviewRows[0].status, "pending");

  const { data: reviewNotifications } = await admin
    .from("internal_notifications")
    .select("id")
    .eq("dedupe_key", `portal-customer-link-review:${candidateAccount.id}`);
  assert.equal(reviewNotifications.length, 1);

  const sameNameExistingEmail = `${marker}-same-name-existing@example.test`;
  const { data: sameNameExisting, error: sameNameError } = await admin
    .from("customers")
    .insert({
      contact_name: "Coincidencia Solo Nombre",
      email: sameNameExistingEmail,
      phone: "+504 9777-0001",
      status: "active",
      active: true,
      source: "local-test",
      lead_status: "cliente",
    })
    .select("id")
    .single();
  assert.ifError(sameNameError);
  createdCustomerIds.push(sameNameExisting.id);
  const sameNameAccount = await createAccount("same-name", {
    name: "Coincidencia Solo Nombre",
    phone: "+504 9777-0002",
  });
  const sameNameResult = await internalSync(sameNameAccount.id, "registration");
  assert.equal(sameNameResult.code, "PROFILE_CREATED");
  assert.notEqual(sameNameResult.customerId, sameNameExisting.id);
  createdCustomerIds.push(sameNameResult.customerId);

  const internalAccount = await createAccount("internal");
  await admin.from("users").update({ role_id: roleIds.get("admin") }).eq("id", internalAccount.id);
  const internalResult = await internalSync(internalAccount.id, "registration");
  assert.equal(internalResult.code, "INTERNAL_USER_IGNORED");
  const { count: internalCustomerCount } = await admin.from("customers").select("*", { count: "exact", head: true }).eq("user_id", internalAccount.id);
  assert.equal(internalCustomerCount, 0);

  const suspendedAccount = await createAccount("suspended");
  await admin.from("users").update({ active: false }).eq("id", suspendedAccount.id);
  const suspendedResult = await internalSync(suspendedAccount.id, "registration");
  assert.equal(suspendedResult.code, "INACTIVE_ACCOUNT");

  const adminActor = await createAccount("admin-actor");
  await admin.from("users").update({ role_id: roleIds.get("admin") }).eq("id", adminActor.id);
  const adminClient = await createSignedInClient(adminActor.email);
  const recoverable = await createAccount("admin-recovery");
  const { data: preview, error: previewError } = await adminClient.rpc("preview_admin_portal_customer_profile_v1", {
    p_portal_user_id: recoverable.id,
  });
  assert.ifError(previewError);
  assert.equal(preview.expectedState, "unresolved");
  assert.equal(preview.recommendedOutcome, "profile_created");

  const recoveryKey = crypto.randomUUID();
  const { data: recovered, error: recoveredError } = await adminClient.rpc("ensure_admin_portal_customer_profile_v1", {
    p_portal_user_id: recoverable.id,
    p_request_key: recoveryKey,
    p_expected_state: "unresolved",
    p_reason: "Recuperación local controlada de una cuenta sin coincidencias.",
  });
  assert.ifError(recoveredError);
  assert.equal(recovered.code, "PROFILE_CREATED");
  createdCustomerIds.push(recovered.customerId);

  const { data: searched, error: searchError } = await adminClient.rpc("search_admin_crm_customer_ids_v1", {
    p_query: recoverable.email,
    p_filter: "clients",
    p_limit: 20,
    p_offset: 0,
  });
  assert.ifError(searchError);
  assert.ok(searched.some((row) => row.customer_id === recovered.customerId));

  const publicClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error: privateCoreError } = await publicClient.rpc("ensure_portal_customer_profile_internal_v1", {
    p_portal_user_id: recoverable.id,
    p_source: "registration",
    p_request_key: crypto.randomUUID(),
  });
  assert.equal(privateCoreError?.code, "42501");

  const { data: registrationNotifications } = await admin
    .from("internal_notifications")
    .select("id")
    .eq("dedupe_key", `portal-customer-registered:${pending.id}`);
  assert.equal(registrationNotifications.length, 1);

  const forbiddenAfter = {
    orders: await count("orders"),
    payments: await count("payments"),
    invoices: await count("invoices"),
    inventory: await count("inventory_movements"),
    receivables: await count("accounts_receivable"),
    credit: await count("customer_credit_accounts"),
    journals: await count("journal_entries"),
  };
  assert.deepEqual(forbiddenAfter, forbiddenBefore, "Portal synchronization changed a forbidden operational table");

  console.log("Portal customer profile local DB, RLS, idempotency, concurrency, review, notification, and global search: OK");
} finally {
  await cleanup();
}
