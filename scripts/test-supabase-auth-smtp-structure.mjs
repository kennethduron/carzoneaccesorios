import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const envExample = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const auditScript = await readFile(new URL("./audit-supabase-auth-config.mjs", import.meta.url), "utf8");
const configureScript = await readFile(new URL("./configure-supabase-auth-resend-smtp.mjs", import.meta.url), "utf8");
const authActions = await readFile(new URL("../src/app/auth/actions.ts", import.meta.url), "utf8");
const authCallback = await readFile(new URL("../src/app/auth/callback/route.ts", import.meta.url), "utf8");
const securityActions = await readFile(new URL("../src/app/admin/seguridad/actions.ts", import.meta.url), "utf8");

for (const key of [
  "SUPABASE_ACCESS_TOKEN=",
  "SUPABASE_PROJECT_REF=",
  "SUPABASE_AUTH_SITE_URL=https://carzoneaccesorios.vercel.app",
  "SUPABASE_AUTH_REDIRECT_URLS=https://carzoneaccesorios.vercel.app/auth/callback,http://localhost:3000/auth/callback",
  "SUPABASE_AUTH_SMTP_HOST=smtp.resend.com",
  "SUPABASE_AUTH_SMTP_PORT=465",
  "SUPABASE_AUTH_SMTP_USER=resend",
  "SUPABASE_AUTH_SMTP_PASS=",
  "SUPABASE_AUTH_SMTP_FROM_EMAIL=onboarding@resend.dev",
  "SUPABASE_AUTH_SMTP_SENDER_NAME=Car Zone Accesorios",
]) {
  assert.match(envExample, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}

assert.match(auditScript, /config\/auth/);
assert.match(auditScript, /pickSafeConfig/);
assert.doesNotMatch(auditScript, /smtp_pass: config\.smtp_pass/);

assert.match(configureScript, /smtp_host: envValue\("SUPABASE_AUTH_SMTP_HOST"\) \|\| "smtp\.resend\.com"/);
assert.match(configureScript, /smtp_port: Number\(envValue\("SUPABASE_AUTH_SMTP_PORT"\) \|\| 465\)/);
assert.match(configureScript, /smtp_user: envValue\("SUPABASE_AUTH_SMTP_USER"\) \|\| "resend"/);
assert.match(configureScript, /smtp_pass: smtpPass/);
assert.match(configureScript, /mailer_autoconfirm: false/);
assert.match(configureScript, /mailer_secure_email_change_enabled: true/);
assert.match(configureScript, /mailer_subjects_confirmation: "Confirma tu cuenta - Car Zone Accesorios"/);
assert.match(configureScript, /mailer_subjects_recovery: "Restablece tu contrasena - Car Zone Accesorios"/);
assert.match(configureScript, /mailer_subjects_invite: "Acceso al sistema administrativo - Car Zone Accesorios"/);
assert.doesNotMatch(configureScript, /smtpPassword: payload\.smtp_pass/);

assert.match(authActions, /supabase\.auth\.signUp/);
assert.match(authActions, /supabase\.auth\.resend/);
assert.match(authActions, /resetPasswordForEmail/);
assert.match(authCallback, /exchangeCodeForSession/);
assert.match(authCallback, /verifyOtp/);
assert.match(securityActions, /auth\.admin\.createUser/);
assert.match(securityActions, /email_confirm: true/);

console.log("Supabase Auth SMTP structure checks passed.");
