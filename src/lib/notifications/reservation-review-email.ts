import "server-only";

import { sendTransactionalEmail } from "@/lib/email/email-provider";
import { writeErrorLog } from "@/lib/error-logging";
import { getSupabaseAdminClient } from "@/lib/supabase";

type InternalNotificationRow = {
  id: string;
  order_id: string | null;
  title: string;
  message: string;
  email_attempts: number;
  metadata: Record<string, unknown>;
};

function parseRecipients(value: string | null | undefined) {
  const configured = value
    ?.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  return [...new Set(configured?.length ? configured : ["car.zone.accesorioshn@gmail.com"])];
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getSiteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "https://carzoneaccesorios.vercel.app";
}

function buildHtml(notification: InternalNotificationRow) {
  const orderNumber = String(notification.metadata.order_number ?? "Pedido");
  const customerName = String(notification.metadata.customer_name ?? "Cliente");
  const paymentMethod = String(notification.metadata.payment_method ?? "pendiente");
  const orderStatus = String(notification.metadata.order_status ?? "pendiente");
  const paymentStatus = String(notification.metadata.payment_status ?? "pendiente");

  return `
    <div style="margin:0;background:#f4f4f5;padding:32px;font-family:Arial,sans-serif;color:#080808;">
      <div style="max-width:620px;margin:0 auto;background:#fff;border:1px solid #e4e1d8;border-radius:8px;padding:28px;">
        <p style="margin:0 0 8px;color:#e4252c;font-size:13px;font-weight:700;text-transform:uppercase;">Car Zone Accesorios</p>
        <h1 style="margin:0 0 16px;font-size:24px;">${escapeHtml(notification.title)}</h1>
        <p style="margin:0 0 20px;color:#555;">${escapeHtml(notification.message)}</p>
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          ${row("Pedido", orderNumber)}
          ${row("Cliente", customerName)}
          ${row("Método de pago", paymentMethod)}
          ${row("Estado del pedido", orderStatus)}
          ${row("Estado del pago", paymentStatus)}
        </table>
        <a href="${getSiteUrl()}/admin/pedidos?task=expired_reservations" style="display:inline-block;margin-top:24px;background:#e4252c;color:#fff;text-decoration:none;border-radius:6px;padding:12px 16px;font-weight:700;">Revisar pedidos</a>
      </div>
    </div>
  `;
}

function row(label: string, value: string) {
  return `<tr><td style="padding:10px 0;border-top:1px solid #eee;color:#666;width:42%;">${escapeHtml(label)}</td><td style="padding:10px 0;border-top:1px solid #eee;font-weight:700;">${escapeHtml(value)}</td></tr>`;
}

export async function deliverPendingReservationReviewEmails() {
  const admin = getSupabaseAdminClient();
  const [{ data: settings }, { data: notifications, error }] = await Promise.all([
    admin.from("company_settings").select("notification_emails").order("created_at", { ascending: true }).limit(1).maybeSingle<{ notification_emails: string | null }>(),
    admin
      .from("internal_notifications")
      .select("id, order_id, title, message, email_attempts, metadata")
      .eq("event_type", "reservation.expired_review_required")
      .in("email_status", ["pending", "failed"])
      .lt("email_attempts", 4)
      .order("created_at", { ascending: true })
      .limit(50)
      .returns<InternalNotificationRow[]>(),
  ]);

  if (error) throw new Error(error.message);

  const recipients = parseRecipients(settings?.notification_emails);
  let sent = 0;
  let failed = 0;

  for (const notification of notifications ?? []) {
    const results = await Promise.all(
      recipients.map(async (recipient) => {
        const result = await sendTransactionalEmail({
          to: recipient,
          subject: `Reserva vencida: requiere revisión - ${String(notification.metadata.order_number ?? "pedido")}`,
          html: buildHtml(notification),
          idempotencyKey: `reservation-review-${notification.id}-${recipient}-${notification.email_attempts + 1}`,
          metadata: { event_type: "reservation.expired_review_required", notification_id: notification.id, order_id: notification.order_id },
        });

        await admin.from("notification_logs").insert({
          event_type: "reservation.expired_review_required",
          order_id: notification.order_id,
          recipient_email: recipient,
          status: result.status,
          provider: result.provider,
          provider_message_id: result.providerMessageId,
          error_message: result.errorMessage,
          metadata: { notification_id: notification.id, technical_message: result.technicalMessage },
        });

        return result;
      }),
    );
    const allSent = results.every((result) => result.ok);
    const technicalError = results.map((result) => result.errorMessage).filter(Boolean).join(" | ").slice(0, 1000) || null;

    await admin
      .from("internal_notifications")
      .update({
        email_status: allSent ? "sent" : "failed",
        email_attempts: notification.email_attempts + 1,
        email_error: technicalError,
        emailed_at: allSent ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", notification.id);

    if (allSent) {
      sent += 1;
    } else {
      failed += 1;
      await writeErrorLog({
        route: "/api/cron/check-expired-reservations",
        action: "notifications.reservation_review_email_failed",
        errorMessage: technicalError ?? "Reservation review email failed.",
        metadata: { notification_id: notification.id, order_id: notification.order_id },
      });
    }
  }

  return { sent, failed };
}
