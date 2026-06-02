import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";

const requiredEnv = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
  "NEXT_PUBLIC_SITE_URL",
  "EMAIL_PROVIDER",
  "EMAIL_ENABLED",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "RESEND_FROM_NAME",
  "RESEND_REPLY_TO",
];

for (const key of requiredEnv) {
  assert.ok(process.env[key], `Missing ${key}`);
}

function envValue(key) {
  return String(process.env[key] ?? "").replace(/^"(.*)"$/, "$1").trim();
}

assert.equal(envValue("EMAIL_PROVIDER"), "resend");
assert.equal(envValue("EMAIL_ENABLED"), "true");
assert.equal(envValue("RESEND_FROM_EMAIL"), "onboarding@resend.dev");
assert.equal(envValue("RESEND_FROM_NAME"), "Car Zone Accesorios");
assert.equal(envValue("RESEND_REPLY_TO"), "car.zone.accesorioshn@gmail.com");

const admin = createClient(envValue("NEXT_PUBLIC_SUPABASE_URL"), envValue("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});

const recipient = envValue("EMAIL_TEST_RECIPIENT") || envValue("RESEND_REPLY_TO");
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const idempotencyKey = `codex-resend-queue-test:${suffix}:${recipient.toLowerCase()}`;
const subject = `Prueba Resend Car Zone ${suffix}`;

const { data: queued, error: queueError } = await admin
  .from("email_queue")
  .insert({
    to_email: recipient.toLowerCase(),
    to_name: "Prueba Car Zone",
    subject,
    template_key: "codex.resend_queue_test",
    payload: {
      title: "Prueba de cola de correo",
      message: "Este correo valida email_queue, Resend, remitente y reply-to configurados en Vercel.",
      action_path: "/admin/uso",
      action_label: "Abrir monitoreo",
    },
    status: "pending",
    scheduled_at: new Date().toISOString(),
    related_module: "sistema",
    priority: 1,
    max_attempts: 2,
    idempotency_key: idempotencyKey,
  })
  .select("id")
  .single();
assert.ifError(queueError);
assert.ok(queued?.id, "Email queue row was not created");

const siteUrl = envValue("NEXT_PUBLIC_SITE_URL").replace(/\/$/, "");
const response = await fetch(`${siteUrl}/api/cron/process-email-queue`, {
  method: "POST",
  headers: { Authorization: `Bearer ${envValue("CRON_SECRET")}` },
});
const cronPayload = await response.json().catch(() => null);
assert.equal(response.ok, true, `Email cron failed: ${JSON.stringify(cronPayload)}`);
assert.equal(cronPayload?.provider, "resend");

let finalRow = null;
for (let attempt = 0; attempt < 8; attempt += 1) {
  const { data, error } = await admin
    .from("email_queue")
    .select("id, status, provider, provider_message_id, attempts, last_error, sent_at")
    .eq("id", queued.id)
    .single();
  assert.ifError(error);
  finalRow = data;
  if (data.status === "sent" || data.status === "failed") break;
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

assert.equal(finalRow?.status, "sent", `Expected sent email, got ${JSON.stringify(finalRow)}`);
assert.equal(finalRow.provider, "resend");
assert.ok(finalRow.provider_message_id, "Missing Resend provider_message_id");

console.log("Remote Resend email_queue check passed.", {
  queueId: queued.id,
  recipient,
  providerMessageId: finalRow.provider_message_id,
});
