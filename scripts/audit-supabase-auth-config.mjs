import { readFileSync, existsSync } from "node:fs";

function loadEnvFile(path) {
  if (!existsSync(path)) return;

  const text = readFileSync(path, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(line)) continue;
    const index = line.indexOf("=");
    const key = line.slice(0, index);
    const value = line.slice(index + 1).replace(/^"(.*)"$/, "$1");
    if (!process.env[key]) process.env[key] = value;
  }
}

function inferProjectRef() {
  const explicit = process.env.SUPABASE_PROJECT_REF?.trim();
  if (explicit) return explicit;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const match = url?.match(/^https:\/\/([a-z0-9-]+)\.supabase\.co\/?$/i);
  return match?.[1] ?? "";
}

function redact(value) {
  if (value === undefined || value === null || value === "") return null;
  return "***configured***";
}

function pickSafeConfig(config) {
  const mailerTemplateKeys = Object.keys(config).filter((key) => key.startsWith("mailer_templates") || key.startsWith("mailer_subjects"));
  return {
    site_url: config.site_url ?? null,
    uri_allow_list: config.uri_allow_list ?? null,
    external_email_enabled: config.external_email_enabled ?? null,
    mailer_autoconfirm: config.mailer_autoconfirm ?? null,
    mailer_secure_email_change_enabled: config.mailer_secure_email_change_enabled ?? null,
    smtp_admin_email: config.smtp_admin_email ?? null,
    smtp_host: config.smtp_host ?? null,
    smtp_port: config.smtp_port ?? null,
    smtp_user: config.smtp_user ? "***configured***" : null,
    smtp_pass: redact(config.smtp_pass),
    smtp_sender_name: config.smtp_sender_name ?? null,
    template_keys_configured: mailerTemplateKeys.sort(),
  };
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const accessToken = process.env.SUPABASE_ACCESS_TOKEN?.trim();
const projectRef = inferProjectRef();

if (!accessToken || !projectRef) {
  console.log("Supabase Auth config audit could not run against Management API.", {
    hasSupabaseAccessToken: Boolean(accessToken),
    hasProjectRef: Boolean(projectRef),
    inferredProjectRef: projectRef || null,
  });
  process.exit(0);
}

const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
  headers: {
    Authorization: `Bearer ${accessToken}`,
  },
});

const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error("Supabase Auth config audit failed.", {
    status: response.status,
    error: body?.message ?? body?.error ?? "Unknown Management API error",
  });
  process.exit(1);
}

console.log("Supabase Auth config audit result.");
console.log(JSON.stringify(pickSafeConfig(body), null, 2));
