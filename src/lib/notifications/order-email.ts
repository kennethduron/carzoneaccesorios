import { getSupabaseAdminClient } from "@/lib/supabase";
import { writeErrorLog } from "@/lib/error-logging";
import { formatCurrency } from "@/utils/pricing";
import type { NotificationLogStatus } from "@/types/notifications";

type CheckoutOrderCreated = {
  orderId: string;
  orderNumber: string;
  trackingCode: string;
};

type NotificationSettingsRow = {
  notification_emails: string | null;
  notify_new_orders: boolean | null;
};

type OrderNotificationRow = {
  id: string;
  order_number: string;
  tracking_code: string | null;
  customer_name: string;
  phone: string;
  payment_method: string;
  status: string;
  total: unknown;
  created_at: string;
  order_items: Array<{
    product_name: string;
    quantity: unknown;
    line_total: unknown;
  }> | null;
  payments: Array<{
    payment_status: string | null;
    status: string | null;
  }> | null;
};

const resendEndpoint = "https://api.resend.com/emails";

function getSiteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "https://carzoneaccesorios.vercel.app";
}

function getFromEmail() {
  return process.env.RESEND_FROM_EMAIL || "Car Zone Accesorios <onboarding@resend.dev>";
}

function parseNotificationEmails(rawValue: string | null | undefined) {
  const fromSettings = rawValue
    ?.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  const fromEnv = process.env.ORDER_NOTIFICATION_EMAILS?.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set([...(fromSettings ?? []), ...(fromEnv ?? [])])];
}

function paymentMethodLabel(value: string) {
  const labels: Record<string, string> = {
    bank_transfer: "Transferencia bancaria",
    cash: "Efectivo",
    card: "Tarjeta",
  };

  return labels[value] ?? value;
}

function paymentStatusLabel(value: string | null | undefined) {
  const labels: Record<string, string> = {
    pending_review: "Pendiente de revisión",
    pending: "Pendiente de pago",
    confirmed: "Pagado",
    paid: "Pagado",
    rejected: "Rechazado",
  };

  return labels[value ?? ""] ?? "Pendiente de revisión";
}

function escapeHtml(value: string) {
  return value
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

function buildAdminUrl(path: string) {
  return `${getSiteUrl()}${path}`;
}

function buildEmailHtml(order: OrderNotificationRow) {
  const payment = order.payments?.[0] ?? null;
  const paymentStatus = paymentStatusLabel(payment?.payment_status ?? payment?.status);
  const crmUrl = buildAdminUrl(`/admin/crm?orderId=${encodeURIComponent(order.id)}`);
  const adminUrl = buildAdminUrl(`/admin/pedidos?orderId=${encodeURIComponent(order.id)}`);
  const products = (order.order_items ?? []).slice(0, 5);

  return `
    <div style="margin:0;background:#f7f7f2;padding:32px;font-family:Arial,sans-serif;color:#1c1d1b;">
      <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e4e1d8;border-radius:8px;padding:28px;">
        <p style="margin:0 0 8px;color:#246a73;font-size:13px;font-weight:700;text-transform:uppercase;">Car Zone Accesorios</p>
        <h1 style="margin:0 0 18px;font-size:26px;line-height:1.2;">Nuevo pedido recibido</h1>
        <p style="margin:0 0 22px;color:#555;">Ingresa al panel administrativo para revisar el pedido, contactar al cliente y continuar con la preparación.</p>

        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${row("Pedido", order.order_number)}
          ${row("Código de rastreo", order.tracking_code ?? "Sin código")}
          ${row("Cliente", order.customer_name)}
          ${row("Teléfono", order.phone)}
          ${row("Método de pago", paymentMethodLabel(order.payment_method))}
          ${row("Estado", paymentStatus)}
          ${row("Total", formatCurrency(Number(order.total ?? 0)))}
          ${row("Fecha y hora", formatDate(order.created_at))}
        </table>

        <div style="margin-top:22px;padding:16px;border-radius:8px;background:#f7f7f2;">
          <p style="margin:0 0 10px;font-weight:700;">Productos principales</p>
          <ul style="margin:0;padding-left:18px;color:#444;">
            ${
              products.length > 0
                ? products
                    .map(
                      (item) =>
                        `<li>${escapeHtml(String(item.quantity ?? 0))} x ${escapeHtml(item.product_name)} - ${escapeHtml(
                          formatCurrency(Number(item.line_total ?? 0)),
                        )}</li>`,
                    )
                    .join("")
                : "<li>Sin productos registrados</li>"
            }
          </ul>
        </div>

        <div style="margin-top:24px;">
          <a href="${crmUrl}" style="display:inline-block;margin:0 8px 10px 0;background:#246a73;color:#ffffff;text-decoration:none;border-radius:6px;padding:12px 16px;font-weight:700;">Ver pedido en CRM</a>
          <a href="${adminUrl}" style="display:inline-block;margin:0 0 10px 0;background:#1c1d1b;color:#ffffff;text-decoration:none;border-radius:6px;padding:12px 16px;font-weight:700;">Ver pedido en admin</a>
        </div>
      </div>
    </div>
  `;
}

function row(label: string, value: string) {
  return `
    <tr>
      <td style="padding:10px 0;border-top:1px solid #eee;color:#666;width:42%;">${escapeHtml(label)}</td>
      <td style="padding:10px 0;border-top:1px solid #eee;font-weight:700;">${escapeHtml(value)}</td>
    </tr>
  `;
}

async function logNotification(input: {
  eventType: string;
  orderId: string | null;
  recipientEmail: string | null;
  status: NotificationLogStatus;
  providerMessageId?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const admin = getSupabaseAdminClient();
  const { error } = await admin.from("notification_logs").insert({
    event_type: input.eventType,
    order_id: input.orderId,
    recipient_email: input.recipientEmail,
    status: input.status,
    provider: "resend",
    provider_message_id: input.providerMessageId ?? null,
    error_message: input.errorMessage ?? null,
    metadata: input.metadata ?? {},
  });

  if (error) {
    await writeErrorLog({
      route: "/checkout",
      action: "notifications.log_failed",
      errorMessage: error.message,
      metadata: {
        event_type: input.eventType,
        order_id: input.orderId,
        recipient_email: input.recipientEmail,
      },
    });
  }
}

async function sendResendEmail(input: { to: string; subject: string; html: string; idempotencyKey: string }) {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const response = await fetch(resendEndpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": input.idempotencyKey,
    },
    body: JSON.stringify({
      from: getFromEmail(),
      to: input.to,
      subject: input.subject,
      html: input.html,
    }),
  });

  const payload = (await response.json().catch(() => null)) as { id?: string; message?: string; error?: string } | null;

  if (!response.ok) {
    throw new Error(payload?.message || payload?.error || `Resend responded with status ${response.status}.`);
  }

  return payload?.id ?? null;
}

export async function notifyAdminsOfNewOrder(createdOrder: CheckoutOrderCreated) {
  const admin = getSupabaseAdminClient();

  const { data: settings, error: settingsError } = await admin
    .from("company_settings")
    .select("notification_emails, notify_new_orders")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle<NotificationSettingsRow>();

  if (settingsError) {
    await logNotification({
      eventType: "order.created",
      orderId: createdOrder.orderId,
      recipientEmail: null,
      status: "failed",
      errorMessage: settingsError.message,
    });
    return;
  }

  if (settings?.notify_new_orders === false) {
    await logNotification({
      eventType: "order.created",
      orderId: createdOrder.orderId,
      recipientEmail: null,
      status: "skipped",
      metadata: { reason: "notify_new_orders_disabled" },
    });
    return;
  }

  const recipients = parseNotificationEmails(settings?.notification_emails);

  if (recipients.length === 0) {
    await logNotification({
      eventType: "order.created",
      orderId: createdOrder.orderId,
      recipientEmail: null,
      status: "skipped",
      metadata: { reason: "no_recipients_configured" },
    });
    return;
  }

  const { data: order, error: orderError } = await admin
    .from("orders")
    .select(
      `
      id,
      order_number,
      tracking_code,
      customer_name,
      phone,
      payment_method,
      status,
      total,
      created_at,
      order_items(product_name, quantity, line_total),
      payments(payment_status, status)
    `,
    )
    .eq("id", createdOrder.orderId)
    .maybeSingle<OrderNotificationRow>();

  if (orderError || !order) {
    await logNotification({
      eventType: "order.created",
      orderId: createdOrder.orderId,
      recipientEmail: null,
      status: "failed",
      errorMessage: orderError?.message ?? "Order not found for notification.",
    });
    return;
  }

  const subject = "Nuevo pedido recibido - Car Zone Accesorios";
  const html = buildEmailHtml(order);

  await Promise.all(
    recipients.map(async (recipient) => {
      try {
        const providerMessageId = await sendResendEmail({
          to: recipient,
          subject,
          html,
          idempotencyKey: `order-created-${createdOrder.orderId}-${recipient}`,
        });
        await logNotification({
          eventType: "order.created",
          orderId: createdOrder.orderId,
          recipientEmail: recipient,
          status: "sent",
          providerMessageId,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown email notification error.";
        await logNotification({
          eventType: "order.created",
          orderId: createdOrder.orderId,
          recipientEmail: recipient,
          status: "failed",
          errorMessage,
        });
        await writeErrorLog({
          route: "/checkout",
          action: "notifications.order_created_email_failed",
          errorMessage,
          errorStack: error instanceof Error ? error.stack : null,
          metadata: {
            order_id: createdOrder.orderId,
            order_number: createdOrder.orderNumber,
            recipient_email: recipient,
          },
        });
      }
    }),
  );
}
