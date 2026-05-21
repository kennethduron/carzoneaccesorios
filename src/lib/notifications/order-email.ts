import { getSupabaseAdminClient } from "@/lib/supabase";
import { writeErrorLog } from "@/lib/error-logging";
import { sendTransactionalEmail } from "@/lib/email/email-provider";
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

function getSiteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "https://carzoneaccesorios.vercel.app";
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
    <div style="margin:0;background:#f4f4f5;padding:32px;font-family:Arial,sans-serif;color:#080808;">
      <div style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e4e1d8;border-radius:8px;padding:28px;">
        <p style="margin:0 0 8px;color:#e4252c;font-size:13px;font-weight:700;text-transform:uppercase;">Car Zone Accesorios</p>
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

        <div style="margin-top:22px;padding:16px;border-radius:8px;background:#f4f4f5;">
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
          <a href="${crmUrl}" style="display:inline-block;margin:0 8px 10px 0;background:#e4252c;color:#ffffff;text-decoration:none;border-radius:6px;padding:12px 16px;font-weight:700;">Ver pedido en CRM</a>
          <a href="${adminUrl}" style="display:inline-block;margin:0 0 10px 0;background:#080808;color:#ffffff;text-decoration:none;border-radius:6px;padding:12px 16px;font-weight:700;">Ver pedido en admin</a>
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
    provider: typeof input.metadata?.provider === "string" ? input.metadata.provider : "unknown",
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
      const result = await sendTransactionalEmail({
        to: recipient,
        subject,
        html,
        idempotencyKey: `order-created-${createdOrder.orderId}-${recipient}`,
        metadata: {
          event_type: "order.created",
          order_id: createdOrder.orderId,
          order_number: createdOrder.orderNumber,
        },
      });

      await logNotification({
        eventType: "order.created",
        orderId: createdOrder.orderId,
        recipientEmail: recipient,
        status: result.status,
        providerMessageId: result.providerMessageId,
        errorMessage: result.errorMessage,
        metadata: {
          provider: result.provider,
          technical_message: result.technicalMessage,
        },
      });

      if (!result.ok) {
        await writeErrorLog({
          route: "/checkout",
          action: result.status === "skipped" ? "notifications.email_provider_skipped" : "notifications.order_created_email_failed",
          errorMessage: result.errorMessage ?? "Email provider failed.",
          metadata: {
            order_id: createdOrder.orderId,
            order_number: createdOrder.orderNumber,
            recipient_email: recipient,
            provider: result.provider,
            technical_message: result.technicalMessage,
          },
        });
      }
    }),
  );
}



