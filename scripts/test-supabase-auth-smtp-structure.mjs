import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const envExample = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const auditScript = await readFile(new URL("./audit-supabase-auth-config.mjs", import.meta.url), "utf8");
const configureScript = await readFile(new URL("./configure-supabase-auth-resend-smtp.mjs", import.meta.url), "utf8");
const authActions = await readFile(new URL("../src/app/auth/actions.ts", import.meta.url), "utf8");
const authCallback = await readFile(new URL("../src/app/auth/callback/route.ts", import.meta.url), "utf8");
const operationalErrors = await readFile(new URL("../src/lib/operational-errors.ts", import.meta.url), "utf8");
const securityActions = await readFile(new URL("../src/app/admin/seguridad/actions.ts", import.meta.url), "utf8");

for (const key of [
  "SUPABASE_ACCESS_TOKEN=",
  "SUPABASE_PROJECT_REF=",
  "SUPABASE_AUTH_SITE_URL=https://carzoneaccesorios.com",
  "SUPABASE_AUTH_REDIRECT_URLS=https://carzoneaccesorios.com/auth/callback,https://www.carzoneaccesorios.com/auth/callback,https://carzoneaccesorios.com/actualizar-contrasena,https://www.carzoneaccesorios.com/actualizar-contrasena,http://localhost:3000/auth/callback,http://localhost:3000/actualizar-contrasena",
  "SUPABASE_AUTH_SMTP_HOST=smtp.resend.com",
  "SUPABASE_AUTH_SMTP_PORT=465",
  "SUPABASE_AUTH_SMTP_USER=resend",
  "SUPABASE_AUTH_SMTP_PASS=",
  "SUPABASE_AUTH_SMTP_FROM_EMAIL=sistema@carzoneaccesorios.com",
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
assert.match(configureScript, /mailer_subjects_recovery: "Restablece tu contraseña - Car Zone Accesorios"/);
assert.match(configureScript, /mailer_subjects_invite: "Acceso al sistema administrativo - Car Zone Accesorios"/);
assert.match(configureScript, /mailer_subjects_reauthentication: "Confirma tu identidad - Car Zone Accesorios"/);
assert.match(configureScript, /Cambiar mi contraseña/);
assert.match(configureScript, /Confirmar mi cuenta/);
assert.match(configureScript, /token_hash=\{\{ \.TokenHash \}\}&amp;type=recovery&amp;next=\/actualizar-contrasena/);
assert.match(configureScript, /token_hash=\{\{ \.TokenHash \}\}&amp;type=signup/);
const englishAuthPhrases = [
  ["Reset", "your", "password"].join(" "),
  ["Confirm", "your", "email"].join(" "),
  ["Magic", "Link"].join(" "),
  ["Invite", "user"].join(" "),
];
for (const phrase of englishAuthPhrases) {
  assert.equal(configureScript.includes(phrase), false, `Unexpected English auth template text: ${phrase}`);
}
assert.doesNotMatch(configureScript, /smtpPassword: payload\.smtp_pass/);

assert.match(authActions, /supabase\.auth\.signUp/);
assert.match(authActions, /needsEmailConfirmation: true/);
assert.doesNotMatch(authActions, /AUTH_TEST_CREATE_UNCONFIRMED_USERS/);
assert.doesNotMatch(authActions, /AUTH_TEST_BYPASS_EMAIL_CONFIRMATION/);
assert.doesNotMatch(authActions, /auth\.admin\.createUser/);
assert.doesNotMatch(authActions, /email_confirm: true/);
assert.doesNotMatch(authActions, /email_confirm: false/);
assert.doesNotMatch(authActions, /temporary-unconfirmed/);
assert.doesNotMatch(authActions, /temporary-test-bypass/);
assert.doesNotMatch(authActions, /signInWithPassword\.after_test_registration/);
assert.match(authActions, /supabase\.auth\.resend/);
assert.match(authActions, /resetPasswordForEmail/);
assert.match(authActions, /getSupabasePublicClient/);
assert.match(authActions, /auth_flow: "implicit_recovery"/);
assert.match(authActions, /buildAuthCallbackUrl\(siteUrl, "\/actualizar-contrasena"\)/);
assert.doesNotMatch(authActions, /buildAuthCallbackUrl\(siteUrl, "\/restablecer-contrasena"\)/);
assert.match(operationalErrors, /Debes confirmar tu correo antes de iniciar sesión/);
assert.match(authCallback, /exchangeCodeForSession/);
assert.match(authCallback, /verifyOtp/);
assert.match(authCallback, /pathname = "\/actualizar-contrasena"/);
assert.match(authCallback, /Este enlace ya fue utilizado|usedRecoveryLinkCookieName|recoveryErrorReason/);
assert.match(securityActions, /auth\.admin\.createUser/);
assert.match(securityActions, /email_confirm: true/);

console.log("Supabase Auth SMTP structure checks passed.");
