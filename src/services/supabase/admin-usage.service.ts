import { getSupabaseAdminClient } from "@/lib/supabase";

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

export type AdminUsageOverview = {
  databaseSizeBytes: number;
  healthStatus: UsageHealthStatus;
  technicalRecommendation: string;
  heaviestTables: TableUsageMetric[];
  metrics: UsageMetric[];
  logs: LogRetentionMetric[];
  storageReferences: StorageReferenceMetric[];
  retentionDays: number;
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
  | "payments";

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
    .not("transfer_receipt_url", "is", null);

  if (error) {
    throw new Error(error.message);
  }

  return count ?? 0;
}

function daysAgo(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

export async function getAdminUsageOverview(): Promise<AdminUsageOverview> {
  const retentionDays = 90;
  const cutoff = daysAgo(retentionDays);

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
        helper: "Solo URL del comprobante guardada en Supabase.",
      },
      {
        label: "PDFs de factura guardados",
        value: 0,
        helper: "Se generan bajo demanda desde los datos fiscales.",
      },
    ],
  };
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
