import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function loadEnvFile(path) {
  if (!existsSync(path)) return;

  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1).replace(/^"(.*)"$/, "$1");
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

process.env.NEXT_PUBLIC_SITE_URL ||= "https://carzoneaccesorios.vercel.app";

for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SITE_URL"]) {
  assert.ok(process.env[key], `Missing ${key}`);
}

function envValue(key) {
  return String(process.env[key] ?? "").replace(/^"(.*)"$/, "$1").trim();
}

const admin = createClient(envValue("NEXT_PUBLIC_SUPABASE_URL"), envValue("SUPABASE_SERVICE_ROLE_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});

const anon = createClient(envValue("NEXT_PUBLIC_SUPABASE_URL"), envValue("NEXT_PUBLIC_SUPABASE_ANON_KEY"), {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const email = envValue("AUTH_TEST_EMAIL") || `codex-auth-${suffix}@gmail.com`;
const password = `Auth-${suffix}-Aa1!`;
let authUserId = null;

try {
  const signUp = await anon.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${envValue("NEXT_PUBLIC_SITE_URL").replace(/\/$/, "")}/auth/callback?next=/verificacion/cuenta-confirmada&email=${encodeURIComponent(email)}`,
      data: {
        full_name: "Codex Auth Test",
        username: `codex_auth_${suffix.replace(/[^a-z0-9_]/gi, "_").slice(0, 24)}`,
        phone: "99999999",
      },
    },
  });
  if (signUp.error?.code === "over_email_send_rate_limit") {
    console.log("Remote Supabase Auth email flow check rate-limited.", {
      signUpRateLimited: true,
      supabaseStillSendsAuthEmails: true,
    });
    process.exit(0);
  }
  assert.ifError(signUp.error);
  assert.ok(signUp.data.user?.id, "signUp did not return a user");
  authUserId = signUp.data.user.id;

  const confirmationsRequired = !signUp.data.session;
  const signInBeforeAdminConfirm = await anon.auth.signInWithPassword({ email, password });

  if (confirmationsRequired) {
    assert.ok(signInBeforeAdminConfirm.error, "Unconfirmed user should not sign in before confirmation");
    const confirmResult = await admin.auth.admin.updateUserById(authUserId, { email_confirm: true });
    assert.ifError(confirmResult.error);
  } else {
    assert.ifError(signInBeforeAdminConfirm.error);
  }

  const signIn = await anon.auth.signInWithPassword({ email, password });
  assert.ifError(signIn.error);
  assert.equal(signIn.data.user?.email?.toLowerCase(), email);
  await anon.auth.signOut();

  const reset = await anon.auth.resetPasswordForEmail(email, {
    redirectTo: `${envValue("NEXT_PUBLIC_SITE_URL").replace(/\/$/, "")}/auth/callback?next=/restablecer-contrasena`,
  });
  const resetRateLimited = reset.error?.code === "over_email_send_rate_limit";
  if (reset.error && !resetRateLimited) {
    assert.ifError(reset.error);
  }

  console.log("Remote Supabase Auth email flow check passed.", {
    confirmationsRequired,
    signUpReturnedSession: Boolean(signUp.data.session),
    resetRequestAccepted: !reset.error,
    resetRateLimited,
  });
} finally {
  if (authUserId) {
    await admin.auth.admin.deleteUser(authUserId);
    await admin.from("users").delete().eq("id", authUserId);
  }
}
