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

const url = env.NEXT_PUBLIC_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const customerServiceEmail = process.env.CUSTOMER_SERVICE_EMAIL;

assert.ok(url, "Missing NEXT_PUBLIC_SUPABASE_URL");
assert.ok(serviceRole, "Missing SUPABASE_SERVICE_ROLE_KEY");
assert.ok(customerServiceEmail, "Missing CUSTOMER_SERVICE_EMAIL");
assert.match(customerServiceEmail, /^[^\s@]+@[^\s@]+\.[^\s@]+$/);

const admin = createClient(url, serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: settings, error: readError } = await admin
  .from("company_settings")
  .select("id, customer_service_email")
  .order("created_at", { ascending: true })
  .limit(1)
  .maybeSingle();
assert.ifError(readError);

if (!settings?.id) {
  console.log("No company_settings row found; nothing updated.");
  process.exit(0);
}

const current = String(settings.customer_service_email ?? "").trim().toLowerCase();
if (current && current !== "ventas@carzoneaccesorios.com") {
  console.log("Customer service email already configured.", { current });
  process.exit(0);
}

const { error: updateError } = await admin
  .from("company_settings")
  .update({ customer_service_email: customerServiceEmail, updated_at: new Date().toISOString() })
  .eq("id", settings.id);
assert.ifError(updateError);

console.log("Customer service email updated.", { customerServiceEmail });
