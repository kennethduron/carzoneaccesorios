import "server-only";

import { writeErrorLog } from "@/lib/error-logging";
import { enqueueEmail, processCriticalEmailQueue } from "@/lib/notifications/email-queue";
import type { WholesaleCustomerType } from "@/types/wholesale";

const officialSiteUrl = "https://carzoneaccesorios.com";
const loginUrl = `${officialSiteUrl}/login`;

type CustomerEmailInput = {
  customerId?: string | null;
  userId?: string | null;
  email?: string | null;
  name?: string | null;
  wholesaleCustomerType?: WholesaleCustomerType;
};

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function displayName(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed || "cliente";
}

function normalizeEmail(value?: string | null) {
  return value?.trim().toLowerCase() ?? "";
}

function baseEmail(title: string, content: string) {
  return `
    <div style="margin:0;background:#f4f4f5;padding:24px;font-family:Arial,sans-serif;color:#080808;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="padding:24px 24px 12px;border-bottom:1px solid #f1f1f1;">
          <p style="margin:0 0 8px;color:#e4252c;font-size:13px;font-weight:700;text-transform:uppercase;">Car Zone Accesorios</p>
          <h1 style="margin:0;font-size:24px;line-height:1.25;color:#080808;">${escapeHtml(title)}</h1>
        </div>
        <div style="padding:24px;font-size:15px;line-height:1.65;color:#333333;">
          ${content}
          <p style="margin:28px 0 0;color:#555555;">Atentamente,<br><strong>Car Zone Accesorios</strong></p>
        </div>
      </div>
    </div>
  `;
}

function actionButton(label: string, href: string) {
  return `
    <p style="margin:22px 0;">
      <a href="${escapeHtml(href)}" style="display:inline-block;background:#e4252c;color:#ffffff;text-decoration:none;border-radius:6px;padding:12px 16px;font-weight:700;">
        ${escapeHtml(label)}
      </a>
    </p>
  `;
}

function welcomeHtml(name: string) {
  return baseEmail(
    "Bienvenido a Car Zone Accesorios",
    `
      <p style="margin:0 0 16px;">Hola ${escapeHtml(name)},</p>
      <p style="margin:0 0 16px;">Gracias por crear tu cuenta en Car Zone Accesorios.</p>
      <p style="margin:0 0 16px;">Desde ahora puedes revisar nuestro catálogo, realizar pedidos, consultar el estado de tus compras y acceder a tus facturas desde tu cuenta.</p>
      <p style="margin:0 0 16px;">Si compras con frecuencia o tienes un negocio, también puedes solicitar una cuenta mayorista para acceder a beneficios especiales.</p>
      <p style="margin:18px 0 8px;font-weight:700;">Requisitos para cuenta mayorista:</p>
      <ul style="margin:0 0 16px;padding-left:20px;">
        <li>Primera compra mínima: L 10,000.</li>
        <li>Compras posteriores: sin mínimo obligatorio.</li>
      </ul>
      <p style="margin:18px 0 8px;font-weight:700;">Beneficios:</p>
      <ul style="margin:0 0 16px;padding-left:20px;">
        <li>Precios especiales.</li>
        <li>Atención personalizada.</li>
        <li>Seguimiento comercial.</li>
        <li>Acceso a mejores oportunidades de compra.</li>
      </ul>
      ${actionButton("Iniciar sesión", loginUrl)}
    `,
  );
}

function wholesaleApprovedHtml(name: string, wholesaleCustomerType: WholesaleCustomerType) {
  const conditions =
    wholesaleCustomerType === "existing"
      ? "Puedes comprar con precios mayoristas desde ahora, sin requisito de primera compra mínima."
      : "Tu primera compra mayorista debe alcanzar L 10,000. Después de completar esa primera compra, podrás comprar cualquier monto.";

  return baseEmail(
    "Tu cuenta mayorista fue aprobada",
    `
      <p style="margin:0 0 16px;">Hola ${escapeHtml(name)},</p>
      <p style="margin:0 0 16px;">Nos alegra informarte que tu solicitud de cuenta mayorista fue aprobada.</p>
      <p style="margin:0 0 16px;">${escapeHtml(conditions)}</p>
      <p style="margin:0 0 16px;">Puedes iniciar sesión en tu cuenta para revisar productos y precios disponibles.</p>
      ${actionButton("Iniciar sesión", loginUrl)}
      <p style="margin:0 0 16px;">Si tienes dudas, puedes comunicarte con nuestro equipo.</p>
    `,
  );
}

function wholesaleRejectedHtml(name: string) {
  return baseEmail(
    "Resultado de tu solicitud mayorista",
    `
      <p style="margin:0 0 16px;">Hola ${escapeHtml(name)},</p>
      <p style="margin:0 0 16px;">Gracias por solicitar una cuenta mayorista en Car Zone Accesorios.</p>
      <p style="margin:0 0 16px;">Tu solicitud fue revisada y, por el momento, no cumple con los requisitos necesarios para activar beneficios mayoristas.</p>
      <p style="margin:0 0 16px;">Puedes continuar comprando normalmente como cliente y volver a solicitar una cuenta mayorista más adelante cuando cumplas los requisitos.</p>
    `,
  );
}

async function safeEnqueueCustomerEmail(input: {
  email: string;
  name: string;
  subject: string;
  templateKey: string;
  html: string;
  relatedModule: "CRM" | "mayoristas";
  relatedId: string | null;
  idempotencyKey: string;
  errorAction: string;
}) {
  try {
    const result = await enqueueEmail({
      toEmail: input.email,
      toName: input.name,
      subject: input.subject,
      templateKey: input.templateKey,
      payload: {
        html: input.html,
        official_site_url: officialSiteUrl,
        login_url: loginUrl,
      },
      relatedModule: input.relatedModule,
      relatedId: input.relatedId,
      priority: 4,
      idempotencyKey: input.idempotencyKey,
    });

    if (!result.queued && result.reason !== "duplicate") {
      await writeErrorLog({
        route: "/email/customer-lifecycle",
        action: input.errorAction,
        errorMessage: "No se pudo encolar el correo transaccional.",
        userEmail: input.email,
        metadata: {
          template_key: input.templateKey,
          related_id: input.relatedId,
          queue_result: result.reason,
        },
      });
    }

    if (result.queued) {
      await processCriticalEmailQueue({
        queueIds: [result.id],
        limit: 1,
        route: "/email/customer-lifecycle",
        action: `${input.errorAction}.queue_process_failed`,
        metadata: {
          template_key: input.templateKey,
          related_id: input.relatedId,
          queue_id: result.id,
        },
      });
    }

    return result;
  } catch (error) {
    await writeErrorLog({
      route: "/email/customer-lifecycle",
      action: input.errorAction,
      errorMessage: error instanceof Error ? error.message : "No se pudo encolar el correo transaccional.",
      userEmail: input.email,
      metadata: {
        template_key: input.templateKey,
        related_id: input.relatedId,
      },
    });

    return { queued: false, id: null, reason: "error" as const };
  }
}

export async function queueCustomerWelcomeEmail(input: CustomerEmailInput) {
  const email = normalizeEmail(input.email);
  const userId = input.userId?.trim();

  if (!email || !userId) {
    return { queued: false, id: null, reason: "missing_recipient" as const };
  }

  const name = displayName(input.name);
  return safeEnqueueCustomerEmail({
    email,
    name,
    subject: "Bienvenido a Car Zone Accesorios",
    templateKey: "customer.welcome",
    html: welcomeHtml(name),
    relatedModule: "CRM",
    relatedId: input.customerId ?? userId,
    idempotencyKey: `customer.welcome:${userId}`,
    errorAction: "customer.welcome_email_queue_failed",
  });
}

export async function queueWholesaleApprovedEmail(input: CustomerEmailInput) {
  const email = normalizeEmail(input.email);
  const customerId = input.customerId?.trim();

  if (!email || !customerId) {
    return { queued: false, id: null, reason: "missing_recipient" as const };
  }

  const name = displayName(input.name);
  const wholesaleCustomerType = input.wholesaleCustomerType ?? "new";
  return safeEnqueueCustomerEmail({
    email,
    name,
    subject: "Tu cuenta mayorista fue aprobada",
    templateKey: "wholesale.approved",
    html: wholesaleApprovedHtml(name, wholesaleCustomerType),
    relatedModule: "mayoristas",
    relatedId: customerId,
    idempotencyKey: `wholesale.approved:${customerId}:${wholesaleCustomerType}`,
    errorAction: "wholesale.approved_email_queue_failed",
  });
}

export async function queueWholesaleRejectedEmail(input: CustomerEmailInput) {
  const email = normalizeEmail(input.email);
  const customerId = input.customerId?.trim();

  if (!email || !customerId) {
    return { queued: false, id: null, reason: "missing_recipient" as const };
  }

  const name = displayName(input.name);
  return safeEnqueueCustomerEmail({
    email,
    name,
    subject: "Resultado de tu solicitud mayorista",
    templateKey: "wholesale.rejected",
    html: wholesaleRejectedHtml(name),
    relatedModule: "mayoristas",
    relatedId: customerId,
    idempotencyKey: `wholesale.rejected:${customerId}`,
    errorAction: "wholesale.rejected_email_queue_failed",
  });
}
