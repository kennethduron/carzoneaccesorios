import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import { writeErrorLog } from "@/lib/error-logging";
import { enqueueEmail, processCriticalEmailQueue } from "@/lib/notifications/email-queue";
import { queuePreferenceEmail } from "@/lib/notifications/cron-jobs";
import { createInternalNotification } from "@/lib/notifications/notification-center";
import { formatCurrency } from "@/utils/pricing";
import type { NotificationLogStatus } from "@/types/notifications";

type CheckoutOrderCreated = {
  orderId: string;
  orderNumber: string;
  trackingCode: string;
};

type NotificationSettingsRow = {
  notify_new_orders: boolean | null;
};

type OrderNotificationRow = {
  id: string;
  order_number: string;
  tracking_code: string | null;
  email: string | null;
  customer_name: string;
  phone: string;
  payment_method: string;
  status: string;
  email_updates_opt_in: boolean | null;
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
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "https://carzoneaccesorios.com";
}

function paymentMethodLabel(value: string) {
  const labels: Record<string, string> = {
    bank_transfer: "Transferencia bancaria",
    cash: "Efectivo",
    card: "Tarjeta mediante enlace de pago",
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
          ${row("Número de seguimiento", order.tracking_code ?? "Sin código")}
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

function buildCustomerOrderReceivedHtml(order: OrderNotificationRow) {
  const payment = order.payments?.[0] ?? null;
  const paymentStatus = paymentStatusLabel(payment?.payment_status ?? payment?.status);
  const trackingUrl = `${getSiteUrl()}/rastreo?codigo=${encodeURIComponent(order.tracking_code ?? "")}`;
  const products = (order.order_items ?? []).slice(0, 8);

  return `
    <div style="margin:0;background:#f4f4f5;padding:32px;font-family:Arial,sans-serif;color:#080808;">
      <div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e4e1d8;border-radius:8px;padding:28px;">
        <p style="margin:0 0 8px;color:#e4252c;font-size:13px;font-weight:700;text-transform:uppercase;">Car Zone Accesorios</p>
        <h1 style="margin:0 0 16px;font-size:25px;line-height:1.25;">Pedido recibido</h1>
        <p style="margin:0 0 18px;color:#555;line-height:1.6;">Hola ${escapeHtml(order.customer_name)}. Hemos recibido tu pedido. Nuestro equipo lo revisará pronto.</p>
        ${
          order.payment_method === "card"
            ? '<p style="margin:0 0 18px;color:#555;line-height:1.6;">Nuestro equipo te contactará por WhatsApp para enviarte el enlace de pago seguro. No ingreses datos de tarjeta en esta página.</p>'
            : ""
        }
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${row("Pedido", order.order_number)}
          ${row("Fecha", formatDate(order.created_at))}
          ${row("Método de pago", paymentMethodLabel(order.payment_method))}
          ${row("Estado inicial", paymentStatus)}
          ${row("Total", formatCurrency(Number(order.total ?? 0)))}
        </table>
        <div style="margin-top:22px;padding:16px;border-radius:8px;background:#f4f4f5;">
          <p style="margin:0 0 10px;font-weight:700;">Resumen</p>
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
                : "<li>Productos registrados en el pedido.</li>"
            }
          </ul>
        </div>
        <div style="margin-top:24px;">
          <a href="${trackingUrl}" style="display:inline-block;background:#e4252c;color:#ffffff;text-decoration:none;border-radius:6px;padding:12px 16px;font-weight:700;">Rastrear pedido activo</a>
        </div>
        <p style="margin:18px 0 0;color:#666;font-size:13px;line-height:1.5;">El rastreo público solo muestra pedidos activos. Si tu pedido ya fue entregado y pagado, cancelado o cerrado, dejará de aparecer en el rastreo público.</p>
        <p style="margin:14px 0 0;color:#666;font-size:13px;">Contacto: WhatsApp y teléfono oficial publicados en carzoneaccesorios.com.</p>
      </div>
    </div>
  `;
}

function statusLabel(value: string) {
  const labels: Record<string, string> = {
    confirmado: "confirmado",
    preparacion: "en preparación",
    empacado: "empacado",
    enviado: "enviado",
    en_ruta: "en ruta",
    entregado: "entregado",
    cancelado: "cancelado",
    approved: "pago confirmado",
    rejected: "pago rechazado",
  };

  return labels[value] ?? value;
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

async function logIncompleteImmediateOrderStatusEmail(input: {
  queueId: string;
  orderId: string;
  orderNumber: string;
  recipientEmail: string;
  eventType: string;
  status: string;
  processingResult: Record<string, unknown>;
}) {
  const admin = getSupabaseAdminClient();
  const { data: queueItem, error } = await admin
    .from("email_queue")
    .select("id, status, attempts, max_attempts, last_error, provider, provider_message_id, scheduled_at, sent_at, updated_at")
    .eq("id", input.queueId)
    .maybeSingle<{
      id: string;
      status: string | null;
      attempts: number | null;
      max_attempts: number | null;
      last_error: string | null;
      provider: string | null;
      provider_message_id: string | null;
      scheduled_at: string | null;
      sent_at: string | null;
      updated_at: string | null;
    }>();

  if (error) {
    await writeErrorLog({
      route: "/admin/pedidos",
      action: "notifications.immediate_email_status_check_failed",
      errorMessage: error.message,
      metadata: {
        queue_id: input.queueId,
        order_id: input.orderId,
        event_type: input.eventType,
      },
    });
    return;
  }

  if (!queueItem || queueItem.status === "sent" || queueItem.status === "cancelled") {
    return;
  }

  await logNotification({
    eventType: "customer.order_status_update",
    orderId: input.orderId,
    recipientEmail: input.recipientEmail,
    status: "failed",
    errorMessage: "immediate_email_processing_incomplete",
    metadata: {
      provider: "email_queue",
      reason: "immediate_email_processing_incomplete",
      queue_id: input.queueId,
      queue_status: queueItem.status,
      attempts: queueItem.attempts,
      max_attempts: queueItem.max_attempts,
      last_error: queueItem.last_error,
      provider_message_id: queueItem.provider_message_id,
      scheduled_at: queueItem.scheduled_at,
      sent_at: queueItem.sent_at,
      updated_at: queueItem.updated_at,
      order_number: input.orderNumber,
      event_type: input.eventType,
      status: input.status,
      processing_result: input.processingResult,
    },
  });

  await writeErrorLog({
    route: "/admin/pedidos",
    action: "notifications.immediate_email_processing_incomplete",
    errorMessage: "El correo inmediato de actualizacion de pedido no quedo enviado.",
    metadata: {
      queue_id: input.queueId,
      queue_status: queueItem.status,
      order_id: input.orderId,
      order_number: input.orderNumber,
      event_type: input.eventType,
      status: input.status,
      attempts: queueItem.attempts,
      max_attempts: queueItem.max_attempts,
      last_error: queueItem.last_error,
      processing_result: input.processingResult,
    },
  });
}

export async function notifyAdminsOfNewOrder(createdOrder: CheckoutOrderCreated) {
  const admin = getSupabaseAdminClient();

  const { data: settings, error: settingsError } = await admin
    .from("company_settings")
    .select("notify_new_orders")
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

  const legacyEmailDisabled = settings?.notify_new_orders === false;

  if (legacyEmailDisabled) {
    await logNotification({
      eventType: "order.created",
      orderId: createdOrder.orderId,
      recipientEmail: null,
      status: "skipped",
      metadata: { reason: "notify_new_orders_disabled" },
    });
  }

  const { data: order, error: orderError } = await admin
    .from("orders")
    .select(
      `
      id,
      order_number,
      tracking_code,
      email,
      customer_name,
      phone,
      payment_method,
      status,
      email_updates_opt_in,
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
  const payment = order.payments?.[0] ?? null;
  const paymentStatus = payment?.payment_status ?? payment?.status ?? "pending";

  await createInternalNotification({
    type: "order.created",
    title: "Nuevo pedido recibido",
    message: `El pedido ${order.order_number} fue creado y requiere revisión operativa.`,
    severity: "info",
    module: "pedidos",
    orderId: createdOrder.orderId,
    metadata: {
      order_number: order.order_number,
      tracking_code: order.tracking_code,
      customer_name: order.customer_name,
      customer_phone: order.phone,
      customer_email: order.email,
      payment_method: order.payment_method,
      payment_status: paymentStatus,
      total: order.total,
      action_path: "/admin/pedidos?task=new_orders",
    },
    dedupeKey: `order.created:${createdOrder.orderId}`,
  });

  if (order.payment_method === "bank_transfer") {
    await createInternalNotification({
      type: paymentStatus === "pending" ? "payment.transfer_review" : "payment.pending",
      title: order.payment_method === "bank_transfer" ? "Transferencia en revisión" : "Pago pendiente",
      message: `El pedido ${order.order_number} tiene pago pendiente de revisión.`,
      severity: "warning",
      module: "pagos",
      orderId: createdOrder.orderId,
      metadata: {
        order_number: order.order_number,
        customer_name: order.customer_name,
        payment_method: order.payment_method,
        payment_status: paymentStatus,
      },
      dedupeKey: `payment.transfer_review:${createdOrder.orderId}`,
    });
  } else if (order.payment_method === "cash") {
    await createInternalNotification({
      type: "payment.pending",
      title: "Pedido contra entrega",
      message: `El pedido ${order.order_number} será cobrado contra entrega.`,
      severity: "info",
      module: "pagos",
      orderId: createdOrder.orderId,
      metadata: {
        order_number: order.order_number,
        customer_name: order.customer_name,
        payment_method: order.payment_method,
        payment_status: paymentStatus,
      },
      dedupeKey: `payment.cash_on_delivery:${createdOrder.orderId}`,
    });
  } else if (order.payment_method === "card") {
    await createInternalNotification({
      type: "payment.pending",
      title: "Pago con tarjeta mediante enlace pendiente",
      message: `El pedido ${order.order_number} requiere enviar el enlace de pago por WhatsApp y confirmarlo manualmente.`,
      severity: "warning",
      module: "pagos",
      orderId: createdOrder.orderId,
      metadata: {
        order_number: order.order_number,
        customer_name: order.customer_name,
        customer_phone: order.phone,
        payment_method: order.payment_method,
        payment_status: paymentStatus,
        total: order.total,
        action_path: "/admin/pedidos?task=pending_payments",
      },
      dedupeKey: `payment.card_link:${createdOrder.orderId}`,
    });
  }

  const queuedEmailIds: string[] = [];
  const internalEmail = await queuePreferenceEmail({
    type: "order.created",
    subject,
    payload: {
      html,
      title: "Nuevo pedido recibido",
      message: `El pedido ${order.order_number} fue creado.`,
      order_number: order.order_number,
      customer_name: order.customer_name,
      customer_phone: order.phone,
      payment_method: order.payment_method,
      payment_status: paymentStatus,
      action_path: "/admin/pedidos?task=new_orders",
    },
    relatedModule: "pedidos",
    relatedId: createdOrder.orderId,
    fallbackRoles: ["technical_owner", "business_owner", "admin"],
    priority: 3,
    idempotencyScope: `order-created-admin:${createdOrder.orderId}`,
  });
  queuedEmailIds.push(...internalEmail.queuedIds);

  if (order.email) {
    const customerEmail = await enqueueEmail({
      toEmail: order.email,
      toName: order.customer_name,
      subject: "Pedido recibido - Car Zone Accesorios",
      templateKey: "customer.order_received",
      payload: {
        html: buildCustomerOrderReceivedHtml(order),
        title: "Hemos recibido tu pedido",
        message:
          order.payment_method === "card"
            ? "Recibimos tu pedido. Nuestro equipo te contactará por WhatsApp para enviarte el enlace de pago seguro."
            : "Hemos recibido tu pedido. Nuestro equipo lo revisará pronto.",
        order_number: order.order_number,
        customer_name: order.customer_name,
        created_at: order.created_at,
        total: formatCurrency(Number(order.total ?? 0)),
        payment_method: paymentMethodLabel(order.payment_method),
        payment_status: paymentStatusLabel(paymentStatus),
        action_path: `/rastreo?codigo=${encodeURIComponent(order.tracking_code ?? "")}`,
        action_label: "Rastrear pedido",
      },
      relatedModule: "pedidos",
      relatedId: createdOrder.orderId,
      priority: 4,
      idempotencyKey: `customer-order-received:${createdOrder.orderId}:${order.email.toLowerCase()}`,
    });
    if (customerEmail.queued && customerEmail.id) queuedEmailIds.push(customerEmail.id);
  }

  await processCriticalEmailQueue({
    queueIds: queuedEmailIds,
    limit: Math.max(5, queuedEmailIds.length),
    route: "/checkout",
    action: "notifications.order_created_immediate_send_failed",
    metadata: {
      order_id: createdOrder.orderId,
      order_number: order.order_number,
      queued_email_count: queuedEmailIds.length,
    },
  });
}

export async function notifyCustomerOfOrderChange(input: {
  orderId: string;
  eventType: "order.status_update" | "order.cancelled" | "payment.confirmed" | "payment.rejected";
  status: string;
  force?: boolean;
}) {
  const admin = getSupabaseAdminClient();
  const { data: order, error } = await admin
    .from("orders")
    .select("id, order_number, tracking_code, email, customer_name, status, email_updates_opt_in, total, payment_method, created_at")
    .eq("id", input.orderId)
    .maybeSingle<Pick<OrderNotificationRow, "id" | "order_number" | "tracking_code" | "email" | "customer_name" | "status" | "email_updates_opt_in" | "total" | "payment_method" | "created_at">>();

  if (error || !order?.email) {
    return { queued: false, reason: error?.message ?? "missing_order_or_email" };
  }

  const shouldSend = input.force || order.email_updates_opt_in === true || input.eventType === "order.cancelled" || input.eventType === "payment.rejected";
  if (!shouldSend) {
    await logNotification({
      eventType: input.eventType,
      orderId: input.orderId,
      recipientEmail: order.email,
      status: "skipped",
      metadata: { reason: "customer_updates_disabled" },
    });
    return { queued: false, reason: "customer_updates_disabled" };
  }

  const label = statusLabel(input.status);
  const subject =
    input.eventType === "order.cancelled"
      ? `Pedido cancelado ${order.order_number} - Car Zone Accesorios`
      : input.eventType === "payment.rejected"
        ? `Pago rechazado ${order.order_number} - Car Zone Accesorios`
        : `Actualización de pedido ${order.order_number} - Car Zone Accesorios`;

  const result = await enqueueEmail({
    toEmail: order.email,
    toName: order.customer_name,
    subject,
    templateKey: input.eventType === "order.cancelled" ? "customer.order_cancelled" : "customer.order_status_update",
    payload: {
      title: input.eventType === "order.cancelled" ? "Tu pedido fue cancelado" : "Actualización de tu pedido",
      message: `El pedido ${order.order_number} ahora está ${label}.`,
      order_number: order.order_number,
      status: label,
      raw_status: input.status,
      event_type: input.eventType,
      customer_name: order.customer_name,
      payment_method: paymentMethodLabel(order.payment_method),
      action_path: `/rastreo?codigo=${encodeURIComponent(order.tracking_code ?? "")}`,
      action_label: "Ver pedido activo",
    },
    relatedModule: "pedidos",
    relatedId: order.id,
    priority: input.eventType === "order.cancelled" || input.eventType === "payment.rejected" ? 2 : 6,
    idempotencyKey: `customer-order-change:${input.eventType}:${order.id}:${input.status}:${order.email.toLowerCase()}`,
  });

  if (result.queued && result.id) {
    const processingResult = await processCriticalEmailQueue({
      queueIds: [result.id],
      limit: 1,
      route: "/admin/pedidos",
      action: "notifications.order_change_immediate_send_failed",
      metadata: {
        order_id: order.id,
        order_number: order.order_number,
        event_type: input.eventType,
        status: input.status,
      },
    });

    if (input.eventType === "order.status_update") {
      await logIncompleteImmediateOrderStatusEmail({
        queueId: result.id,
        orderId: order.id,
        orderNumber: order.order_number,
        recipientEmail: order.email,
        eventType: input.eventType,
        status: input.status,
        processingResult: processingResult as unknown as Record<string, unknown>,
      });
    }
  }

  return { queued: result.queued || result.reason === "duplicate", reason: result.reason };
}



