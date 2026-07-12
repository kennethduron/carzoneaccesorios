import "server-only";

import { enqueueEmail, processCriticalEmailQueue, processEmailQueue } from "@/lib/notifications/email-queue";
import { createInternalNotification, createTechnicalNotification, getPreferenceDelivery } from "@/lib/notifications/notification-center";
import { getSupabaseAdminClient } from "@/lib/supabase-admin";
import type { NotificationModule, NotificationSeverity } from "@/types/notifications";
import { isSafeTestAccountEmail } from "@/utils/test-accounts";

type StaffUser = {
  id: string;
  email: string | null;
  full_name: string | null;
  role_id: string | null;
  roles?: { name: string | null } | null;
};

type NotificationEmailInput = {
  type: string;
  subject: string;
  payload: Record<string, unknown>;
  relatedModule: NotificationModule;
  relatedId?: string | null;
  fallbackRoles: string[];
  priority?: number;
  idempotencyScope: string;
};

function hoursAgo(hours: number) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function safeString(value: unknown, fallback = "") {
  return String(value ?? fallback).trim();
}

async function getRoleIds(roleNames: string[]) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.from("roles").select("id, name").in("name", roleNames).returns<Array<{ id: string; name: string }>>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

async function getStaffEmailsForRoles(roleNames: string[], notificationType: string) {
  const admin = getSupabaseAdminClient();
  const roles = await getRoleIds(roleNames);
  const roleIds = roles.map((role) => role.id);

  if (roleIds.length === 0) {
    return [];
  }

  const { data, error } = await admin
    .from("users")
    .select("id, email, full_name, role_id, roles(name)")
    .eq("active", true)
    .in("role_id", roleIds)
    .returns<StaffUser[]>();

  if (error) {
    throw new Error(error.message);
  }

  const users = [
    ...new Map(
      (data ?? [])
        .filter((user) => user.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(user.email))
        .filter((user) => !isSafeTestAccountEmail(user.email!))
        .map((user) => [user.email!.trim().toLowerCase(), user]),
    ).values(),
  ];

  if (users.length === 0) {
    return [];
  }

  const { data: userPreferences, error: preferenceError } = await admin
    .from("notification_user_preferences")
    .select("user_id, email_enabled, frequency")
    .eq("notification_type", notificationType)
    .in(
      "user_id",
      users.map((user) => user.id),
    )
    .returns<Array<{ user_id: string; email_enabled: boolean | null; frequency: string | null }>>();

  if (preferenceError && preferenceError.code !== "42P01") {
    throw new Error(preferenceError.message);
  }

  const preferenceByUserId = new Map((userPreferences ?? []).map((preference) => [preference.user_id, preference]));

  return users.filter((user) => {
    const preference = preferenceByUserId.get(user.id);
    const roleName = Array.isArray(user.roles) ? user.roles[0]?.name : user.roles?.name;
    if (roleName === "bodega" && preference?.email_enabled !== true) return false;
    if (preference?.email_enabled === false) return false;
    if (preference?.frequency === "manual") return false;
    return true;
  });
}

export async function queuePreferenceEmail(input: NotificationEmailInput) {
  const delivery = await getPreferenceDelivery({ type: input.type, fallbackRoles: input.fallbackRoles });

  if (!delivery.emailEnabled) {
    return { queued: 0, skipped: 1, reason: "email_disabled", queuedIds: [] as string[] };
  }

  const recipients = await getStaffEmailsForRoles(delivery.destinationRoles, input.type);
  let queued = 0;
  const queuedIds: string[] = [];

  for (const recipient of recipients) {
    const result = await enqueueEmail({
      toEmail: recipient.email!,
      toName: recipient.full_name,
      subject: input.subject,
      templateKey: input.type,
      payload: input.payload,
      relatedModule: input.relatedModule,
      relatedId: input.relatedId,
      priority: input.priority ?? 5,
      idempotencyKey: `${input.idempotencyScope}:${recipient.email!.trim().toLowerCase()}`,
    });

    if (result.queued) {
      queued += 1;
      if (result.id) queuedIds.push(result.id);
    }
  }

  return { queued, skipped: recipients.length - queued, reason: recipients.length === 0 ? "no_recipients" : null, queuedIds };
}

export async function queuePendingReservationReviewEmails() {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("internal_notifications")
    .select("id, order_id, title, message, metadata")
    .eq("event_type", "reservation.expired_review_required")
    .in("status", ["open", "reviewing"])
    .order("created_at", { ascending: true })
    .limit(50)
    .returns<Array<{ id: string; order_id: string | null; title: string; message: string; metadata: Record<string, unknown> }>>();

  if (error) throw new Error(error.message);

  let queued = 0;
  let skipped = 0;

  for (const notification of data ?? []) {
    const result = await queuePreferenceEmail({
      type: "reservation.expired_review_required",
      subject: `Reserva vencida: requiere revisión - ${safeString(notification.metadata.order_number, "pedido")}`,
      payload: {
        title: notification.title,
        message: notification.message,
        action_path: "/admin/pedidos?task=expired_reservations",
        action_label: "Revisar reservas",
        ...notification.metadata,
      },
      relatedModule: "reservas",
      relatedId: notification.order_id,
      fallbackRoles: ["technical_owner", "business_owner", "admin", "bodega"],
      priority: 2,
      idempotencyScope: `reservation-review:${notification.id}`,
    });
    queued += result.queued;
    skipped += result.skipped;
  }

  return { queued, skipped, notifications: data?.length ?? 0 };
}

export async function checkExpiredReservationsJob() {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("check_expired_inventory_reservations", { max_orders: 100 });
  if (error) throw new Error(error.message);

  const email = await queuePendingReservationReviewEmails();
  return { reviewRequiredOrders: Number(data ?? 0), email };
}

type CreditReminderRow = {
  id: string;
  customer_id: string;
  order_id: string;
  balance_due: unknown;
  due_date: string;
  status: "open" | "partial" | "overdue";
  customers: { contact_name: string | null; business_name: string | null; email: string | null } | null;
  orders: { order_number: string | null } | null;
};

function tegucigalpaDateOffset(days: number) {
  const target = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Tegucigalpa",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(target);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export async function checkCommercialCreditRemindersJob() {
  const admin = getSupabaseAdminClient();
  const { data: overdueCount, error: overdueError } = await admin.rpc("mark_overdue_accounts_receivable", { max_rows: 500 });
  if (overdueError) throw new Error(overdueError.message);

  const reminderDates = [tegucigalpaDateOffset(7), tegucigalpaDateOffset(3), tegucigalpaDateOffset(1), tegucigalpaDateOffset(0)];
  const { data, error } = await admin
    .from("accounts_receivable")
    .select("id, customer_id, order_id, balance_due, due_date, status, customers(contact_name, business_name, email), orders(order_number)")
    .in("status", ["open", "partial", "overdue"])
    .gt("balance_due", 0)
    .or(`due_date.in.(${reminderDates.join(",")}),status.eq.overdue`)
    .limit(500)
    .returns<CreditReminderRow[]>();

  if (error) throw new Error(error.message);

  let notifications = 0;
  let customerEmailsQueued = 0;
  let customerEmailsSkipped = 0;
  const today = tegucigalpaDateOffset(0);

  for (const receivable of data ?? []) {
    const days = Math.round(
      (new Date(`${receivable.due_date}T12:00:00-06:00`).getTime() - new Date(`${today}T12:00:00-06:00`).getTime()) /
        (24 * 60 * 60 * 1000),
    );
    const customerName = receivable.customers?.business_name || receivable.customers?.contact_name || "Cliente";
    const customerEmail = receivable.customers?.email ?? null;
    const orderNumber = receivable.orders?.order_number || "pedido";
    const type =
      days < 0 || (receivable.status === "overdue" && days !== 0)
        ? "credit.overdue"
        : days === 0
          ? "credit.due_today"
        : days === 7
          ? "credit.due_7_days"
          : days === 3
            ? "credit.due_3_days"
            : "credit.due_1_day";
    const title =
      type === "credit.overdue"
        ? "Crédito comercial vencido"
        : type === "credit.due_today"
          ? "Crédito vence hoy"
        : type === "credit.due_7_days"
          ? "Crédito vence en 7 días"
          : type === "credit.due_3_days"
            ? "Crédito vence en 3 días"
            : "Crédito vence mañana";
    const created = await createInternalNotification({
      type,
      title,
      message: `${customerName}, pedido ${orderNumber}, saldo L ${Number(receivable.balance_due ?? 0).toFixed(2)}.`,
      severity: type === "credit.overdue" ? "critical" : days <= 3 ? "warning" : "info",
      module: "pagos",
      customerId: receivable.customer_id,
      orderId: receivable.order_id,
      metadata: {
        receivable_id: receivable.id,
        due_date: receivable.due_date,
        balance_due: Number(receivable.balance_due ?? 0),
        days_remaining: days,
        action_path: "/admin/cuentas-por-cobrar",
      },
      dedupeKey: type === "credit.due_today" ? `${type}:${receivable.id}:${receivable.due_date}` : `${type}:${receivable.id}`,
    });
    if (created.created) notifications += 1;

    if (type === "credit.due_today") {
      const result = customerEmail
        ? await enqueueEmail({
            toEmail: customerEmail,
            toName: customerName,
            subject: `Tu crédito comercial vence hoy - ${orderNumber}`,
            templateKey: "commercial_credit.due_today",
            payload: {
              title: "Tu crédito comercial vence hoy",
              message: `Hola ${customerName}, te recordamos que tu cuenta de crédito comercial del pedido ${orderNumber} vence hoy. Puedes comunicarte con Car Zone Accesorios para coordinar tu pago.`,
              customer_name: customerName,
              order_number: orderNumber,
              balance_due: `L ${Number(receivable.balance_due ?? 0).toFixed(2)}`,
              due_at: receivable.due_date,
              action_path: "/cuenta",
              action_label: "Ver mi cuenta",
            },
            relatedModule: "pagos",
            relatedId: receivable.id,
            priority: 2,
            scheduledAt: `${receivable.due_date}T08:00:00-06:00`,
            idempotencyKey: `commercial_credit_due_today:${receivable.id}:${receivable.due_date}`,
          })
        : { queued: false, reason: "missing_email" };

      if (result.queued) {
        customerEmailsQueued += 1;
      } else {
        customerEmailsSkipped += 1;
      }
    }
  }

  return {
    overdueMarked: Number(overdueCount ?? 0),
    scanned: data?.length ?? 0,
    notifications,
    customerEmailsQueued,
    customerEmailsSkipped,
  };
}

export async function checkOverdueFollowupsJob() {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("crm_followups")
    .select("id, customer_id, assigned_user_id, title, interaction_type, next_action, due_at, priority, status")
    .eq("status", "pending")
    .not("due_at", "is", null)
    .lt("due_at", new Date().toISOString())
    .order("due_at", { ascending: true })
    .limit(100)
    .returns<Array<Record<string, unknown>>>();

  if (error) throw new Error(error.message);

  let notifications = 0;
  let emailsQueued = 0;
  const queuedEmailIds: string[] = [];

  for (const followup of data ?? []) {
    const followupId = safeString(followup.id);
    const title = safeString(followup.title, "Seguimiento CRM vencido");
    const assignedUserId = safeString(followup.assigned_user_id) || null;
    const created = await createInternalNotification({
      type: "crm.followup_overdue",
      title: "Seguimiento CRM vencido",
      message: `${title} requiere atención.`,
      severity: "warning",
      module: "CRM",
      userId: assignedUserId,
      customerId: safeString(followup.customer_id) || null,
      metadata: {
        followup_id: followupId,
        due_at: followup.due_at,
        next_action: followup.next_action,
        assigned_user_id: assignedUserId,
      },
      dedupeKey: `crm.followup_overdue:${followupId}`,
    });
    if (created.created) notifications += 1;

    const email = await queuePreferenceEmail({
      type: "crm.followup_overdue",
      subject: "Seguimiento CRM vencido - Car Zone Accesorios",
      payload: {
        title: "Seguimiento CRM vencido",
        message: `${title} requiere atención.`,
        due_at: followup.due_at,
        action_path: "/admin/crm?task=overdue",
        action_label: "Abrir CRM",
      },
      relatedModule: "CRM",
      relatedId: followupId,
      fallbackRoles: assignedUserId ? ["business_owner", "admin"] : ["business_owner", "admin", "vendedor", "soporte"],
      idempotencyScope: `crm-followup-overdue:${followupId}`,
    });
    emailsQueued += email.queued;
    queuedEmailIds.push(...email.queuedIds);
  }

  await processCriticalEmailQueue({
    queueIds: queuedEmailIds,
    limit: Math.max(5, queuedEmailIds.length),
    route: "/api/cron/check-overdue-followups",
    action: "notifications.crm_followup_immediate_send_failed",
    metadata: {
      queued_email_count: queuedEmailIds.length,
    },
  });

  return { scanned: data?.length ?? 0, notifications, emailsQueued };
}

export async function checkLowStockJob() {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("products")
    .select("id, sku, name, stock, available_stock, min_stock, active, status")
    .eq("active", true)
    .eq("status", "active")
    .limit(250)
    .returns<Array<Record<string, unknown>>>();

  if (error) throw new Error(error.message);

  const lowStock = (data ?? []).filter((product) => {
    const available = Number(product.available_stock ?? product.stock ?? 0);
    const minimum = Number(product.min_stock ?? 0);
    return available <= minimum;
  });
  let notifications = 0;

  for (const product of lowStock) {
    const available = Number(product.available_stock ?? product.stock ?? 0);
    const minimum = Number(product.min_stock ?? 0);
    const criticalLow = minimum > 0 && available > 0 && available <= Math.max(1, Math.floor(minimum / 2));
    const type = available <= 0 ? "inventory.out_of_stock" : criticalLow ? "inventory.critical_low_stock" : "inventory.low_stock";
    const title = available <= 0 ? "Producto agotado" : criticalLow ? "Producto con existencias críticamente bajas" : "Producto con pocas existencias";
    const severity: NotificationSeverity = available <= 0 || criticalLow ? "critical" : "warning";
    const productId = safeString(product.id);
    const created = await createInternalNotification({
      type,
      title,
      message: `${safeString(product.name, "Producto")} tiene ${available} unidades disponibles.`,
      severity,
      module: "inventario",
      productId,
      metadata: {
        sku: product.sku,
        product_name: product.name,
        available_stock: available,
        min_stock: product.min_stock,
      },
      dedupeKey: `${type}:${productId}`,
    });
    if (created.created) notifications += 1;

    if (created.created && (available <= 0 || criticalLow)) {
      await queuePreferenceEmail({
        type,
        subject: `${title} - Car Zone Accesorios`,
        payload: {
          title,
          message: `${safeString(product.name, "Producto")} tiene ${available} unidades disponibles.`,
          product_name: product.name,
          available_stock: available,
          min_stock: product.min_stock,
          action_path: "/admin/inventario",
          action_label: "Revisar inventario",
        },
        relatedModule: "inventario",
        relatedId: productId,
        fallbackRoles: ["business_owner", "admin", "bodega"],
        priority: available <= 0 ? 2 : 4,
        idempotencyScope: `${type}:${productId}`,
      });
    }
  }

  return { scanned: data?.length ?? 0, lowStock: lowStock.length, notifications };
}

export async function checkPendingWholesaleRequestsJob() {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("customers")
    .select("id, contact_name, business_name, email, phone, city, created_at, wholesale_status")
    .eq("wholesale_status", "pending")
    .lte("created_at", hoursAgo(24))
    .order("created_at", { ascending: true })
    .limit(100)
    .returns<Array<Record<string, unknown>>>();

  if (error) throw new Error(error.message);

  let notifications = 0;
  let emailsQueued = 0;

  for (const customer of data ?? []) {
    const customerId = safeString(customer.id);
    const name = safeString(customer.business_name) || safeString(customer.contact_name, "Cliente mayorista");
    const created = await createInternalNotification({
      type: "wholesale.request_pending_24h",
      title: "Solicitud mayorista pendiente más de 24h",
      message: `${name} sigue pendiente de revisión mayorista.`,
      severity: "warning",
      module: "mayoristas",
      customerId,
      metadata: {
        customer_name: name,
        customer_email: customer.email,
        customer_phone: customer.phone,
        city: customer.city,
        created_at: customer.created_at,
      },
      dedupeKey: `wholesale.request_pending_24h:${customerId}`,
    });
    if (created.created) notifications += 1;

    const email = await queuePreferenceEmail({
      type: "wholesale.request_pending_24h",
      subject: "Solicitud mayorista pendiente - Car Zone Accesorios",
      payload: {
        title: "Solicitud mayorista pendiente",
        message: `${name} lleva más de 24 horas esperando revisión.`,
        customer_name: name,
        customer_email: customer.email,
        customer_phone: customer.phone,
        created_at: customer.created_at,
        action_path: "/admin/clientes-mayoristas?status=pending",
        action_label: "Revisar mayoristas",
      },
      relatedModule: "mayoristas",
      relatedId: customerId,
      fallbackRoles: ["business_owner", "admin"],
      idempotencyScope: `wholesale-pending-24h:${customerId}`,
    });
    emailsQueued += email.queued;
  }

  return { scanned: data?.length ?? 0, notifications, emailsQueued };
}

export async function checkOverdueTasksJob() {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("crm_followups")
    .select("id, customer_id, assigned_user_id, title, next_action, due_at, interaction_type, status")
    .eq("status", "pending")
    .not("due_at", "is", null)
    .lt("due_at", new Date().toISOString())
    .or("interaction_type.ilike.%tarea%,title.ilike.%tarea%")
    .order("due_at", { ascending: true })
    .limit(100)
    .returns<Array<Record<string, unknown>>>();

  if (error) throw new Error(error.message);

  let notifications = 0;

  for (const task of data ?? []) {
    const taskId = safeString(task.id);
    const created = await createInternalNotification({
      type: "crm.task_overdue",
      title: "Tarea vencida",
      message: `${safeString(task.title, "Tarea")} requiere seguimiento.`,
      severity: "warning",
      module: "CRM",
      userId: safeString(task.assigned_user_id) || null,
      customerId: safeString(task.customer_id) || null,
      metadata: {
        task_id: taskId,
        due_at: task.due_at,
        next_action: task.next_action,
      },
      dedupeKey: `crm.task_overdue:${taskId}`,
    });
    if (created.created) notifications += 1;
  }

  return { scanned: data?.length ?? 0, notifications };
}

export async function processEmailQueueJob() {
  return processEmailQueue({ limit: 25 });
}

export async function createBackupJob() {
  const admin = getSupabaseAdminClient();
  const { data: backupRun, error: backupRunError } = await admin
    .from("backup_runs")
    .select("id, status, started_at, finished_at, file_name")
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle<Record<string, unknown>>();
  const backupRunsMissing =
    backupRunError?.code === "42P01" || backupRunError?.message.toLowerCase().includes("backup_runs");
  const { data, error } = backupRunError && !backupRunsMissing
    ? { data: null, error: backupRunError }
    : await admin
    .from("backup_logs")
    .select("id, status, created_at, finished_at, notes")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<Record<string, unknown>>();

  if (error) {
    await createTechnicalNotification({
      type: "system.backup_failed",
      title: "No se pudieron verificar las copias de seguridad",
      message: "La tarea diaria no pudo leer el registro de copias de seguridad.",
      severity: "critical",
      metadata: { error: error.message },
      dedupeKey: `system.backup_failed:backup_logs_unreadable:${new Date().toISOString().slice(0, 10)}`,
    });
    return { verified: false, status: "failed", message: "backup_logs unreadable" };
  }

  const latestBackup = backupRun ?? data;
  const status = safeString(latestBackup?.status, "missing");
  const backupDate = latestBackup?.started_at ?? latestBackup?.created_at;
  const stale = !backupDate || new Date(String(backupDate)).getTime() < Date.now() - 36 * 60 * 60 * 1000;
  const failed = status === "failed" || status === "error" || stale;

  if (failed) {
    await createTechnicalNotification({
      type: "system.backup_failed",
      title: "Backup requiere revisión",
      message: stale ? "No hay una copia de seguridad reciente registrada en las últimas 36 horas." : "La última copia de seguridad registrada falló.",
      severity: "critical",
      metadata: { latest_backup: latestBackup ?? null, stale },
      dedupeKey: `system.backup_failed:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  return { verified: true, latestBackupStatus: status, stale, alertCreated: failed };
}

export async function systemHealthCheckJob() {
  const admin = getSupabaseAdminClient();
  const [{ count: failedEmails }, { data: failedCron }, { count: criticalErrors }] = await Promise.all([
    admin.from("email_queue").select("id", { count: "exact", head: true }).eq("status", "failed"),
    admin
      .from("operational_cron_runs")
      .select("job_name, status, created_at, error_message")
      .eq("status", "failed")
      .gte("created_at", hoursAgo(24))
      .order("created_at", { ascending: false })
      .limit(5)
      .returns<Array<Record<string, unknown>>>(),
    admin.from("error_logs").select("id", { count: "exact", head: true }).gte("created_at", hoursAgo(24)),
  ]);

  if ((failedEmails ?? 0) > 0) {
    await createTechnicalNotification({
      type: "system.email_failed",
      title: "Cola de correos con fallos",
      message: `Hay ${failedEmails} correos fallidos en la cola.`,
      severity: "critical",
      metadata: { failed_emails: failedEmails },
      dedupeKey: `system.email_failed:queue:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  for (const cron of failedCron ?? []) {
    await createTechnicalNotification({
      type: "system.cron_failed",
      title: "Cron fallido",
      message: `El cron ${safeString(cron.job_name, "sin nombre")} falló en las últimas 24 horas.`,
      severity: "critical",
      metadata: cron,
      dedupeKey: `system.cron_failed:${safeString(cron.job_name)}:${new Date(String(cron.created_at)).toISOString().slice(0, 13)}`,
    });
  }

  if ((criticalErrors ?? 0) > 0) {
    await createTechnicalNotification({
      type: "system.critical_error",
      title: "Errores operativos recientes",
      message: `Se registraron ${criticalErrors} errores operativos en las últimas 24 horas.`,
      severity: "warning",
      metadata: { error_count_24h: criticalErrors },
      dedupeKey: `system.critical_error:error_logs:${new Date().toISOString().slice(0, 10)}`,
    });
  }

  return {
    failedEmails: failedEmails ?? 0,
    failedCron: failedCron?.length ?? 0,
    operationalErrors24h: criticalErrors ?? 0,
  };
}
