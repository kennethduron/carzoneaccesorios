import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
assert.ok(env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "Missing NEXT_PUBLIC_SUPABASE_ANON_KEY");
assert.ok(env.SUPABASE_SERVICE_ROLE_KEY, "Missing SUPABASE_SERVICE_ROLE_KEY");

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const authorizedRoles = ["technical_owner", "business_owner", "admin"];
const deniedRoles = ["vendedor", "bodega", "contadora", "soporte", "cliente"];
const testedRoles = [...authorizedRoles, ...deniedRoles];
const password = `Cz-${randomUUID()}-Aa1!`;
const authUserIds = [];
const customerIds = [];
const fixtureEmails = [];

try {
  const { data: roles, error: rolesError } = await admin.from("roles").select("id, name, permissions").in("name", testedRoles);
  assert.ifError(rolesError);
  const rolesByName = new Map(roles.map((role) => [role.name, role]));

  for (const role of authorizedRoles) {
    assert.equal(rolesByName.get(role)?.permissions?.includes("wholesale:manage"), true, `${role} must manage wholesale`);
  }
  for (const role of deniedRoles) {
    assert.equal(rolesByName.get(role)?.permissions?.includes("wholesale:manage"), false, `${role} must not manage wholesale`);
  }

  for (const [index, roleName] of testedRoles.entries()) {
    const email = `codex-wholesale-${roleName}-${Date.now()}-${index}@example.com`;
    fixtureEmails.push(email);
    const { data: authData, error: authError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: `Codex ${roleName}` },
    });
    assert.ifError(authError);
    const userId = authData.user.id;
    authUserIds.push(userId);

    const { error: userError } = await admin.from("users").upsert({
      id: userId,
      role_id: rolesByName.get(roleName).id,
      full_name: `Codex ${roleName}`,
      email,
      active: true,
    });
    assert.ifError(userError);

    const { data: customer, error: customerError } = await admin
      .from("customers")
      .insert({
        user_id: userId,
        business_name: `Negocio Codex ${roleName}`,
        company_name: `Negocio Codex ${roleName}`,
        contact_name: `Codex ${roleName}`,
        email,
        phone: `9999${String(index).padStart(4, "0")}`,
        is_wholesale: true,
        wholesale_status: "approved",
        wholesale_customer_type: "new",
        status: "active",
        active: true,
      })
      .select("id")
      .single();
    assert.ifError(customerError);
    customerIds.push(customer.id);

    const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: signInError } = await client.auth.signInWithPassword({ email, password });
    assert.ifError(signInError);

    const { error: updateError } = await client
      .from("customers")
      .update({ wholesale_customer_type: "existing" })
      .eq("id", customer.id);

    if (authorizedRoles.includes(roleName)) {
      assert.ifError(updateError);
      const { data: bypassesMinimum, error: rpcError } = await client.rpc("has_completed_wholesale_order", {
        target_customer_id: customer.id,
      });
      assert.ifError(rpcError);
      assert.equal(bypassesMinimum, true, `${roleName} existing customer should bypass first-purchase minimum`);
    } else {
      assert.ok(updateError, `${roleName} must be blocked from changing wholesale type`);
      assert.match(updateError.message, /Solo technical_owner, business_owner o admin/);
    }

    await client.auth.signOut();
  }

  const { data: newCustomer, error: newCustomerError } = await admin
    .from("customers")
    .select("id")
    .eq("id", customerIds[authorizedRoles.length])
    .single();
  assert.ifError(newCustomerError);
  const { data: newCustomerBypass, error: newCustomerRpcError } = await admin.rpc("has_completed_wholesale_order", {
    target_customer_id: newCustomer.id,
  });
  assert.ifError(newCustomerRpcError);
  assert.equal(newCustomerBypass, false, "A new wholesale customer without orders must retain the minimum");

  console.log("Remote wholesale customer type and role checks passed.");
} finally {
  if (fixtureEmails.length > 0) {
    const { data: fixtureCustomers } = await admin.from("customers").select("id").in("email", fixtureEmails);
    const fixtureCustomerIds = fixtureCustomers?.map((customer) => customer.id) ?? [];
    if (fixtureCustomerIds.length > 0) {
      await admin.from("crm_notes").delete().in("customer_id", fixtureCustomerIds);
      await admin.from("crm_followups").delete().in("customer_id", fixtureCustomerIds);
      await admin.from("audit_logs").delete().in("record_id", fixtureCustomerIds);
      await admin.from("customers").delete().in("id", fixtureCustomerIds);
    }
  }
  if (customerIds.length > 0) {
    await admin.from("customers").delete().in("id", customerIds);
  }
  if (authUserIds.length > 0) {
    await admin.from("users").delete().in("id", authUserIds);
    for (const userId of authUserIds) {
      await admin.auth.admin.deleteUser(userId);
    }
  }
}
