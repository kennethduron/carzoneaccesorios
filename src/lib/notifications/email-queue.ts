import "server-only";

import { getEmailProviderStatus, sendTransactionalEmail } from "@/lib/email/email-provider";
import { createTechnicalNotification } from "@/lib/notifications/notification-center";
import { getSupabaseAdminClient } from "@/lib/supabase";
import type { EmailQueueItem, NotificationModule } from "@/types/notifications";

type EnqueueEmailInput = {
  toEmail: string;
  toName?: string | null;
  subject: string;
  templateKey: string;
  payload?: Record<string, unknown>;
  relatedModule?: NotificationModule;
  relatedId?: string | null;
  priority?: number;
  scheduledAt?: string;
  maxAttempts?: number;
  idempotencyKey?: string | null;
};

type ProcessEmailQueueOptions = {
  limit?: number;
};

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function isValidEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function siteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") || "https://carzoneaccesorios.vercel.app";
}

function formatDate(value: unknown) {
  if (!value) return "Sin fecha";

  return new Intl.DateTimeFormat("es-HN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Tegucigalpa",
  }).format(new Date(String(value)));
}

function row(label: string, value: unknown) {
  if (value === null || value === undefined || value === "") return "";

  return `<tr><td style="padding:10px 0;border-top:1px solid #eee;color:#666;width:38%;">${escapeHtml(label)}</td><td style="padding:10px 0;border-top:1px solid #eee;font-weight:700;">${escapeHtml(value)}</td></tr>`;
}

export function renderEmailTemplate(templateKey: string, payload: Record<string, unknown>) {
  if (typeof payload.html === "string" && payload.html.trim()) {
    return payload.html;
  }

  const title = String(payload.title ?? payload.subject ?? "Notificacion de Car Zone Accesorios");
  const intro = String(payload.message ?? payload.intro ?? "Hay una actualizacion importante.");
  const actionPath = String(payload.action_path ?? "/admin");
  const actionLabel = String(payload.action_label ?? "Abrir panel");
  const rows = [
    row("Pedido", payload.order_number),
    row("Cliente", payload.customer_name),
    row("Correo", payload.customer_email),
    row("Telefono", payload.customer_phone),
    row("Metodo de pago", payload.payment_method),
    row("Estado", payload.status ?? payload.payment_status),
    row("Producto", payload.product_name),
    row("Stock disponible", payload.available_stock),
    row("Stock minimo", payload.min_stock),
    row("Fecha", payload.created_at ? formatDate(payload.created_at) : payload.due_at ? formatDate(payload.due_at) : null),
  ].join("");

  const templateLabel = templateKey.replaceAll(".", " ");

  return `
    <div style="margin:0;background:#f4f4f5;padding:32px;font-family:Arial,sans-serif;color:#080808;">
      <div style="max-width:640px;margin:0 auto;background:#fff;border:1px solid #e4e1d8;border-radius:8px;padding:28px;">
        <p style="margin:0 0 8px;color:#e4252c;font-size:13px;font-weight:700;text-transform:uppercase;">Car Zone Accesorios</p>
        <h1 style="margin:0 0 16px;font-size:24px;line-height:1.25;">${escapeHtml(title)}</h1>
        <p style="margin:0 0 20px;color:#555;line-height:1.6;">${escapeHtml(intro)}</p>
        ${rows ? `<table style="width:100%;border-collapse:collapse;font-size:14px;">${rows}</table>` : ""}
        ${
          actionPath
            ? `<div style="margin-top:24px;"><a href="${siteUrl()}${escapeHtml(actionPath)}" style="display:inline-block;background:#e4252c;color:#fff;text-decoration:none;border-radius:6px;padding:12px 16px;font-weight:700;">${escapeHtml(actionLabel)}</a></div>`
            : ""
        }
        <p style="margin:24px 0 0;color:#777;font-size:12px;">Tipo: ${escapeHtml(templateLabel)}. Este correo fue generado desde la cola transaccional del sistema.</p>
      </div>
    </div>
  `;
}

export async function enqueueEmail(input: EnqueueEmailInput) {
  const toEmail = normalizeEmail(input.toEmail);
  if (!isValidEmail(toEmail)) {
    return { queued: false, id: null as string | null, reason: "invalid_email" };
  }

  const admin = getSupabaseAdminClient();
  if (input.idempotencyKey) {
    const { data: existing, error: existingError } = await admin
      .from("email_queue")
      .select("id")
      .eq("idempotency_key", input.idempotencyKey)
      .limit(1)
      .maybeSingle<{ id: string }>();

    if (existingError) {
      throw new Error(existingError.message);
    }

    if (existing?.id) {
      return { queued: false, id: existing.id, reason: "duplicate" };
    }
  }

  const { data, error } = await admin
    .from("email_queue")
    .insert({
      to_email: toEmail,
      to_name: input.toName ?? null,
      subject: input.subject,
      template_key: input.templateKey,
      payload: input.payload ?? {},
      status: "pending",
      scheduled_at: input.scheduledAt ?? new Date().toISOString(),
      related_module: input.relatedModule ?? null,
      related_id: input.relatedId ?? null,
      priority: input.priority ?? 5,
      max_attempts: input.maxAttempts ?? 4,
      idempotency_key: input.idempotencyKey ?? null,
    })
    .select("id")
    .single<{ id: string }>();

  if (error) {
    throw new Error(error.message);
  }

  await admin.from("audit_logs").insert({
    actor_role: "system",
    table_name: "email_queue",
    record_id: data.id,
    action: "email.queued",
    new_data: {
      template_key: input.templateKey,
      related_module: input.relatedModule ?? null,
      related_id: input.relatedId ?? null,
      priority: input.priority ?? 5,
    },
  });

  return { queued: true, id: data.id, reason: null as string | null };
}

function nextRetryAt(attempts: number) {
  const minutes = Math.min(60, Math.max(5, attempts * 10));
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function claimExpiresAt() {
  return new Date(Date.now() + 15 * 60 * 1000).toISOString();
}

export async function processEmailQueue(options: ProcessEmailQueueOptions = {}) {
  const providerStatus = getEmailProviderStatus();
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 50);

  if (!providerStatus.configured) {
    return {
      ok: true,
      provider: providerStatus.provider,
      paused: true,
      message: "Proveedor de correo no configurado; la cola queda pendiente.",
      processed: 0,
      sent: 0,
      failed: 0,
      retrying: 0,
    };
  }

  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("email_queue")
    .select("*")
    .in("status", ["pending", "retrying"])
    .lte("scheduled_at", new Date().toISOString())
    .order("priority", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(limit)
    .returns<EmailQueueItem[]>();

  if (error) {
    throw new Error(error.message);
  }

  let sent = 0;
  let failed = 0;
  let retrying = 0;

  for (const item of data ?? []) {
    const claimCutoff = new Date().toISOString();
    const { data: claim, error: claimError } = await admin
      .from("email_queue")
      .update({
        status: "retrying",
        scheduled_at: claimExpiresAt(),
        updated_at: claimCutoff,
      })
      .eq("id", item.id)
      .in("status", ["pending", "retrying"])
      .lte("scheduled_at", claimCutoff)
      .select("id")
      .maybeSingle<{ id: string }>();

    if (claimError || !claim?.id) {
      continue;
    }

    const html = renderEmailTemplate(item.template_key, item.payload ?? {});
    const result = await sendTransactionalEmail({
      to: item.to_email,
      subject: item.subject,
      html,
      idempotencyKey: item.idempotency_key ?? item.id,
      metadata: {
        queue_id: item.id,
        template_key: item.template_key,
        related_module: item.related_module,
        related_id: item.related_id,
      },
    });
    const nextAttempts = item.attempts + 1;
    const terminalFailed = !result.ok && nextAttempts >= item.max_attempts;
    const nextStatus = result.ok ? "sent" : terminalFailed ? "failed" : "retrying";
    const now = new Date().toISOString();

    await admin
      .from("email_queue")
      .update({
        status: nextStatus,
        attempts: nextAttempts,
        last_error: result.errorMessage ?? result.technicalMessage ?? null,
        sent_at: result.ok ? now : null,
        scheduled_at: result.ok ? item.scheduled_at : nextRetryAt(nextAttempts),
        provider: result.provider,
        provider_message_id: result.providerMessageId,
        updated_at: now,
      })
      .eq("id", item.id);

    await admin.from("notification_logs").insert({
      event_type: item.template_key,
      order_id: item.related_module === "pedidos" || item.related_module === "reservas" ? item.related_id : null,
      recipient_email: item.to_email,
      status: result.status,
      provider: result.provider,
      provider_message_id: result.providerMessageId,
      error_message: result.errorMessage,
      metadata: {
        queue_id: item.id,
        related_module: item.related_module,
        related_id: item.related_id,
        technical_message: result.technicalMessage ?? null,
      },
    });

    await admin.from("audit_logs").insert({
      actor_role: "system",
      table_name: "email_queue",
      record_id: item.id,
      action: result.ok ? "email.sent" : terminalFailed ? "email.failed" : "email.retry_scheduled",
      new_data: {
        status: nextStatus,
        attempts: nextAttempts,
        provider: result.provider,
        related_module: item.related_module,
        related_id: item.related_id,
      },
    });

    if (result.ok) {
      sent += 1;
    } else if (terminalFailed) {
      failed += 1;
      await createTechnicalNotification({
        type: "system.email_failed",
        title: "Correo fallido",
        message: `El correo ${item.template_key} no pudo enviarse despues de ${nextAttempts} intentos.`,
        severity: "critical",
        metadata: { queue_id: item.id, to_email: item.to_email, error: result.errorMessage ?? result.technicalMessage },
        dedupeKey: `system.email_failed:${item.id}`,
      });
    } else {
      retrying += 1;
    }
  }

  return {
    ok: true,
    provider: providerStatus.provider,
    paused: false,
    processed: data?.length ?? 0,
    sent,
    failed,
    retrying,
  };
}
