import "server-only";

import { isIP } from "node:net";
import { headers } from "next/headers";
import { sendTransactionalEmail } from "@/lib/email/email-provider";
import { writeErrorLog } from "@/lib/error-logging";
import { sanitizeLogText } from "@/lib/operational-errors";
import { getSupabaseAdminClient } from "@/lib/supabase";
import type { NotificationLogStatus } from "@/types/notifications";

export type PublicFormKind = "contact_general" | "wholesale";

export type PublicRequestContext = {
  ipAddress: string | null;
  userAgent: string | null;
  submittedAt: string;
};

type PublicFormNotification = {
  kind: PublicFormKind;
  customerId: string;
  followupId?: string | null;
  name: string;
  email: string;
  phone: string;
  message?: string | null;
  businessName?: string | null;
  taxId?: string | null;
  city?: string | null;
  comment?: string | null;
  outcome?: string | null;
  context: PublicRequestContext;
};

type NotificationSettingsRow = {
  notification_emails: string | null;
  customer_service_email: string | null;
  notify_general_contact: boolean | null;
  notify_wholesale_requests: boolean | null;
};

const internalFallbackEmail = "car.zone.accesorioshn@gmail.com";

function firstForwardedIp(value: string | null) {
  return value?.split(",")[0]?.trim() || null;
}

function normalizeIp(value: string | null) {
  if (!value) {
    return null;
  }

  const withoutIpv6Brackets = value.replace(/^\[|\]$/g, "");
  return isIP(withoutIpv6Brackets) ? withoutIpv6Brackets : null;
}

function normalizeEmail(value: string | null | undefined) {
  return value?.trim().toLowerCase() ?? "";
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function parseEmailList(value: string | null | undefined) {
  return (value ?? "")
    .split(",")
    .map(normalizeEmail)
    .filter(isValidEmail);
}

function escapeHtml(value: string | null | undefined) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("es-HN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Tegucigalpa",
  }).format(new Date(value));
}

function getSiteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "https://carzoneaccesorios.vercel.app";
}

function row(label: string, value: string | null | undefined) {
  if (!value) {
    return "";
  }

  return `
    <tr>
      <td style="padding:10px 0;border-top:1px solid #eee;color:#666;width:36%;">${escapeHtml(label)}</td>
      <td style="padding:10px 0;border-top:1px solid #eee;font-weight:700;">${escapeHtml(value)}</td>
    </tr>
  `;
}

function buildInternalEmail(input: PublicFormNotification) {
  const isWholesale = input.kind === "wholesale";
  const adminPath = isWholesale ? "/admin/clientes-mayoristas?status=pending" : "/admin/crm";
  const title = isWholesale ? "Nueva solicitud de cuenta mayorista" : "Nuevo mensaje de contacto general";
  const intro = isWholesale
    ? "Revisa la solicitud y valida los datos antes de cambiar el estado mayorista."
    : "Ingresa al CRM para responder la consulta y completar el seguimiento.";

  return {
    subject: title,
    html: `
      <div style="margin:0;background:#f4f4f5;padding:32px;font-family:Arial,sans-serif;color:#080808;">
        <div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e4e1d8;border-radius:8px;padding:28px;">
          <p style="margin:0 0 8px;color:#e4252c;font-size:13px;font-weight:700;text-transform:uppercase;">Car Zone Accesorios</p>
          <h1 style="margin:0 0 18px;font-size:26px;">${escapeHtml(title)}</h1>
          <p style="margin:0 0 22px;color:#555;">${escapeHtml(intro)}</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            ${row("Nombre", input.name)}
            ${row("Empresa", input.businessName)}
            ${row("Correo", input.email)}
            ${row("Telefono", input.phone)}
            ${row("RTN", input.taxId)}
            ${row("Ciudad", input.city)}
            ${row("Mensaje", input.message ?? input.comment)}
            ${row("Fecha y hora", formatDate(input.context.submittedAt))}
          </table>
          <div style="margin-top:24px;">
            <a href="${getSiteUrl()}${adminPath}" style="display:inline-block;background:#e4252c;color:#fff;text-decoration:none;border-radius:6px;padding:12px 16px;font-weight:700;">Abrir panel administrativo</a>
          </div>
        </div>
      </div>
    `,
  };
}

function buildRequesterEmail(input: PublicFormNotification) {
  const isWholesale = input.kind === "wholesale";
  const title = isWholesale ? "Hemos recibido tu solicitud mayorista" : "Hemos recibido tu mensaje";
  const message = isWholesale
    ? "Gracias por solicitar una cuenta mayorista. Nuestro equipo revisara tu solicitud y te notificara cuando sea aprobada o si necesitamos mas informacion."
    : "Gracias por contactar a Car Zone Accesorios. Nuestro equipo revisara tu mensaje y te respondera pronto.";

  return {
    subject: title,
    html: `
      <div style="margin:0;background:#f4f4f5;padding:32px;font-family:Arial,sans-serif;color:#080808;">
        <div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e4e1d8;border-radius:8px;padding:28px;">
          <p style="margin:0 0 8px;color:#e4252c;font-size:13px;font-weight:700;text-transform:uppercase;">Car Zone Accesorios</p>
          <h1 style="margin:0 0 18px;font-size:26px;">${escapeHtml(title)}</h1>
          <p style="margin:0;color:#555;line-height:1.6;">${escapeHtml(message)}</p>
        </div>
      </div>
    `,
  };
}

async function writePublicAudit(input: {
  action: string;
  customerId?: string | null;
  context: PublicRequestContext;
  data: Record<string, unknown>;
}) {
  const admin = getSupabaseAdminClient();
  const { error } = await admin.from("audit_logs").insert({
    user_id: null,
    actor_role: "public",
    table_name: "public_forms",
    record_id: input.customerId ?? null,
    action: input.action,
    new_data: input.data,
    ip_address: input.context.ipAddress,
    user_agent: input.context.userAgent,
  });

  if (error) {
    await writeErrorLog({
      route: "/contacto",
      action: "public_forms.audit_log_failed",
      errorMessage: error.message,
      metadata: { audit_action: input.action, customer_id: input.customerId },
    });
  }
}

async function logNotification(input: {
  eventType: string;
  customerId: string;
  followupId?: string | null;
  recipientEmail: string | null;
  status: NotificationLogStatus;
  provider?: string | null;
  providerMessageId?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
  context: PublicRequestContext;
}) {
  const admin = getSupabaseAdminClient();
  const { error } = await admin.from("notification_logs").insert({
    event_type: input.eventType,
    order_id: null,
    recipient_email: input.recipientEmail,
    status: input.status,
    provider: input.provider ?? "none",
    provider_message_id: input.providerMessageId ?? null,
    error_message: sanitizeLogText(input.errorMessage, 700) || null,
    metadata: {
      customer_id: input.customerId,
      followup_id: input.followupId ?? null,
      ...input.metadata,
    },
  });

  if (error) {
    await writeErrorLog({
      route: "/contacto",
      action: "public_forms.notification_log_failed",
      errorMessage: error.message,
      metadata: { event_type: input.eventType, customer_id: input.customerId },
    });
  }

  await writePublicAudit({
    action: `${input.eventType}.${input.status}`,
    customerId: input.customerId,
    context: input.context,
    data: {
      recipient_email: input.recipientEmail,
      result: input.status,
      provider: input.provider ?? "none",
      error: sanitizeLogText(input.errorMessage, 500) || null,
    },
  });
}

async function sendAndLog(input: {
  eventType: string;
  recipientEmail: string;
  email: { subject: string; html: string };
  form: PublicFormNotification;
  audience: "internal" | "requester";
}) {
  const result = await sendTransactionalEmail({
    to: input.recipientEmail,
    subject: input.email.subject,
    html: input.email.html,
    idempotencyKey: `${input.eventType}-${input.form.customerId}-${input.form.followupId ?? "none"}-${input.recipientEmail}`,
    metadata: {
      event_type: input.eventType,
      customer_id: input.form.customerId,
      followup_id: input.form.followupId,
      audience: input.audience,
    },
  });

  await logNotification({
    eventType: input.eventType,
    customerId: input.form.customerId,
    followupId: input.form.followupId,
    recipientEmail: input.recipientEmail,
    status: result.status,
    provider: result.provider,
    providerMessageId: result.providerMessageId,
    errorMessage: result.errorMessage,
    metadata: {
      audience: input.audience,
      outcome: input.form.outcome ?? null,
      technical_message: sanitizeLogText(result.technicalMessage, 500) || null,
    },
    context: input.form.context,
  });

  if (!result.ok) {
    await writeErrorLog({
      route: "/contacto",
      action: `${input.eventType}.email_${result.status}`,
      errorMessage: result.errorMessage ?? "No se pudo enviar el correo.",
      userEmail: input.recipientEmail,
      metadata: {
        customer_id: input.form.customerId,
        followup_id: input.form.followupId,
        audience: input.audience,
        provider: result.provider,
        technical_message: result.technicalMessage,
      },
    });
  }
}

export async function getPublicRequestContext(): Promise<PublicRequestContext> {
  const headerStore = await headers();
  const forwardedIp =
    firstForwardedIp(headerStore.get("x-forwarded-for")) ??
    headerStore.get("x-real-ip") ??
    headerStore.get("cf-connecting-ip");

  return {
    ipAddress: normalizeIp(forwardedIp),
    userAgent: headerStore.get("user-agent")?.slice(0, 500) ?? null,
    submittedAt: new Date().toISOString(),
  };
}

export async function notifyPublicFormSubmission(input: PublicFormNotification) {
  const admin = getSupabaseAdminClient();
  const { data: settings, error } = await admin
    .from("company_settings")
    .select("notification_emails, customer_service_email, notify_general_contact, notify_wholesale_requests")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<NotificationSettingsRow>();

  if (error) {
    await writeErrorLog({
      route: "/contacto",
      action: "public_forms.notification_settings_failed",
      errorMessage: error.message,
      metadata: { kind: input.kind, customer_id: input.customerId },
    });
  }

  const configuredRecipients = parseEmailList(settings?.notification_emails);
  const customerServiceEmail = normalizeEmail(settings?.customer_service_email);
  const internalRecipients = [
    ...new Set(
      configuredRecipients.length > 0
        ? configuredRecipients
        : [isValidEmail(customerServiceEmail) ? customerServiceEmail : internalFallbackEmail],
    ),
  ];
  const notifyInternal =
    input.kind === "wholesale" ? settings?.notify_wholesale_requests !== false : settings?.notify_general_contact !== false;
  const internalEmail = buildInternalEmail(input);
  const requesterEmail = buildRequesterEmail(input);

  if (notifyInternal) {
    await Promise.all(
      internalRecipients.map((recipientEmail) =>
        sendAndLog({
          eventType: `public_form.${input.kind}.internal`,
          recipientEmail,
          email: internalEmail,
          form: input,
          audience: "internal",
        }),
      ),
    );
  } else {
    await logNotification({
      eventType: `public_form.${input.kind}.internal`,
      customerId: input.customerId,
      followupId: input.followupId,
      recipientEmail: null,
      status: "skipped",
      metadata: { reason: "disabled_by_settings" },
      context: input.context,
    });
  }

  if (isValidEmail(input.email)) {
    await sendAndLog({
      eventType: `public_form.${input.kind}.requester`,
      recipientEmail: input.email,
      email: requesterEmail,
      form: input,
      audience: "requester",
    });
  }
}

export async function findPublicFormAssignee(roleNames: string[]) {
  const admin = getSupabaseAdminClient();
  const { data: roles } = await admin.from("roles").select("id, name").in("name", roleNames).returns<Array<{ id: string; name: string }>>();
  const rolePriority = new Map(roleNames.map((name, index) => [name, index]));
  const roleById = new Map((roles ?? []).map((role) => [role.id, role.name]));
  const roleIds = [...roleById.keys()];

  if (roleIds.length === 0) {
    return null;
  }

  const { data: users } = await admin
    .from("users")
    .select("id, role_id, created_at")
    .eq("active", true)
    .in("role_id", roleIds)
    .order("created_at", { ascending: true })
    .returns<Array<{ id: string; role_id: string; created_at: string }>>();

  return (
    (users ?? []).sort((left, right) => {
      const leftPriority = rolePriority.get(roleById.get(left.role_id) ?? "") ?? Number.MAX_SAFE_INTEGER;
      const rightPriority = rolePriority.get(roleById.get(right.role_id) ?? "") ?? Number.MAX_SAFE_INTEGER;
      return leftPriority - rightPriority;
    })[0]?.id ?? null
  );
}

export async function ensureRegisteredWholesaleFollowup(input: {
  customerId: string;
  userId: string;
  phone: string;
  note: string;
  rejectedReview?: boolean;
}) {
  const admin = getSupabaseAdminClient();
  const assigneeId = await findPublicFormAssignee(["business_owner", "admin", "technical_owner"]);
  const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const { data: existing } = await admin
    .from("crm_followups")
    .select("id")
    .eq("customer_id", input.customerId)
    .eq("interaction_type", "solicitud_mayorista")
    .eq("status", "pending")
    .limit(1)
    .maybeSingle<{ id: string }>();

  const payload = {
    assigned_user_id: assigneeId,
    title: input.rejectedReview ? "Revisar caso mayorista rechazado" : "Solicitud de cuenta mayorista",
    interaction_type: "solicitud_mayorista",
    next_action: input.rejectedReview
      ? "Revisar manualmente el caso rechazado y contactar al cliente."
      : "Revisar datos de cuenta registrada y aprobar si corresponde.",
    due_at: dueAt,
    priority: "alta",
    phone: input.phone,
    notes: input.note,
    estimated_value: 0,
    monthly_amount: 0,
    status: "pending",
    updated_at: new Date().toISOString(),
  };
  const query = existing?.id
    ? admin.from("crm_followups").update(payload).eq("id", existing.id).select("id").single<{ id: string }>()
    : admin.from("crm_followups").insert({ customer_id: input.customerId, ...payload }).select("id").single<{ id: string }>();
  const { data: followup, error } = await query;

  if (!error && followup) {
    return { ok: true as const, followupId: followup.id, assigneeId, dueAt };
  }

  await admin.from("crm_notes").insert({
    customer_id: input.customerId,
    user_id: input.userId,
    note_type: "wholesale_status",
    note: "No se pudo crear el seguimiento automatico. Requiere revision manual.",
  });
  await writeErrorLog({
    route: "/contacto",
    action: "public_forms.registered_wholesale_followup_failed",
    errorMessage: error?.message ?? "No se pudo crear el seguimiento mayorista.",
    metadata: { customer_id: input.customerId, rejected_review: input.rejectedReview ?? false },
  });

  return { ok: false as const, followupId: null, assigneeId, dueAt };
}

export async function writeRegisteredWholesaleAudit(input: {
  action: string;
  customerId: string;
  email: string;
  phone: string;
  outcome: string;
  context: PublicRequestContext;
}) {
  await writePublicAudit({
    action: input.action,
    customerId: input.customerId,
    context: input.context,
    data: {
      email: input.email,
      phone: input.phone,
      origin: "cuenta_registrada",
      result: input.outcome,
    },
  });
}

