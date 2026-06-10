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

function envValue(...keys) {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return "";
}

function parseRedirects(raw) {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function requireValue(value, label) {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const accessToken = requireValue(envValue("SUPABASE_ACCESS_TOKEN"), "SUPABASE_ACCESS_TOKEN");
const projectRef = requireValue(inferProjectRef(), "SUPABASE_PROJECT_REF or NEXT_PUBLIC_SUPABASE_URL");
const smtpPass = requireValue(envValue("SUPABASE_AUTH_SMTP_PASS", "RESEND_API_KEY"), "SUPABASE_AUTH_SMTP_PASS or RESEND_API_KEY");
const siteUrl = envValue("SUPABASE_AUTH_SITE_URL", "NEXT_PUBLIC_SITE_URL") || "https://carzoneaccesorios.com";
const redirectUrls = parseRedirects(
  envValue("SUPABASE_AUTH_REDIRECT_URLS") ||
    [
      "https://carzoneaccesorios.com/auth/callback",
      "https://www.carzoneaccesorios.com/auth/callback",
      "https://carzoneaccesorios.com/actualizar-contrasena",
      "https://www.carzoneaccesorios.com/actualizar-contrasena",
      "http://localhost:3000/auth/callback",
      "http://localhost:3000/actualizar-contrasena",
    ].join(","),
);

const payload = {
  site_url: siteUrl.replace(/\/$/, ""),
  uri_allow_list: redirectUrls,
  external_email_enabled: true,
  mailer_secure_email_change_enabled: true,
  mailer_autoconfirm: false,
  smtp_admin_email: envValue("SUPABASE_AUTH_SMTP_FROM_EMAIL", "RESEND_FROM_EMAIL") || "sistema@carzoneaccesorios.com",
  smtp_host: envValue("SUPABASE_AUTH_SMTP_HOST") || "smtp.resend.com",
  smtp_port: Number(envValue("SUPABASE_AUTH_SMTP_PORT") || 465),
  smtp_user: envValue("SUPABASE_AUTH_SMTP_USER") || "resend",
  smtp_pass: smtpPass,
  smtp_sender_name: envValue("SUPABASE_AUTH_SMTP_SENDER_NAME", "RESEND_FROM_NAME") || "Car Zone Accesorios",
  mailer_subjects_confirmation: "Confirma tu cuenta - Car Zone Accesorios",
  mailer_templates_confirmation_content:
    '<h2>Confirma tu cuenta</h2><p>Gracias por registrarte en Car Zone Accesorios. Para activar tu cuenta, confirma tu correo electrónico.</p><p><a href="https://carzoneaccesorios.com/auth/callback?token_hash={{ .TokenHash }}&amp;type=signup&amp;next=/verificacion/cuenta-confirmada&amp;email={{ .Email }}">Confirmar mi cuenta</a></p><p>Este enlace expira pronto y solo debe usarse una vez.</p><p>Si no solicitaste esta cuenta, puedes ignorar este correo.</p>',
  mailer_subjects_recovery: "Restablece tu contraseña - Car Zone Accesorios",
  mailer_templates_recovery_content:
    '<h2>Restablece tu contraseña</h2><p>Hola, recibimos una solicitud para restablecer la contraseña de tu cuenta en Car Zone Accesorios.</p><p><a href="https://carzoneaccesorios.com/auth/callback?token_hash={{ .TokenHash }}&amp;type=recovery&amp;next=/actualizar-contrasena">Cambiar mi contraseña</a></p><p>Si no solicitaste este cambio, puedes ignorar este correo.</p>',
  mailer_subjects_invite: "Acceso al sistema administrativo - Car Zone Accesorios",
  mailer_templates_invite_content:
    '<h2>Acceso al sistema administrativo</h2><p>Has recibido acceso al sistema administrativo de Car Zone Accesorios.</p><p><a href="{{ .ConfirmationURL }}">Aceptar invitación</a></p><p>Usa este enlace solo desde un dispositivo seguro. Si no esperabas esta invitación, ignora este correo y avisa al dueño operativo.</p>',
  mailer_subjects_magic_link: "Enlace de acceso - Car Zone Accesorios",
  mailer_templates_magic_link_content:
    '<h2>Enlace de acceso</h2><p>Usa el siguiente botón para ingresar a Car Zone Accesorios.</p><p><a href="{{ .ConfirmationURL }}">Ingresar</a></p><p>Este enlace expira pronto y solo puede usarse una vez.</p>',
  mailer_subjects_email_change: "Confirma el cambio de correo - Car Zone Accesorios",
  mailer_templates_email_change_content:
    '<h2>Confirma el cambio de correo</h2><p>Confirma que quieres cambiar tu correo a {{ .NewEmail }}.</p><p><a href="{{ .ConfirmationURL }}">Confirmar nuevo correo</a></p><p>Si no solicitaste este cambio, ignora este correo y contacta soporte.</p>',
  mailer_subjects_reauthentication: "Confirma tu identidad - Car Zone Accesorios",
  mailer_templates_reauthentication_content:
    '<h2>Confirma tu identidad</h2><p>Usa este código para confirmar que eres tú:</p><p style="font-size:24px;font-weight:700;">{{ .Token }}</p><p>Si no solicitaste esta verificación, puedes ignorar este correo.</p>',
};

const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
  method: "PATCH",
  headers: {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});

const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error("Supabase Auth SMTP configuration failed.", {
    status: response.status,
    error: body?.message ?? body?.error ?? "Unknown Management API error",
  });
  process.exit(1);
}

console.log("Supabase Auth SMTP configured with Resend.", {
  projectRef,
  siteUrl: payload.site_url,
  redirectUrlCount: payload.uri_allow_list.length,
  smtpHost: payload.smtp_host,
  smtpPort: payload.smtp_port,
  smtpUserConfigured: Boolean(payload.smtp_user),
  smtpPasswordConfigured: Boolean(payload.smtp_pass),
  smtpAdminEmail: payload.smtp_admin_email,
  smtpSenderName: payload.smtp_sender_name,
  emailConfirmationsRequired: payload.mailer_autoconfirm === false,
});
