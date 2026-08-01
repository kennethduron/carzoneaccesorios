import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!serviceKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const actorEmail = "customer-merge-owner@example.test";
const actorPassword = "CustomerMerge-Visual-2026!";
const marker = "customer-merge-visual";

const { data: authPage, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (listError) throw listError;
for (const user of authPage.users.filter((candidate) => candidate.email === actorEmail)) {
  const { error } = await admin.auth.admin.deleteUser(user.id);
  if (error) throw error;
}

const { error: cleanupError } = await admin.from("customers").delete().eq("source", marker);
if (cleanupError) throw cleanupError;

const { data: actor, error: actorError } = await admin.auth.admin.createUser({
  email: actorEmail,
  password: actorPassword,
  email_confirm: true,
  user_metadata: { full_name: "Propietario técnico visual" },
});
if (actorError) throw actorError;

const { data: role, error: roleError } = await admin.from("roles").select("id").eq("name", "technical_owner").single();
if (roleError) throw roleError;
const { error: actorRoleError } = await admin.from("users").update({ role_id: role.id }).eq("id", actor.user.id);
if (actorRoleError) throw actorRoleError;

const createdAt = new Date(Date.now() - 60_000).toISOString();
const { data: customers, error: customersError } = await admin
  .from("customers")
  .insert([
    {
      business_name: "Autopartes Visual",
      company_name: "Autopartes Visual, S. de R.L.",
      contact_name: "María López",
      email: "visual.merge@example.test",
      phone: "+50499991111",
      tax_id: "08011999123456",
      city: "Tegucigalpa",
      source: marker,
      status: "active",
      active: true,
      lead_status: "cliente",
      created_at: createdAt,
    },
    {
      business_name: "Autopartes Visual Honduras",
      contact_name: "María Elena López",
      email: "VISUAL.MERGE@example.test",
      phone: "9999-1111",
      tax_id: "0801-1999-123456",
      address: "Colonia Palmira, avenida principal",
      city: "Distrito Central",
      source: marker,
      status: "active",
      active: true,
      lead_status: "prospecto",
      created_at: new Date().toISOString(),
    },
  ])
  .select("id, business_name, commercial_version");
if (customersError) throw customersError;

const primary = customers.find((customer) => customer.business_name === "Autopartes Visual");
const secondary = customers.find((customer) => customer.business_name === "Autopartes Visual Honduras");
if (!primary || !secondary) throw new Error("Visual customer fixture was not created completely.");
const { error: noteError } = await admin.from("crm_notes").insert({
  customer_id: secondary.id,
  note: "Prefiere atención por la mañana; dato sintético para validación visual.",
  user_id: actor.user.id,
});
if (noteError) throw noteError;

const { error: flagError } = await admin
  .from("customer_feature_flags")
  .update({ enabled: true, enabled_at: new Date().toISOString(), updated_by: actor.user.id })
  .in("key", ["customer_duplicate_prevention_v1", "customer_merge_execution_v1"]);
if (flagError) throw flagError;

console.log(JSON.stringify({
  actorEmail,
  actorPassword,
  primaryCustomerId: primary.id,
  secondaryCustomerId: secondary.id,
}, null, 2));
