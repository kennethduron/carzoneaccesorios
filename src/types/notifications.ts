export type NotificationSettings = {
  notification_emails: string;
  notify_new_orders: boolean;
  notify_payment_confirmed: boolean;
  notify_general_contact: boolean;
  notify_wholesale_requests: boolean;
  notify_transfer_receipt_uploaded: boolean;
  notify_customer_account_created: boolean;
  notify_low_stock: boolean;
  send_daily_activity_summary: boolean;
  send_weekly_sales_summary: boolean;
};

export type NotificationLogStatus = "sent" | "failed" | "skipped";

export type NotificationModule = "pedidos" | "pagos" | "reservas" | "CRM" | "inventario" | "mayoristas" | "sistema";

export type NotificationSeverity = "info" | "warning" | "error" | "critical";

export type InternalNotificationReadState = "unread" | "read" | "archived";

export type EmailQueueStatus = "pending" | "sent" | "failed" | "retrying" | "cancelled";

export type NotificationPreference = {
  id: string;
  notification_type: string;
  module: NotificationModule;
  label: string;
  internal_enabled: boolean;
  email_enabled: boolean;
  push_enabled: boolean;
  destination_roles: string[];
  technical_only: boolean;
  frequency: "immediate" | "hourly" | "daily" | "weekly" | "manual";
  reminder_window_hours: number;
  email_required: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type NotificationUserPreference = {
  id: string;
  user_id: string;
  notification_type: string;
  internal_enabled: boolean | null;
  email_enabled: boolean | null;
  push_enabled: boolean | null;
  frequency: "immediate" | "hourly" | "daily" | "weekly" | "manual";
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type NotificationPreferenceUpdate = Pick<
  NotificationPreference,
  "id" | "internal_enabled" | "email_enabled" | "push_enabled" | "destination_roles" | "frequency"
>;

export type NotificationUserPreferenceUpdate = {
  notification_type: string;
  internal_enabled: boolean;
  email_enabled: boolean;
  push_enabled: boolean;
  frequency: NotificationPreference["frequency"];
};

export type EmailQueueItem = {
  id: string;
  to_email: string;
  to_name: string | null;
  subject: string;
  template_key: string;
  payload: Record<string, unknown>;
  status: EmailQueueStatus;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  scheduled_at: string;
  sent_at: string | null;
  created_at: string;
  related_module: NotificationModule | null;
  related_id: string | null;
  priority: number;
  idempotency_key: string | null;
};
