import { getSupabaseAdminClient } from "@/lib/supabase";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import { getEmailProviderStatus, type EmailProviderName } from "@/lib/email/email-provider";

export type UsageMetric = {
  key: string;
  label: string;
  value: number;
  helper: string;
};

export type LogRetentionMetric = {
  table: "audit_logs" | "error_logs" | "notification_logs";
  label: string;
  total: number;
  olderThan90Days: number;
};

export type OperationalErrorLog = {
  id: string;
  created_at: string;
  module: string | null;
  action: string;
  route: string | null;
  user_id: string | null;
  user_email: string | null;
  category: string | null;
  severity: "info" | "warning" | "error" | "critical" | null;
  status: "open" | "reviewing" | "resolved" | "ignored" | null;
  admin_reason: string | null;
  customer_message: string | null;
  recommendation: string | null;
  error_code: string | null;
  http_status: number | null;
  metadata: Record<string, unknown>;
};

export type StorageReferenceMetric = {
  label: string;
  value: number;
  helper: string;
};

export type UsageHealthStatus = "verde" | "amarillo" | "naranja" | "rojo";

export type TableUsageMetric = {
  tableName: string;
  rowEstimate: number;
  tableSizeBytes: number;
  indexSizeBytes: number;
  totalSizeBytes: number;
};

export type BackupChecklistItem = {
  area: string;
  status: "configured" | "manual" | "pending";
  cadence: string;
  recommendation: string;
};

export type AdminUsageOverview = {
  databaseSizeBytes: number;
  healthStatus: UsageHealthStatus;
  technicalRecommendation: string;
  heaviestTables: TableUsageMetric[];
  metrics: UsageMetric[];
  logs: LogRetentionMetric[];
  storageReferences: StorageReferenceMetric[];
  backupChecklist: BackupChecklistItem[];
  criticalTables: string[];
  expiredReservationCount: number;
  reservedOrderCount: number;
  latestBackupCheck: {
    checked_at: string;
    plan_name: string;
    status: "ok" | "manual_review" | "risk" | "failed";
    notes: string | null;
  } | null;
  cronSecretConfigured: boolean;
  latestCronRuns: CronRunMetric[];
  recentErrors: OperationalErrorLog[];
  rateLimitRows: number;
  notificationStatus: {
    provider: EmailProviderName;
    configured: boolean;
    resendConfigured: boolean;
    brevoConfigured: boolean;
    sent24h: number;
    failed24h: number;
    skipped24h: number;
  };
  retentionDays: number;
};

export type CronRunMetric = {
  job_name: string;
  status: "success" | "failed" | "unauthorized";
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  result: Record<string, unknown>;
  error_message: string | null;
};

type CountTable =
  | "orders"
  | "invoices"
  | "products"
  | "customers"
  | "audit_logs"
  | "error_logs"
  | "notification_logs"
  | "product_images"
  | "payments"
  | "inventory_reservations";

type BackupCheckRow = {
  checked_at: string;
  plan_name: string;
  status: "ok" | "manual_review" | "risk" | "failed";
  notes: string | null;
};

type CleanupRow = {
  table_name: string;
  deleted_count: number;
};

type MonitoringSnapshotRow = {
  database_size_bytes: number;
  table_name: string;
  row_estimate: number;
  table_size_bytes: number;
  index_size_bytes: number;
  total_size_bytes: number;
};

type NotificationStatusRow = {
  status: "sent" | "failed" | "skipped";
};

type CronRunRow = CronRunMetric;
type OperationalErrorLogRow = OperationalErrorLog;

function getHealthStatus(databaseSizeBytes: number): UsageHealthStatus {
  const databaseSizeMb = databaseSizeBytes / 1024 / 1024;

  if (databaseSizeMb >= 450) {
    return "rojo";
  }

  if (databaseSizeMb >= 350) {
    return "naranja";
  }

  if (databaseSizeMb >= 250) {
    return "amarillo";
  }

  return "verde";
}

function getTechnicalRecommendation(status: UsageHealthStatus) {
  if (status === "rojo") {
    return "La base de datos ya esta en zona roja. Se debe pasar a Supabase Pro y revisar logs/indices inmediatamente.";
  }

  if (status === "naranja") {
    return "Se recomienda pasar a Supabase Pro antes de llegar a 400 MB y limpiar logs antiguos.";
  }

  if (status === "amarillo") {
    return "El uso esta creciendo. Revisa tablas pesadas mensualmente y prepara upgrade antes de 350-400 MB.";
  }

  return "Uso saludable para etapa inicial. Mantener archivos fuera de Postgres y limpieza periodica de logs.";
}

async function getMonitoringSnapshot() {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("get_system_monitoring_snapshot").returns<MonitoringSnapshotRow[]>();

  if (error) {
    if (error.code === "42883" || error.message.toLowerCase().includes("get_system_monitoring_snapshot")) {
      return { databaseSizeBytes: 0, heaviestTables: [] };
    }

    throw new Error(error.message);
  }

  const rows = Array.isArray(data) ? (data as MonitoringSnapshotRow[]) : [];

  return {
    databaseSizeBytes: Number(rows[0]?.database_size_bytes ?? 0),
    heaviestTables: rows.map((row) => ({
      tableName: row.table_name,
      rowEstimate: Number(row.row_estimate ?? 0),
      tableSizeBytes: Number(row.table_size_bytes ?? 0),
      indexSizeBytes: Number(row.index_size_bytes ?? 0),
      totalSizeBytes: Number(row.total_size_bytes ?? 0),
    })),
  };
}

async function countRows(table: CountTable) {
  const admin = getSupabaseAdminClient();
  const { count, error } = await admin.from(table).select("id", { count: "estimated", head: true });

  if (error) {
    throw new Error(error.message);
  }

  return count ?? 0;
}

async function countRowsOlderThan(table: "audit_logs" | "error_logs" | "notification_logs", cutoff: string) {
  const admin = getSupabaseAdminClient();
  const { count, error } = await admin.from(table).select("id", { count: "estimated", head: true }).lt("created_at", cutoff);

  if (error) {
    throw new Error(error.message);
  }

  return count ?? 0;
}

async function countTransferReceipts() {
  const admin = getSupabaseAdminClient();
  const { count, error } = await admin
    .from("payments")
    .select("id", { count: "estimated", head: true })
    .or("transfer_receipt_url.not.is.null,transfer_receipt_public_id.not.is.null");

  if (error) {
    throw new Error(error.message);
  }

  return count ?? 0;
}

async function countInventoryReservations(status: "reserved" | "expired", expiredOnly = false) {
  const admin = getSupabaseAdminClient();
  let query = admin.from("inventory_reservations").select("id", { count: "estimated", head: true }).eq("status", status);

  if (expiredOnly) {
    query = query.lte("expires_at", new Date().toISOString());
  }

  const { count, error } = await query;

  if (error) {
    if (error.code === "42P01" || error.message.toLowerCase().includes("inventory_reservations")) {
      return 0;
    }

    throw new Error(error.message);
  }

  return count ?? 0;
}

async function getLatestBackupCheck() {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("operational_backup_checks")
    .select("checked_at, plan_name, status, notes")
    .order("checked_at", { ascending: false })
    .limit(1)
    .maybeSingle<BackupCheckRow>();

  if (error) {
    if (error.code === "42P01" || error.message.toLowerCase().includes("operational_backup_checks")) {
      return null;
    }

    throw new Error(error.message);
  }

  return data ?? null;
}

async function countRateLimitRows() {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin.rpc("count_rate_limits");

  if (error) {
    if (error.code === "42883" || error.message.toLowerCase().includes("count_rate_limits")) {
      return 0;
    }

    throw new Error(error.message);
  }

  return Number(data ?? 0);
}

async function getNotificationStatusSince(cutoff: string) {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("notification_logs")
    .select("status")
    .gte("created_at", cutoff)
    .returns<NotificationStatusRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []).reduce(
    (summary, row) => {
      if (row.status === "sent") {
        summary.sent24h += 1;
      } else if (row.status === "failed") {
        summary.failed24h += 1;
      } else if (row.status === "skipped") {
        summary.skipped24h += 1;
      }

      return summary;
    },
    { sent24h: 0, failed24h: 0, skipped24h: 0 },
  );
}

async function getLatestCronRuns() {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("operational_cron_runs")
    .select("job_name, status, started_at, finished_at, duration_ms, result, error_message")
    .order("created_at", { ascending: false })
    .limit(6)
    .returns<CronRunRow[]>();

  if (error) {
    if (error.code === "42P01" || error.message.toLowerCase().includes("operational_cron_runs")) {
      return [];
    }

    throw new Error(error.message);
  }

  return data ?? [];
}

async function getRecentOperationalErrors() {
  const admin = getSupabaseAdminClient();
  const { data, error } = await admin
    .from("error_logs")
    .select(
      "id, created_at, module, action, route, user_id, user_email, category, severity, status, admin_reason, customer_message, recommendation, error_code, http_status, metadata",
    )
    .order("created_at", { ascending: false })
    .limit(8)
    .returns<OperationalErrorLogRow[]>();

  if (error) {
    if (error.code === "42703" || error.message.toLowerCase().includes("module")) {
      return [];
    }

    throw new Error(error.message);
  }

  return data ?? [];
}

function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

export async function getAdminUsageOverview(): Promise<AdminUsageOverview> {
  const retentionDays = 90;
  const cutoff = daysAgo(retentionDays);
  const last24h = daysAgo(1);
  const emailProvider = getEmailProviderStatus();

  const [
    monitoring,
    orders,
    invoices,
    products,
    customers,
    auditLogs,
    errorLogs,
    notificationLogs,
    oldAuditLogs,
    oldErrorLogs,
    oldNotificationLogs,
    productImages,
    transferReceipts,
    expiredReservationCount,
    reservedOrderCount,
    latestBackupCheck,
    rateLimitRows,
    notificationCounts,
    latestCronRuns,
    recentErrors,
  ] = await Promise.all([
    getMonitoringSnapshot(),
    countRows("orders"),
    countRows("invoices"),
    countRows("products"),
    countRows("customers"),
    countRows("audit_logs"),
    countRows("error_logs"),
    countRows("notification_logs"),
    countRowsOlderThan("audit_logs", cutoff),
    countRowsOlderThan("error_logs", cutoff),
    countRowsOlderThan("notification_logs", cutoff),
    countRows("product_images"),
    countTransferReceipts(),
    countInventoryReservations("reserved", true),
    countInventoryReservations("reserved"),
    getLatestBackupCheck(),
    countRateLimitRows(),
    getNotificationStatusSince(last24h),
    getLatestCronRuns(),
    getRecentOperationalErrors(),
  ]);
  const healthStatus = getHealthStatus(monitoring.databaseSizeBytes);

  return {
    databaseSizeBytes: monitoring.databaseSizeBytes,
    healthStatus,
    technicalRecommendation: getTechnicalRecommendation(healthStatus),
    heaviestTables: monitoring.heaviestTables,
    retentionDays,
    metrics: [
      { key: "orders", label: "Pedidos", value: orders, helper: "Lectura paginada en admin y reportes." },
      { key: "invoices", label: "Facturas", value: invoices, helper: "PDF generado bajo demanda; no se duplican archivos." },
      { key: "products", label: "Productos", value: products, helper: "Imagenes fuera de Postgres." },
      { key: "customers", label: "Clientes", value: customers, helper: "CRM paginado por clientes y seguimientos." },
      { key: "logs", label: "Logs operativos", value: auditLogs + errorLogs + notificationLogs, helper: "Audit, error y notificaciones." },
    ],
    logs: [
      { table: "audit_logs", label: "Audit logs", total: auditLogs, olderThan90Days: oldAuditLogs },
      { table: "error_logs", label: "Error logs", total: errorLogs, olderThan90Days: oldErrorLogs },
      { table: "notification_logs", label: "Notification logs", total: notificationLogs, olderThan90Days: oldNotificationLogs },
    ],
    storageReferences: [
      {
        label: "Imagenes de productos",
        value: productImages,
        helper: "Registros con URL/public_id de Cloudinary o Storage.",
      },
      {
        label: "Comprobantes de transferencia",
        value: transferReceipts,
        helper: "Metadatos privados de Cloudinary; acceso por ruta admin firmada.",
      },
      {
        label: "PDFs de factura guardados",
        value: 0,
        helper: "Se generan bajo demanda desde los datos fiscales.",
      },
    ],
    criticalTables: [
      "orders",
      "order_items",
      "payments",
      "customers",
      "users",
      "products",
      "inventory_movements",
      "inventory_reservations",
      "invoices",
      "invoice_items",
      "fiscal_settings",
      "wholesale_codes",
      "crm_notes",
      "crm_followups",
      "audit_logs",
      "company_settings",
      "product_images",
    ],
    expiredReservationCount,
    reservedOrderCount,
    latestBackupCheck,
    cronSecretConfigured: Boolean(process.env.CRON_SECRET),
    latestCronRuns,
    recentErrors,
    rateLimitRows,
    notificationStatus: {
      provider: emailProvider.provider,
      configured: emailProvider.configured,
      resendConfigured: emailProvider.resendConfigured,
      brevoConfigured: emailProvider.brevoConfigured,
      ...notificationCounts,
    },
    backupChecklist: [
      {
        area: "Supabase database",
        status: "manual",
        cadence: "Diario, semanal y mensual",
        recommendation:
          "Activar backups automáticos del plan Pro o ejecutar respaldo programado externo con prueba de restauracion mensual.",
      },
      {
        area: "Migraciones Supabase",
        status: "configured",
        cadence: "Cada cambio",
        recommendation: "Mantener supabase/migrations y supabase/schema.sql versionados antes de cualquier deploy.",
      },
      {
        area: "Cloudinary productos",
        status: "manual",
        cadence: "Semanal",
        recommendation: "Exportar listado de public_id, URL y carpeta; habilitar backup/versionado en Cloudinary si el plan lo permite.",
      },
      {
        area: "Comprobantes de pago",
        status: "pending",
        cadence: "Diario",
        recommendation: "Usar carpeta privada o signed URLs y respaldo separado de comprobantes por fecha/pedido.",
      },
      {
        area: "Variables Vercel",
        status: "manual",
        cadence: "Mensual y antes de rotar claves",
        recommendation: "Guardar inventario cifrado de nombres de variables, responsable y fecha de rotacion; nunca guardar valores en Git.",
      },
      {
        area: "Restauracion de emergencia",
        status: "pending",
        cadence: "Trimestral",
        recommendation: "Probar restauracion en proyecto Supabase/Vercel separado antes de depender del plan en produccion.",
      },
    ],
  };
}

export async function recordBackupReview() {
  const supabase = await getSupabaseServerClient();
  const { data, error } = await supabase
    .rpc("record_operational_backup_check", {
      plan_name: process.env.SUPABASE_PLAN_NAME ?? "free_or_unverified",
      check_status: "manual_review",
      database_backup_checked: false,
      cloudinary_manifest_checked: false,
      vercel_env_checked: false,
      restore_drill_checked: false,
      notes: "Revisión registrada desde /admin/uso. Completar evidencia externa según docs/BACKUPS.md.",
    });

  if (error) {
    throw new Error(error.message);
  }

  return String(data ?? "");
}

export async function cleanupOldOperationalLogs(retentionDays = 90) {
  const admin = getSupabaseAdminClient();
  const safeRetentionDays = Math.max(30, Math.floor(retentionDays));
  const { data, error } = await admin
    .rpc("cleanup_old_operational_logs", { retention_days: safeRetentionDays })
    .returns<CleanupRow[]>();

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}
